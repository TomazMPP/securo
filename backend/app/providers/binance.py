"""Binance provider — read-only balances as investment holdings.

Credentials are an API key + secret created with *Enable Reading* only. The
client never places orders or initiates withdrawals; the single POST it
issues is a read that Binance happens to expose that way.

Only Binance-specific concerns live here — request signing, the funding
wallet, and the Flexible Earn wrappers. Everything downstream of a balance is
shared with the other exchanges (:mod:`app.providers.crypto_exchange`).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Callable
from urllib.parse import urlencode

import httpx

from app.agents.services.crypto import decrypt, encrypt
from app.providers.base import ConnectionData, SessionExpiredError
from app.providers.crypto_exchange import (
    CryptoExchangeProvider,
    ResolvedAsset,
    WalletBalance,
    resolve_asset,
    to_decimal,
)

logger = logging.getLogger(__name__)

BINANCE_API = "https://api.binance.com"
HTTP_TIMEOUT = 30.0

# Binance rejects signed requests whose timestamp drifts outside recvWindow.
RECV_WINDOW_MS = 10_000
CLOCK_OFFSET_TTL_SECONDS = 30 * 60

# Provider instances are constructed per call by get_provider(), so the
# learned server/host skew is cached at module level to survive across them.
_clock_offset_ms: int = 0
_clock_offset_at: float = 0.0


class BinanceProvider(CryptoExchangeProvider):
    """Read-only Binance connector (spot + funding + Earn)."""

    @property
    def name(self) -> str:
        return "binance"

    # ----- credentials -------------------------------------------------------

    @staticmethod
    def _creds(credentials: dict) -> tuple[str, str]:
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

    # ----- HTTP --------------------------------------------------------------

    async def _clock_offset(self) -> int:
        """Server/host skew in ms, re-learned every 30 minutes.

        Self-hosted boxes drift and Binance rejects stale timestamps; one
        cheap public call keeps every later signature valid.
        """
        global _clock_offset_ms, _clock_offset_at
        if time.time() - _clock_offset_at < CLOCK_OFFSET_TTL_SECONDS:
            return _clock_offset_ms
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
                resp = await client.get(f"{BINANCE_API}/api/v3/time")
                resp.raise_for_status()
                server_time = int(resp.json()["serverTime"])
            _clock_offset_ms = server_time - int(time.time() * 1000)
            _clock_offset_at = time.time()
        except Exception:  # noqa: BLE001
            # Not fatal: fall back to the last known value, which is correct
            # on a well-synced host.
            logger.warning("Binance: could not read server time; using cached offset")
        return _clock_offset_ms

    async def _signed(
        self, credentials: dict, path: str, params: dict | None = None, method: str = "GET",
    ):
        """Issue a signed request.

        The signature covers the exact query string that is sent, timestamp
        included, so ``signature`` is appended last — anything added after
        signing would invalidate it.
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

        async with httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            headers={
                "X-MBX-APIKEY": api_key,
                "Accept": "application/json",
                "User-Agent": "Securo/0.1 (+https://usesecuro.com)",
            },
        ) as client:
            resp = await client.request(
                method, f"{BINANCE_API}{path}?{query}&signature={signature}"
            )

        if resp.status_code in (401, 403):
            raise SessionExpiredError(
                f"Binance rejected the API key ({resp.status_code}). Check that it "
                "is valid and, if IP-restricted, that this host's address is allowed."
            )
        if resp.status_code >= 400:
            raise RuntimeError(f"Binance {path} failed: {resp.status_code} {resp.text[:200]}")
        return resp.json()

    # ----- connection lifecycle ---------------------------------------------

    async def handle_oauth_callback(self, code: str) -> ConnectionData:
        """Validate a pasted API key/secret and open the connection.

        Accepts ``{"api_key": ..., "api_secret": ...}`` or a plain
        ``key:secret`` string, so the existing token dialog works unchanged.
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
        # Fail fast on a bad key rather than storing it.
        await self._signed(credentials, "/api/v3/account", {"omitZeroBalances": "true"})

        return ConnectionData(
            external_id=f"binance:{api_key[:8]}",
            institution_name="Binance",
            credentials=credentials,
            accounts=[],
        )

    async def refresh_credentials(self, credentials: dict) -> dict:
        self._creds(credentials)
        return credentials

    # ----- balances ----------------------------------------------------------

    def resolve(self, asset: str, has_pair: Callable[[str], bool]) -> ResolvedAsset:
        """Resolve a symbol, unwrapping Flexible Earn positions.

        Earn balances are reported *inside* the spot wallet under synthetic
        ``LD``-prefixed symbols (``LDBTC`` = BTC in Flexible Earn). The trap
        is that ``LD`` also begins real tickers — ``LDO`` is Lido. The price
        table is the oracle that separates them: unwrap only when the full
        symbol has **no pair of its own** and the remainder **does**.
        """
        sym = (asset or "").upper()
        direct = resolve_asset(sym, has_pair)
        if direct.kind != "CRYPTO" or direct.pair is not None:
            return direct

        if sym.startswith("LD") and len(sym) > 2:
            inner = resolve_asset(sym[2:], has_pair)
            if inner.pair is not None or inner.kind in ("STABLE_USD", "FIAT"):
                inner.wallet_override = "EARN"
                return inner

        return direct

    async def fetch_balances(self, credentials: dict) -> list[WalletBalance]:
        spot_raw = await self._signed(
            credentials, "/api/v3/account", {"omitZeroBalances": "true"}
        )
        balances: list[WalletBalance] = []
        for row in spot_raw.get("balances") or []:
            qty = to_decimal(row.get("free")) + to_decimal(row.get("locked"))
            if qty > 0:
                balances.append(
                    WalletBalance(wallet="SPOT", asset=str(row.get("asset") or ""), quantity=qty)
                )

        # The funding wallet is read via POST — Binance's choice, not ours.
        # A key that lacks the permission for it is a configuration, not an
        # outage, so only that case degrades to spot-only. Transient failures
        # propagate instead: a partial balance list reads as "positions gone"
        # downstream and archives those holdings.
        try:
            funding = await self._signed(
                credentials, "/sapi/v1/asset/get-funding-asset", method="POST"
            ) or []
        except SessionExpiredError:
            logger.warning(
                "Binance: funding wallet not permitted for this key; reporting spot only"
            )
            funding = []

        for row in funding:
            qty = (
                to_decimal(row.get("free"))
                + to_decimal(row.get("locked"))
                + to_decimal(row.get("freeze"))
                + to_decimal(row.get("withdrawing"))
            )
            if qty > 0:
                balances.append(
                    WalletBalance(
                        wallet="FUNDING", asset=str(row.get("asset") or ""), quantity=qty
                    )
                )

        return balances
