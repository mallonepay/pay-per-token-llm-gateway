import httpx

from x402_sdk import X402Client
import x402_sdk.client as client_module


def quote(asset="USDC", expires_at=4_102_444_800):
    return {
        "id": "q1",
        "route": "/v1/chat/completions",
        "pricingModel": "flat",
        "amount": "10000000",
        "asset": asset,
        "assetIssuer": "GA..." if asset == "USDC" else None,
        "paymentAddress": "GB...",
        "network": "testnet",
        "expiresAt": expires_at,
    }


def test_call_returns_200_without_payment():
    def handler(request):
        return httpx.Response(200, json={"id": "chatcmpl-1", "choices": [{"message": {"content": "hi"}}]})

    client = X402Client(gateway_url="https://gateway.test", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    result = client.call({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})

    assert result["success"] is True
    assert result["response"]["id"] == "chatcmpl-1"


def test_expired_quote_returns_error():
    def handler(request):
        return httpx.Response(
            402,
            json={"quote": quote(expires_at=1)},
        )

    client = X402Client(gateway_url="https://gateway.test", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    result = client.call({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})

    assert result["success"] is False
    assert "expired" in result["error"]


def test_wrong_asset_returns_error():
    def handler(request):
        return httpx.Response(
            402,
            json={"quote": quote(asset="XLM")},
        )

    client = X402Client(
        gateway_url="https://gateway.test",
        default_asset="USDC",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    result = client.call({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})

    assert result["success"] is False
    assert "Wrong asset" in result["error"]


def test_402_payment_flow_retries_with_hash_and_receipt(monkeypatch):
    calls = []

    def fake_build_payment_transaction(**kwargs):
        assert kwargs["quote"].id == "q1"
        return "SIGNED_XDR", "tx123"

    def fake_submit_transaction(tx_xdr, network, custom_horizon_url=None):
        assert tx_xdr == "SIGNED_XDR"
        assert network == "testnet"

    monkeypatch.setattr(client_module, "build_payment_transaction", fake_build_payment_transaction)
    monkeypatch.setattr(client_module, "submit_transaction", fake_submit_transaction)

    def handler(request):
        calls.append(request)
        if str(request.url).endswith("/transactions/tx123"):
            return httpx.Response(200, json={"successful": True})
        if len([c for c in calls if str(c.url).endswith("/v1/chat/completions")]) == 1:
            return httpx.Response(402, json={"quote": quote()})
        return httpx.Response(
            200,
            json={"id": "chatcmpl-paid", "choices": [{"message": {"content": "paid"}}]},
            headers={
                "X-Payment-Receipt": '{"amount":"10000000","asset":"USDC","txHash":"tx123"}',
            },
        )

    client = X402Client(
        gateway_url="https://gateway.test",
        secret_key="S...",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        horizon_base_url="https://horizon.test",
        payment_timeout=1,
    )
    result = client.call({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})

    assert result["success"] is True
    assert result["response"]["id"] == "chatcmpl-paid"
    assert result["receipt"]["txHash"] == "tx123"
    retry = [c for c in calls if c.headers.get("x-payment-hash") == "tx123"]
    assert retry


def test_payment_required_without_secret_raises_useful_error():
    def handler(request):
        return httpx.Response(402, json={"quote": quote()})

    client = X402Client(
        gateway_url="https://gateway.test",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    try:
        client.call({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})
    except Exception as exc:
        assert "Payment required" in str(exc)
    else:
        raise AssertionError("expected payment error")
