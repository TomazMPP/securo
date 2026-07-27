"""Binance provider — read-only crypto balances as investment holdings.

Binance is not a bank: there are no statements and no cash accounts to
reconcile. What it has is wallets holding coin quantities, which map cleanly
onto Securo's Asset/AssetValue model. So this connector implements the
holdings half of :class:`BankProvider` and deliberately returns **no**
accounts — every coin becomes one Asset, and net worth picks it up from
there.

That is a deliberate deviation from the usual "wrapper account with a zero
balance" pattern used by exchange integrations elsewhere. Securo already
keeps Assets separate from Accounts, so a wrapper account would either
double-count the positions or sit permanently at zero as dead weight
(cf. issue #343, where an account balance and its underlying holdings were
both counted). Returning no accounts makes the double-count structurally
impossible rather than merely avoided.

Scope: balances and pricing only. Trade history, deposits/withdrawals and
average-cost/P&L are intentionally out of scope for this pass — they need
pagination past Binance's 90-day window to be worth anything, and cost basis
that is silently wrong is worse than absent.

Credentials are a read-only API key + secret, supplied via the token-paste
flow and stored encrypted on the connection. The client never places orders
or initiates withdrawals; only GET endpoints plus the one POST that Binance
requires for reading the funding wallet are ever called.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from decimal import Decimal, InvalidOperation
from typing import Any, Callable, Optional
from urllib.parse import urlencode

import httpx

from app.agents.services.crypto import decrypt, encrypt
from app.providers.base import (
    AccountData,
    BankProvider,
    ConnectionData,
    HoldingData,
    SessionExpiredError,
    TransactionData,
)

logger = logging.getLogger(__name__)

BINANCE_API = "https://api.binance.com"
BINANCE_HTTP_TIMEOUT = 30.0

# Every non-fiat balance is valued against this quote asset. USDT is treated
# as 1 USD by model definition; de-pegs are not modelled.
QUOTE_STABLE = "USDT"

# Binance rejects signed requests whose timestamp drifts outside recvWindow.
# 10s of tolerance on top of a periodically re-learned clock offset.
RECV_WINDOW_MS = 10_000
CLOCK_OFFSET_TTL_SECONDS = 30 * 60

# Provider instances are constructed per call by get_provider(), so the
# learned server/host skew is cached at module level to survive across them.
_clock_offset_ms: int = 0
_clock_offset_at: float = 0.0


def _to_decimal(value: Any) -> Decimal:
    """Parse a Binance decimal string, returning 0 for anything unusable.

    Binance sends quantities and prices as strings precisely so they survive
    without float rounding; they go straight to Decimal and never through
    float.
    """
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


class ResolvedAsset:
    """Outcome of mapping a raw wallet symbol to a canonical asset."""

    __slots__ = ("symbol", "pair", "kind", "earn_wrapped")

    def __init__(self, symbol: str, pair: Optional[str], kind: str, earn_wrapped: bool):
        self.symbol = symbol
        self.pair = pair
        self.kind = kind  # CRYPTO | STABLE_USD | FIAT_BRL
        self.earn_wrapped = earn_wrapped


def resolve_balance_asset(asset: str, has_pair: Callable[[str], bool]) -> ResolvedAsset:
    """Map a raw Binance wallet symbol onto a canonical asset.

    Flexible Earn balances are reported *inside* the spot wallet under
    synthetic ``LD``-prefixed symbols (``LDBTC`` = BTC in Flexible Earn). The
    trap is that ``LD`` also begins legitimate tickers — ``LDO`` is Lido. The
    price table is used as the oracle to tell them apart: a symbol is only
    treated as an Earn wrapper when it has **no pair of its own** and the
    remainder after stripping ``LD`` **does** have one. ``LDO`` has
    ``LDOUSDT``, so it is never unwrapped; ``LDBTC`` has no ``LDBTCUSDT`` but
    ``BTCUSDT`` exists, so it resolves to BTC.
    """
    if asset == "BRL":
        return ResolvedAsset("BRL", None, "FIAT_BRL", False)
    if asset == QUOTE_STABLE:
        return ResolvedAsset(asset, None, "STABLE_USD", False)

    direct = f"{asset}{QUOTE_STABLE}"
    if has_pair(direct):
        return ResolvedAsset(asset, direct, "CRYPTO", False)

    if asset.startswith("LD") and len(asset) > 2:
        underlying = asset[2:]
        if underlying == QUOTE_STABLE:
            return ResolvedAsset(underlying, None, "STABLE_USD", True)
        underlying_pair = f"{underlying}{QUOTE_STABLE}"
        if has_pair(underlying_pair):
            return ResolvedAsset(underlying, underlying_pair, "CRYPTO", True)

    # No known pair: keep the symbol and let it surface unpriced rather than
    # inventing a value for it.
    return ResolvedAsset(asset, None, "CRYPTO", False)


class BinanceProvider(BankProvider):
    """Read-only Binance connector (spot + funding balances)."""

    @property
    def name(self) -> str:
        return "binance"

    @property
    def flow_type(self) -> str:
        return "token"

    # ----- credentials ------------------------------------------------------

    @staticmethod
    def _creds(credentials: dict) -> tuple[str, str]:
        """Return (api_key, api_secret), preferring the encrypted secret."""
        creds = credentials or {}
        api_key = creds.get("api_key") or ""
        secret = ""
        enc = creds.get("api_secret_enc")
        if enc:
            secret = decrypt(enc) or ""
        if not secret:
            # Backward compat / dev: also accept plaintext.
            secret = creds.get("api_secret") or ""
        if not api_key or not secret:
            raise SessionExpiredError("Binance API credentials missing")
        return api_key, secret

    # ----- HTTP -------------------------------------------------------------

    def _client(self, api_key: Optional[str] = None) -> httpx.AsyncClient:
        headers = {
            "Accept": "application/json",
            "User-Agent": "Securo/0.1 (+https://usesecuro.com)",
        }
        if api_key:
            headers["X-MBX-APIKEY"] = api_key
        return httpx.AsyncClient(timeout=BINANCE_HTTP_TIMEOUT, headers=headers)

    async def _clock_offset(self) -> int:
        """Server/host skew in ms, re-learned every 30 minutes.

        Signed requests are rejected when their timestamp falls outside
        recvWindow, and self-hosted boxes drift. One cheap public call keeps
        every subsequent signature valid.
        """
        global _clock_offset_ms, _clock_offset_at
        if time.time() - _clock_offset_at < CLOCK_OFFSET_TTL_SECONDS:
            return _clock_offset_ms
        try:
            async with self._client() as client:
                resp = await client.get(f"{BINANCE_API}/api/v3/time")
                resp.raise_for_status()
                server_time = int(resp.json()["serverTime"])
            _clock_offset_ms = server_time - int(time.time() * 1000)
            _clock_offset_at = time.time()
        except Exception:  # noqa: BLE001
            # A failed offset read is not fatal: fall back to the last known
            # value (0 on a cold start), which works on a well-synced host.
            logger.warning("Binance: could not read server time; using cached offset")
        return _clock_offset_ms

    async def _public_request(self, path: str) -> Any:
        async with self._client() as client:
            resp = await client.get(f"{BINANCE_API}{path}")
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"Binance {path} failed: {resp.status_code} {resp.text[:200]}"
                )
            return resp.json()

    async def _signed_request(
        self,
        credentials: dict,
        path: str,
        params: Optional[dict] = None,
        method: str = "GET",
    ) -> Any:
        """Issue a signed request.

        The signature is HMAC-SHA256 over the exact query string that is sent,
        timestamp included, so ``signature`` must be appended last — anything
        added after signing invalidates it.
        """
        api_key, api_secret = self._creds(credentials)
        offset = await self._clock_offset()

        query_params = dict(params or {})
        query_params["recvWindow"] = RECV_WINDOW_MS
        query_params["timestamp"] = int(time.time() * 1000) + offset
        query = urlencode(query_params)
        signature = hmac.new(
            api_secret.encode("utf-8"), query.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        url = f"{BINANCE_API}{path}?{query}&signature={signature}"

        async with self._client(api_key) as client:
            resp = await client.request(method, url)
            if resp.status_code in (401, 403):
                raise SessionExpiredError(
                    f"Binance rejected the API key ({resp.status_code}). "
                    "Check that it is valid and, if IP-restricted, that this "
                    "host's address is allowed."
                )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"Binance {path} failed: {resp.status_code} {resp.text[:200]}"
                )
            return resp.json()

    # ----- connection lifecycle ---------------------------------------------

    def get_oauth_url(self, *args, **kwargs):  # type: ignore[override]
        raise NotImplementedError("Binance uses an API key/secret paste flow, not OAuth")

    async def handle_oauth_callback(self, code: str) -> ConnectionData:
        """Validate a pasted API key/secret and open a connection.

        ``code`` is a JSON object ``{"api_key": ..., "api_secret": ...}``; a
        plain ``key:secret`` string is also accepted for CLI convenience. The
        credentials are verified with one signed call before anything is
        persisted, so a bad key fails immediately instead of at first sync.
        """
        api_key = api_secret = ""
        raw = (code or "").strip()
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                api_key = str(parsed.get("api_key") or "").strip()
                api_secret = str(parsed.get("api_secret") or "").strip()
        except (ValueError, TypeError):
            if ":" in raw:
                api_key, _, api_secret = (p.strip() for p in raw.partition(":"))

        if not api_key or not api_secret:
            raise ValueError(
                'Binance credentials must be {"api_key": "...", "api_secret": "..."}'
            )

        credentials = {"api_key": api_key, "api_secret_enc": encrypt(api_secret)}
        # Fail fast on bad/insufficient keys rather than storing them.
        await self._signed_request(credentials, "/api/v3/account", {"omitZeroBalances": "true"})

        return ConnectionData(
            external_id=f"binance:{api_key[:8]}",
            institution_name="Binance",
            credentials=credentials,
            accounts=[],
        )

    async def refresh_credentials(self, credentials: dict) -> dict:
        # API keys don't expire; _creds raises if they are missing entirely.
        self._creds(credentials)
        return credentials

    # ----- reads ------------------------------------------------------------

    async def get_accounts(self, credentials: dict) -> list[AccountData]:
        """No accounts by design — see the module docstring."""
        return []

    async def get_transactions(
        self,
        credentials: dict,
        account_external_id: str,
        since=None,
        payee_source: str = "auto",
    ) -> list[TransactionData]:
        """Out of scope for this pass; there are no accounts to attach to."""
        return []

    async def get_holdings(self, credentials: dict) -> list[HoldingData]:
        """Return one holding per (wallet, coin), priced in USD.

        The whole ticker table is fetched in a single unfiltered call rather
        than a batched ``symbols=[...]`` query: real wallets contain assets
        with no pair of their own (Earn wrappers, fiat), and the batched
        variant fails the *entire* request with ``-1121 Invalid symbol`` on
        the first unknown one.
        """
        spot_raw = await self._signed_request(
            credentials, "/api/v3/account", {"omitZeroBalances": "true"}
        )
        spot = spot_raw.get("balances") or []

        # The funding wallet is read via POST — Binance's choice, not ours.
        # It is a read: no funds move. A failure here must not lose the spot
        # balances, which are the bulk of most wallets.
        try:
            funding = await self._signed_request(
                credentials, "/sapi/v1/asset/get-funding-asset", method="POST"
            ) or []
        except Exception:  # noqa: BLE001
            logger.warning("Binance: funding wallet unavailable; reporting spot only")
            funding = []

        tickers = await self._public_request("/api/v3/ticker/price")
        price_by_pair = {
            t["symbol"]: _to_decimal(t.get("price"))
            for t in tickers
            if isinstance(t, dict) and t.get("symbol")
        }

        def has_pair(pair: str) -> bool:
            return pair in price_by_pair

        balances: list[tuple[str, str, Decimal]] = []
        for row in spot:
            qty = _to_decimal(row.get("free")) + _to_decimal(row.get("locked"))
            if qty > 0:
                balances.append(("SPOT", str(row.get("asset") or ""), qty))
        for row in funding:
            qty = (
                _to_decimal(row.get("free"))
                + _to_decimal(row.get("locked"))
                + _to_decimal(row.get("freeze"))
                + _to_decimal(row.get("withdrawing"))
            )
            if qty > 0:
                balances.append(("FUNDING", str(row.get("asset") or ""), qty))

        holdings: list[HoldingData] = []
        for wallet, raw_asset, quantity in balances:
            if not raw_asset:
                continue
            resolved = resolve_balance_asset(raw_asset, has_pair)
            # An Earn-wrapped spot balance belongs to the EARN wallet, so
            # LDBTC and BTC stay distinct positions of the same canonical
            # asset instead of colliding on one key.
            effective_wallet = "EARN" if resolved.earn_wrapped else wallet

            if resolved.kind == "FIAT_BRL":
                currency, unit_price = "BRL", Decimal("1")
            elif resolved.kind == "STABLE_USD":
                currency, unit_price = "USD", Decimal("1")
            else:
                currency = "USD"
                unit_price = (
                    price_by_pair.get(resolved.pair) if resolved.pair else None
                ) or Decimal("0")

            priced = unit_price > 0
            if not priced:
                # Report the quantity but never a fabricated value: an
                # unpriceable coin shows up with zero so it is visibly
                # unvalued rather than silently inflating net worth.
                logger.info(
                    "Binance: no %s pair for %s; reporting unpriced",
                    QUOTE_STABLE,
                    raw_asset,
                )

            name = resolved.symbol
            if resolved.earn_wrapped:
                name = f"{resolved.symbol} (Earn)"
            elif wallet == "FUNDING":
                name = f"{resolved.symbol} (Funding)"

            holdings.append(
                HoldingData(
                    external_id=f"{effective_wallet}:{resolved.symbol}",
                    name=name,
                    # Always a real ISO code. The coin symbol goes in `ticker`
                    # — a crypto ticker in the currency column overflows it
                    # and breaks the sync (cf. issues #448/#450).
                    currency=currency,
                    ticker=resolved.symbol,
                    current_value=(quantity * unit_price) if priced else Decimal("0"),
                    quantity=quantity,
                    unit_price=unit_price if priced else None,
                    metadata={
                        "wallet": effective_wallet,
                        "raw_asset": raw_asset,
                        "kind": resolved.kind,
                        "earn_wrapped": resolved.earn_wrapped,
                        "pair": resolved.pair,
                        "priced": priced,
                    },
                )
            )

        return holdings
