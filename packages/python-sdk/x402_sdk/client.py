from __future__ import annotations

import json
import time
from typing import Any, Dict, Iterator, Optional

import httpx

from .types import PaymentAsset, PaymentRequired, PaymentQuote, SignTransaction, StellarNetwork
from .wallet import (
    build_payment_transaction,
    build_unsigned_payment_transaction,
    horizon_url,
    submit_transaction,
)


class X402Error(Exception):
    pass


class X402Client:
    def __init__(
        self,
        *,
        gateway_url: str,
        secret_key: Optional[str] = None,
        public_key: Optional[str] = None,
        sign_transaction: Optional[SignTransaction] = None,
        network: StellarNetwork = "testnet",
        default_asset: PaymentAsset = "USDC",
        payment_timeout: float = 300.0,
        http_client: Optional[httpx.Client] = None,
        horizon_base_url: Optional[str] = None,
    ) -> None:
        self.gateway_url = gateway_url.rstrip("/")
        self.secret_key = secret_key
        self.public_key = public_key
        self.sign_transaction = sign_transaction
        self.network = network
        self.default_asset = default_asset
        self.payment_timeout = payment_timeout
        self.http = http_client or httpx.Client(timeout=60)
        self.horizon_base_url = horizon_base_url

    def call(
        self,
        request: Dict[str, Any],
        *,
        path: str = "/v1/chat/completions",
        asset: Optional[PaymentAsset] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        response = self._post(path, request, headers=headers)
        if response.status_code == 402:
            required = PaymentRequired.from_dict(response.json())
            return self._handle_402(required, request, path, asset=asset, headers=headers, stream=False)
        if response.is_success:
            return {"success": True, "response": response.json(), "cost": {"amount": "0", "asset": "USDC"}}
        return {"success": False, "error": f"Gateway error: {response.status_code} {response.text}"}

    def call_stream(
        self,
        request: Dict[str, Any],
        *,
        path: str = "/v1/chat/completions",
        asset: Optional[PaymentAsset] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Iterator[Dict[str, Any]]:
        streaming_request = {**request, "stream": True}
        response = self._post(path, streaming_request, headers=headers)
        if response.status_code == 402:
            required = PaymentRequired.from_dict(response.json())
            result = self._handle_402(
                required,
                streaming_request,
                path,
                asset=asset,
                headers=headers,
                stream=True,
            )
            if not result["success"]:
                raise X402Error(result["error"])
            yield from result["stream"]
            return
        if not response.is_success:
            raise X402Error(f"Gateway error: {response.status_code} {response.text}")
        yield from self._iter_sse(response)

    def check_payment_status(self, quote_id: str) -> Optional[Dict[str, Any]]:
        response = self.http.get(f"{self.gateway_url}/api/v1/payments/{quote_id}/status")
        if not response.is_success:
            return None
        return response.json()

    def _post(
        self,
        path: str,
        payload: Dict[str, Any],
        *,
        headers: Optional[Dict[str, str]] = None,
    ) -> httpx.Response:
        return self.http.post(
            f"{self.gateway_url}{path}",
            json=payload,
            headers={"Content-Type": "application/json", **(headers or {})},
        )

    def _handle_402(
        self,
        required: PaymentRequired,
        request: Dict[str, Any],
        path: str,
        *,
        asset: Optional[PaymentAsset],
        headers: Optional[Dict[str, str]],
        stream: bool,
    ) -> Dict[str, Any]:
        quote = required.quote
        if time.time() > quote.expires_at:
            return {"success": False, "error": "Quote expired before payment could be made"}

        required_asset = asset or self.default_asset
        if required_asset != quote.asset:
            return {
                "success": False,
                "error": f"Wrong asset: gateway requires {quote.asset}, you're paying with {required_asset}",
            }

        payment = self._execute_payment(quote)
        retry_headers = {"X-Payment-Hash": payment, **(headers or {})}
        retry = self._post(path, request, headers=retry_headers)
        if not retry.is_success:
            return {"success": False, "error": f"Gateway error after payment: {retry.status_code} {retry.text}"}

        receipt = self._parse_receipt(retry.headers.get("X-Payment-Receipt"))
        if stream:
            return {"success": True, "stream": self._iter_sse(retry), "receipt": receipt}

        return {
            "success": True,
            "response": retry.json(),
            "receipt": receipt,
            "cost": {"amount": receipt["amount"], "asset": receipt["asset"]} if receipt else None,
        }

    def _execute_payment(self, quote: PaymentQuote) -> str:
        if self.sign_transaction:
            if not self.public_key:
                raise X402Error("public_key is required when using sign_transaction")
            unsigned_xdr, tx_hash = build_unsigned_payment_transaction(
                source_public_key=self.public_key,
                quote=quote,
                custom_horizon_url=self.horizon_base_url,
            )
            signed_xdr = self.sign_transaction(unsigned_xdr)
        else:
            if not self.secret_key:
                raise X402Error(
                    f"Payment required. Send {quote.amount} {quote.asset} to {quote.payment_address}."
                )
            signed_xdr, tx_hash = build_payment_transaction(
                source_secret=self.secret_key,
                quote=quote,
                custom_horizon_url=self.horizon_base_url,
            )

        submit_transaction(signed_xdr, quote.network, self.horizon_base_url)
        if not self._wait_for_confirmation(tx_hash, quote):
            raise X402Error("Payment not confirmed within timeout")
        return tx_hash

    def _wait_for_confirmation(self, tx_hash: str, quote: PaymentQuote) -> bool:
        deadline = time.time() + self.payment_timeout
        base_url = self.horizon_base_url or horizon_url(quote.network)
        while time.time() < deadline:
            try:
                response = self.http.get(f"{base_url}/transactions/{tx_hash}")
                if response.is_success and response.json().get("successful"):
                    return True
            except httpx.HTTPError:
                pass
            time.sleep(2)
        return False

    @staticmethod
    def _parse_receipt(header: Optional[str]) -> Optional[Dict[str, Any]]:
        if not header:
            return None
        try:
            return json.loads(header)
        except json.JSONDecodeError:
            return None

    @staticmethod
    def _iter_sse(response: httpx.Response) -> Iterator[Dict[str, Any]]:
        for line in response.iter_lines():
            if not line:
                continue
            if isinstance(line, bytes):
                line = line.decode("utf-8")
            line = line.strip()
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                return
            try:
                parsed = json.loads(data)
            except json.JSONDecodeError:
                continue
            if "x402_receipt" in parsed:
                continue
            yield parsed

