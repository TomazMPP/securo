"""Shared plumbing for read-only crypto exchange connectors.

An exchange is not a bank: there are no statements and no cash accounts to
reconcile, only wallets holding coin quantities. Those map onto Securo's
Asset/AssetValue model, so an exchange connector implements the holdings half
of :class:`BankProvider` and returns **no** accounts — a wrapper account would
either double-count the positions or sit permanently at zero (cf. issue #343).

Binance, Coinbase and Kraken differ only in how a request is signed and what
shape the balance payload takes. Everything after that — resolving a symbol,
pricing it, building the holding — is identical, so subclasses implement
:meth:`CryptoExchangeProvider.fetch_balances` and inherit the rest.

Pricing note: quotes come from Binance's public ticker endpoint, which needs
no credentials and covers far more symbols than any single exchange's own
list. It is used purely as a price oracle — a Kraken or Coinbase connection
never authenticates against Binance, and a user of those exchanges needs no
Binance account.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Callable, Optional

import httpx

from app.providers.base import (
    AccountData,
    BankProvider,
    HoldingData,
    TransactionData,
)

logger = logging.getLogger(__name__)

PRICE_ORACLE_URL = "https://api.binance.com/api/v3/ticker/price"
HTTP_TIMEOUT = 30.0

# Everything is valued against this quote asset, treated as 1 USD by model
# definition. Stablecoin de-pegs are not modelled.
QUOTE_STABLE = "USDT"

# Fiat currencies an exchange may hold as cash. Valued at par in their own
# currency rather than routed through the crypto price table.
FIAT_CODES = frozenset({
    "USD", "EUR", "GBP", "BRL", "ARS", "AUD", "CAD", "CHF", "JPY", "MXN",
    "COP", "CLP", "PEN", "TRY", "ZAR", "NGN", "UAH", "PLN", "RON", "CZK",
})

# Stablecoins pegged to USD. Priced at 1 rather than looked up: several have
# no USDT pair on the oracle, and a missing quote would show them unpriced.
USD_STABLES = frozenset({"USDT", "USDC", "BUSD", "TUSD", "USDP", "DAI", "FDUSD", "PYUSD"})


def to_decimal(value) -> Decimal:
    """Parse an exchange decimal string; unusable input becomes 0.

    Exchanges send quantities and prices as strings precisely so they survive
    without float rounding, so they go straight to Decimal.
    """
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


@dataclass
class WalletBalance:
    """One coin balance, already summed across an exchange's sub-buckets."""

    wallet: str          # SPOT | FUNDING | EARN | STAKING …
    asset: str           # raw symbol as the exchange reports it
    quantity: Decimal


@dataclass
class ResolvedAsset:
    symbol: str                  # canonical symbol (BTC, ETH, USD …)
    pair: Optional[str]          # oracle pair used for pricing, if any
    kind: str                    # CRYPTO | STABLE_USD | FIAT
    wallet_override: Optional[str] = None


async def fetch_price_table() -> dict[str, Decimal]:
    """Whole ticker table in one call.

    Deliberately unfiltered: real wallets hold assets with no pair of their
    own (staking wrappers, fiat), and the batched ``symbols=[...]`` variant
    fails the *entire* request with ``-1121 Invalid symbol`` at the first
    unknown one.
    """
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(PRICE_ORACLE_URL)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"price oracle failed: {resp.status_code} {resp.text[:200]}"
            )
        rows = resp.json()
    return {
        r["symbol"]: to_decimal(r.get("price"))
        for r in rows
        if isinstance(r, dict) and r.get("symbol")
    }


def resolve_asset(asset: str, has_pair: Callable[[str], bool]) -> ResolvedAsset:
    """Map a raw wallet symbol onto a canonical, priceable asset.

    Subclasses normalize exchange-specific spellings before calling this.
    """
    sym = asset.upper()
    if sym in FIAT_CODES:
        return ResolvedAsset(sym, None, "FIAT")
    if sym in USD_STABLES:
        return ResolvedAsset(sym, None, "STABLE_USD")
    pair = f"{sym}{QUOTE_STABLE}"
    if has_pair(pair):
        return ResolvedAsset(sym, pair, "CRYPTO")
    # No known pair: keep the symbol and let it surface unpriced rather than
    # inventing a value for it.
    return ResolvedAsset(sym, None, "CRYPTO")


class CryptoExchangeProvider(BankProvider):
    """Read-only exchange connector: balances in, holdings out."""

    #: Label used in holding names for the exchange's default wallet.
    default_wallet = "SPOT"

    @property
    def flow_type(self) -> str:
        return "token"

    # ----- subclass contract -------------------------------------------------

    async def fetch_balances(self, credentials: dict) -> list[WalletBalance]:
        """Return non-zero balances for the account."""
        raise NotImplementedError

    def resolve(self, asset: str, has_pair: Callable[[str], bool]) -> ResolvedAsset:
        """Hook for exchange-specific symbol quirks. Default: generic rules."""
        return resolve_asset(asset, has_pair)

    # ----- BankProvider surface ---------------------------------------------

    def get_oauth_url(self, *args, **kwargs):  # type: ignore[override]
        raise NotImplementedError(f"{self.name} uses an API key paste flow, not OAuth")

    async def get_accounts(self, credentials: dict) -> list[AccountData]:
        """None by design — see the module docstring."""
        return []

    async def get_transactions(
        self, credentials: dict, account_external_id: str,
        since=None, payee_source: str = "auto",
    ) -> list[TransactionData]:
        """Out of scope: there are no accounts for transactions to attach to."""
        return []

    async def get_holdings(self, credentials: dict) -> list[HoldingData]:
        balances = await self.fetch_balances(credentials)
        if not balances:
            return []

        prices = await fetch_price_table()

        def has_pair(pair: str) -> bool:
            return pair in prices

        holdings: list[HoldingData] = []
        for bal in balances:
            if bal.quantity <= 0 or not bal.asset:
                continue
            resolved = self.resolve(bal.asset, has_pair)
            wallet = resolved.wallet_override or bal.wallet

            if resolved.kind == "FIAT":
                currency, unit_price = resolved.symbol, Decimal("1")
            elif resolved.kind == "STABLE_USD":
                currency, unit_price = "USD", Decimal("1")
            else:
                currency = "USD"
                unit_price = (prices.get(resolved.pair) if resolved.pair else None) or Decimal("0")

            priced = unit_price > 0
            if not priced:
                logger.info(
                    "%s: no %s pair for %s; reporting unpriced",
                    self.name, QUOTE_STABLE, bal.asset,
                )

            name = resolved.symbol
            if wallet != self.default_wallet:
                name = f"{resolved.symbol} ({wallet.title()})"

            holdings.append(
                HoldingData(
                    external_id=f"{wallet}:{resolved.symbol}",
                    name=name,
                    # Always a real ISO code. The coin symbol goes in `ticker`
                    # — a crypto ticker in the currency column overflows it and
                    # breaks the sync (cf. issues #448/#450).
                    currency=currency,
                    ticker=resolved.symbol,
                    current_value=(bal.quantity * unit_price) if priced else Decimal("0"),
                    quantity=bal.quantity,
                    unit_price=unit_price if priced else None,
                    metadata={
                        "exchange": self.name,
                        "wallet": wallet,
                        "raw_asset": bal.asset,
                        "kind": resolved.kind,
                        "pair": resolved.pair,
                        "priced": priced,
                    },
                )
            )
        return holdings
