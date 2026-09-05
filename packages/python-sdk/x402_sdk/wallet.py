from __future__ import annotations

from decimal import Decimal
from typing import Optional, Tuple

from stellar_sdk import Asset, Keypair, Memo, Network, Server, TransactionBuilder

from .types import PaymentAsset, PaymentQuote, StellarNetwork


def horizon_url(network: StellarNetwork) -> str:
    if network == "mainnet":
        return "https://horizon.stellar.org"
    if network == "futurenet":
        return "https://horizon-futurenet.stellar.org"
    return "https://horizon-testnet.stellar.org"


def network_passphrase(network: StellarNetwork) -> str:
    if network == "mainnet":
        return Network.PUBLIC_NETWORK_PASSPHRASE
    if network == "futurenet":
        return Network.FUTURENET_NETWORK_PASSPHRASE
    return Network.TESTNET_NETWORK_PASSPHRASE


def stroops_to_units(amount: str) -> str:
    value = Decimal(amount) / Decimal("10000000")
    return format(value.normalize(), "f")


def _asset(asset: PaymentAsset, issuer: Optional[str]) -> Asset:
    if asset == "XLM":
        return Asset.native()
    if asset == "USDC" and issuer:
        return Asset("USDC", issuer)
    raise ValueError(f"Unsupported asset or missing issuer: {asset}")


def build_unsigned_payment_transaction(
    *,
    source_public_key: str,
    quote: PaymentQuote,
    custom_horizon_url: Optional[str] = None,
) -> Tuple[str, str]:
    server = Server(horizon_url=custom_horizon_url or horizon_url(quote.network))
    source = server.load_account(source_public_key)
    tx_builder = (
        TransactionBuilder(
            source_account=source,
            network_passphrase=network_passphrase(quote.network),
            base_fee=100,
        )
        .append_payment_op(
            destination=quote.payment_address,
            amount=stroops_to_units(quote.amount),
            asset=_asset(quote.asset, quote.asset_issuer),
        )
        .set_timeout(300)
    )

    if quote.memo:
        tx_builder.add_text_memo(quote.memo)

    tx = tx_builder.build()
    return tx.to_xdr(), tx.hash_hex()


def build_payment_transaction(
    *,
    source_secret: str,
    quote: PaymentQuote,
    custom_horizon_url: Optional[str] = None,
) -> Tuple[str, str]:
    keypair = Keypair.from_secret(source_secret)
    tx_xdr, _ = build_unsigned_payment_transaction(
        source_public_key=keypair.public_key,
        quote=quote,
        custom_horizon_url=custom_horizon_url,
    )
    from stellar_sdk import TransactionEnvelope

    envelope = TransactionEnvelope.from_xdr(
        tx_xdr,
        network_passphrase=network_passphrase(quote.network),
    )
    envelope.sign(keypair)
    return envelope.to_xdr(), envelope.hash_hex()


def submit_transaction(tx_xdr: str, network: StellarNetwork, custom_horizon_url: Optional[str] = None):
    server = Server(horizon_url=custom_horizon_url or horizon_url(network))
    return server.submit_transaction(tx_xdr)

