"""Bybit provider — read-only balances as investment holdings.

Credentials are a system-generated (HMAC) API key + secret created in
Read-Only mode. Every request this client issues is a GET; nothing here
trades, transfers, or withdraws.

Only Bybit-specific concerns live here — the V5 signing scheme, the
retCode error contract (failures arrive as HTTP 200), and the three places
a balance can live: the Unified Trading Account, the funding wallet, and
Earn positions. Everything downstream of a balance is shared with the other
exchanges (:mod:`app.providers.crypto_exchange`).

Bybit finished migrating everyone onto the Unified Trading Account, so the
wallet endpoint accepts only ``accountType=UNIFIED``; a residual classic
account answers with retCode 10028 and has to upgrade on Bybit's side.
Fixed-term savings and the BYUSDT yield token sit behind separate endpoints
and are deliberately out of scope, matching what the Binance connector
covers for Earn. Known limitation: an On-Chain Earn position staked in LST
mode also mints a liquid token (e.g. BBSOL) into the unified wallet, and the
API offers no field to tell the two apart, so such a position can appear
twice.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from decimal import Decimal
from urllib.parse import urlencode

import httpx

from app.agents.services.crypto import decrypt, encrypt
from app.providers.base import ConnectionData, SessionExpiredError
from app.providers.crypto_exchange import (
    CryptoExchangeProvider,
    WalletBalance,
    to_decimal,
)

logger = logging.getLogger(__name__)

BYBIT_API = "https://api.bybit.com"
HTTP_TIMEOUT = 30.0

# Bybit accepts a timestamp in [server_time - recvWindow, server_time + 1s).
# A generous window forgives a slow host clock; a fast one is only saved by
# the offset learned from /v5/market/time below.
RECV_WINDOW_MS = 10_000
CLOCK_OFFSET_TTL_SECONDS = 30 * 60

# Provider instances are constructed per call by get_provider(), so the
# learned server/host skew is cached at module level to survive across them.
_clock_offset_ms: int = 0
_clock_offset_at: float = 0.0

# retCodes that mean the key itself is unusable, as opposed to a bad request:
# 10003 invalid key, 10004 bad signature, 10005 permission denied,
# 10007 auth failed, 10010 IP not whitelisted, 33004 key expired.
_AUTH_RET_CODES = frozenset({10003, 10004, 10005, 10007, 10010, 33004})

# Timestamp outside the recv window — re-learn the clock offset and retry.
_RET_TIMESTAMP_DRIFT = 10002

# Endpoint requires a Unified Trading Account.
_RET_NOT_UTA = 10028


class BybitProvider(CryptoExchangeProvider):
    """Read-only Bybit connector (unified wallet + funding + Earn)."""

    @property
    def name(self) -> str:
        return "bybit"

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
            raise SessionExpiredError("Bybit API credentials missing")
        return api_key, secret

    # ----- HTTP --------------------------------------------------------------

    async def _clock_offset(self, force: bool = False) -> int:
        """Server/host skew in ms, re-learned every 30 minutes.

        Bybit rejects any timestamp more than a second ahead of its clock no
        matter how large recvWindow is, so a fast self-hosted box needs the
        learned offset, not just a wide window.
        """
        global _clock_offset_ms, _clock_offset_at
        if not force and time.time() - _clock_offset_at < CLOCK_OFFSET_TTL_SECONDS:
            return _clock_offset_ms
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
                resp = await client.get(f"{BYBIT_API}/v5/market/time")
                resp.raise_for_status()
                server_time = int((resp.json() or {}).get("time") or 0)
            if server_time:
                _clock_offset_ms = server_time - int(time.time() * 1000)
                _clock_offset_at = time.time()
        except Exception:  # noqa: BLE001
            # Not fatal: fall back to the last known value, which is correct
            # on a well-synced host.
            logger.warning("Bybit: could not read server time; using cached offset")
        return _clock_offset_ms

    async def _signed(self, credentials: dict, path: str, params: dict | None = None) -> dict:
        """Issue a signed GET and unwrap the retCode envelope.

        The signature covers ``timestamp + api_key + recvWindow + query`` for
        the exact query string that is sent. Business failures arrive as
        HTTP 200 with a non-zero ``retCode``, so success is read out of the
        body, never the status line. One retry is allowed when the failure is
        clock drift (10002), after force-refreshing the learned offset.
        """
        api_key, api_secret = self._creds(credentials)
        query = urlencode(params or {})
        url = f"{BYBIT_API}{path}?{query}" if query else f"{BYBIT_API}{path}"

        for attempt in (0, 1):
            offset = await self._clock_offset(force=attempt > 0)
            timestamp = int(time.time() * 1000) + offset
            payload = f"{timestamp}{api_key}{RECV_WINDOW_MS}{query}"
            signature = hmac.new(
                api_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
            ).hexdigest()

            async with httpx.AsyncClient(
                timeout=HTTP_TIMEOUT,
                headers={
                    "X-BAPI-API-KEY": api_key,
                    "X-BAPI-TIMESTAMP": str(timestamp),
                    "X-BAPI-RECV-WINDOW": str(RECV_WINDOW_MS),
                    "X-BAPI-SIGN": signature,
                    "Accept": "application/json",
                    "User-Agent": "Securo/0.1 (+https://usesecuro.com)",
                },
            ) as client:
                resp = await client.get(url)

            if resp.status_code in (401, 403):
                raise SessionExpiredError(
                    f"Bybit rejected the API key ({resp.status_code}). Check that it "
                    "is valid and, if IP-restricted, that this host's address is allowed."
                )
            if resp.status_code >= 400:
                raise RuntimeError(f"Bybit {path} failed: {resp.status_code} {resp.text[:200]}")

            parsed = resp.json() or {}
            if "retCode" not in parsed:
                # A 200 without the envelope (gateway/WAF junk) must not read
                # as an empty result — empty balances archive holdings
                # downstream.
                raise RuntimeError(
                    f"Bybit {path} returned no retCode; treating as failure: "
                    f"{resp.text[:200]}"
                )
            ret_code = int(parsed.get("retCode") or 0)
            if ret_code == 0:
                return parsed.get("result") or {}

            message = str(parsed.get("retMsg") or "")
            if ret_code == _RET_TIMESTAMP_DRIFT and attempt == 0:
                logger.info("Bybit: timestamp outside recv window; resyncing clock")
                continue
            if ret_code in _AUTH_RET_CODES:
                raise SessionExpiredError(
                    f"Bybit rejected the API key (retCode {ret_code}: {message}). "
                    "Check that the key is valid, read-only, not expired and, if "
                    "IP-restricted, that this host's address is allowed."
                )
            if ret_code == _RET_NOT_UTA:
                raise RuntimeError(
                    "Bybit reports this is not a Unified Trading Account. Upgrade "
                    "the account to UTA on Bybit, then reconnect."
                )
            if ret_code == _RET_TIMESTAMP_DRIFT:
                raise RuntimeError(
                    f"Bybit {path} failed: timestamp drift persisted after a clock "
                    f"resync ({message}). Check this host's clock."
                )
            raise RuntimeError(f"Bybit {path} failed: retCode {ret_code} {message}")

        raise RuntimeError(f"Bybit {path} failed: retry loop exhausted")  # pragma: no cover

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
                'Bybit credentials must be {"api_key": "...", "api_secret": "..."}'
            )

        credentials = {"api_key": api_key, "api_secret_enc": encrypt(api_secret)}
        # Fail fast on a bad key rather than storing it. The wallet endpoint
        # is the same one every later sync hits, so a key that validates here
        # is a key that syncs.
        await self._signed(credentials, "/v5/account/wallet-balance", {"accountType": "UNIFIED"})

        return ConnectionData(
            external_id=f"bybit:{api_key[:8]}",
            institution_name="Bybit",
            credentials=credentials,
            accounts=[],
        )

    async def refresh_credentials(self, credentials: dict) -> dict:
        self._creds(credentials)
        return credentials

    # ----- balances ----------------------------------------------------------

    async def fetch_balances(self, credentials: dict) -> list[WalletBalance]:
        # Aggregated by (wallet, asset): Earn can hold several positions in
        # the same coin, and duplicate keys would collide downstream where
        # holdings are identified as "EARN:BTC".
        totals: dict[tuple[str, str], Decimal] = {}

        def add(wallet: str, asset: str, qty: Decimal) -> None:
            if asset and qty > 0:
                key = (wallet, asset)
                totals[key] = totals.get(key, Decimal("0")) + qty

        unified = await self._signed(
            credentials, "/v5/account/wallet-balance", {"accountType": "UNIFIED"}
        )
        for account in unified.get("list") or []:
            for row in account.get("coin") or []:
                # walletBalance already includes spot-order locks; a borrowed
                # coin can push it negative, which add() drops.
                add("SPOT", str(row.get("coin") or ""), to_decimal(row.get("walletBalance")))

        # The funding wallet and Earn sit behind their own permission boxes,
        # and a key created without them is a configuration, not an outage —
        # skip the wallet. Anything else (rate limit, network, 5xx) must
        # propagate instead: a partial balance list reads as "positions gone"
        # downstream and archives those holdings.
        try:
            funding = await self._signed(
                credentials,
                "/v5/asset/transfer/query-account-coins-balance",
                {"accountType": "FUND"},
            )
            funding_rows = funding.get("balance") or []
        except SessionExpiredError:
            logger.warning("Bybit: funding wallet not permitted for this key; skipping it")
            funding_rows = []
        for row in funding_rows:
            add("FUNDING", str(row.get("coin") or ""), to_decimal(row.get("walletBalance")))

        # Flexible savings redeem to zero rather than disappearing, which the
        # qty > 0 guard in add() already handles.
        for category, wallet in (("FlexibleSaving", "EARN"), ("OnChain", "STAKING")):
            try:
                earn = await self._signed(
                    credentials, "/v5/earn/position", {"category": category}
                )
                earn_rows = earn.get("list") or []
            except SessionExpiredError:
                logger.warning(
                    "Bybit: %s positions not permitted for this key; skipping them",
                    category,
                )
                continue
            for row in earn_rows:
                add(wallet, str(row.get("coin") or ""), to_decimal(row.get("amount")))

        return [
            WalletBalance(wallet=wallet, asset=asset, quantity=qty)
            for (wallet, asset), qty in totals.items()
        ]
