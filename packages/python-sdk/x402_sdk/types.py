from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Literal, Optional

PaymentAsset = Literal["USDC", "XLM"]
StellarNetwork = Literal["testnet", "mainnet", "futurenet"]


@dataclass(frozen=True)
class PaymentQuote:
    id: str
    route: str
    pricing_model: str
    amount: str
    asset: PaymentAsset
    payment_address: str
    expires_at: int
    network: StellarNetwork
    asset_issuer: Optional[str] = None
    memo: Optional[str] = None
    status_url: Optional[str] = None
    estimated_max_tokens: Optional[int] = None
    per_token_price: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PaymentQuote":
        return cls(
            id=data.get("id", ""),
            route=data.get("route", ""),
            pricing_model=data.get("pricingModel", data.get("pricing_model", "flat")),
            amount=str(data["amount"]),
            asset=data["asset"],
            asset_issuer=data.get("assetIssuer") or data.get("asset_issuer"),
            payment_address=data.get("paymentAddress") or data.get("payment_address"),
            memo=data.get("memo"),
            network=data.get("network", "testnet"),
            expires_at=int(data["expiresAt"] if "expiresAt" in data else data["expires_at"]),
            status_url=data.get("statusUrl") or data.get("status_url"),
            estimated_max_tokens=data.get("estimatedMaxTokens") or data.get("estimated_max_tokens"),
            per_token_price=data.get("perTokenPrice") or data.get("per_token_price"),
        )


@dataclass(frozen=True)
class PaymentRequired:
    quote: PaymentQuote
    message: str = "Payment Required"
    instructions: str = ""
    docs: str = ""

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PaymentRequired":
        return cls(
            quote=PaymentQuote.from_dict(data["quote"]),
            message=data.get("message", "Payment Required"),
            instructions=data.get("instructions", ""),
            docs=data.get("docs", ""),
        )


SignTransaction = Callable[[str], str]

