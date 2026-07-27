"""Kraken provider — read-only balances as investment holdings.

Credentials are an API key plus a base64 private key, created with the
*Query Funds* permission only. Nothing here places orders or withdraws.

Two Kraken specifics are handled: the signing scheme (HMAC-SHA512 over the
path and a SHA-256 digest of the payload) and the legacy asset codes, where
bitcoin is ``XXBT`` and dollars are ``ZUSD``.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import urllib.parse
from decimal import Decimal
from typing import Callable

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

KRAKEN_API = "https://api.kraken.com"
HTTP_TIMEOUT = 30.0

# Kraken's legacy codes prefix crypto with X and fiat with Z. Newer listings
# use the plain symbol, so both spellings appear in one balance payload.
_LEGACY_CODES = {
    "XXBT": "BTC", "XBT": "BTC", "XETH": "ETH", "XLTC": "LTC", "XXRP": "XRP",
    "XXLM": "XLM", "XXMR": "XMR", "XZEC": "ZEC", "XETC": "ETC", "XREP": "REP",
    "XMLN": "MLN", "XDAO": "DAO", "XNMC": "NMC", "XXDG": "DOGE", "XDG": "DOGE",
    "ZUSD": "USD", "ZEUR": "EUR", "ZGBP": "GBP", "ZCAD": "CAD", "ZAUD": "AUD",
    "ZJPY": "JPY", "ZCHF": "CHF",
}

# Suffixes Kraken appends to a symbol for yield-bearing variants:
#   .S  staked        .M  opt-in rewards      .F  earn/flexible
#   .B  bonded        .P  parachain bonded
# The underlying coin is the same asset, so the suffix selects a wallet label
# rather than creating a separate instrument.
_YIELD_SUFFIXES = {
    ".S": "STAKING", ".M": "STAKING", ".F": "EARN", ".B": "STAKING", ".P": "STAKING",
}


def _normalize_asset(raw: str) -> tuple[str, str | None]:
    """Return (canonical symbol, wallet override) for a Kraken asset code."""
    code = (raw or "").strip().upper()
    wallet: str | None = None

    for suffix, label in _YIELD_SUFFIXES.items():
        if code.endswith(suffix):
            code = code[: -len(suffix)]
            wallet = label
            break

    # Kraken also writes some staked assets as e.g. "ETH2" or "ETH2.S".
    if code == "ETH2":
        code, wallet = "ETH", wallet or "STAKING"

    return _LEGACY_CODES.get(code, code), wallet


class KrakenProvider(CryptoExchangeProvider):
    """Read-only Kraken connector (spot + staked balances)."""

    @property
    def name(self) -> str:
        return "kraken"

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
            secret = creds.get("api_secret") or ""
        if not api_key or not secret:
            raise SessionExpiredError("Kraken API credentials missing")
        return api_key, secret

    # ----- signed request ----------------------------------------------------

    async def _private(self, credentials: dict, path: str, data: dict | None = None) -> dict:
        """POST to a private endpoint.

        Signature is ``HMAC-SHA512(path + SHA256(nonce + body), secret)`` over
        the exact encoded body that is sent, so the nonce must be identical in
        both — hence building the body once and reusing it.
        """
        api_key, api_secret = self._creds(credentials)
        try:
            secret_bytes = base64.b64decode(api_secret)
        except Exception as exc:  # noqa: BLE001
            raise SessionExpiredError("Kraken private key is not valid base64") from exc

        # Kraken requires a strictly increasing nonce per key; ms since epoch
        # satisfies that as long as calls are not made twice in one millisecond.
        nonce = str(int(time.time() * 1000))
        payload = {"nonce": nonce, **(data or {})}
        body = urllib.parse.urlencode(payload)

        sha = hashlib.sha256((nonce + body).encode()).digest()
        mac = hmac.new(secret_bytes, path.encode() + sha, hashlib.sha512)
        signature = base64.b64encode(mac.digest()).decode()

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            resp = await client.post(
                f"{KRAKEN_API}{path}",
                content=body,
                headers={
                    "API-Key": api_key,
                    "API-Sign": signature,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "Securo/0.1 (+https://usesecuro.com)",
                },
            )

        if resp.status_code >= 400:
            raise RuntimeError(f"Kraken {path} failed: {resp.status_code} {resp.text[:200]}")

        parsed = resp.json()
        # Kraken answers 200 with an `error` array rather than an HTTP status,
        # so auth failures have to be read out of the body.
        errors = parsed.get("error") or []
        if errors:
            joined = "; ".join(str(e) for e in errors)
            if any("Invalid key" in str(e) or "Permission denied" in str(e) for e in errors):
                raise SessionExpiredError(
                    f"Kraken rejected the API key: {joined}. Check the key and "
                    "that it has the Query Funds permission."
                )
            raise RuntimeError(f"Kraken {path} error: {joined}")
        return parsed.get("result") or {}

    # ----- connection lifecycle ---------------------------------------------

    async def handle_oauth_callback(self, code: str) -> ConnectionData:
        """Validate a pasted key pair and open the connection."""
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
                'Kraken credentials must be {"api_key": "...", "api_secret": "..."}'
            )

        credentials = {"api_key": api_key, "api_secret_enc": encrypt(api_secret)}
        # Fail fast on a bad key rather than storing it and failing at sync.
        await self._private(credentials, "/0/private/Balance")

        return ConnectionData(
            external_id=f"kraken:{api_key[:8]}",
            institution_name="Kraken",
            credentials=credentials,
            accounts=[],
        )

    async def refresh_credentials(self, credentials: dict) -> dict:
        self._creds(credentials)
        return credentials

    # ----- balances ----------------------------------------------------------

    def resolve(self, asset: str, has_pair: Callable[[str], bool]) -> ResolvedAsset:
        symbol, wallet = _normalize_asset(asset)
        resolved = resolve_asset(symbol, has_pair)
        if wallet:
            resolved.wallet_override = wallet
        return resolved

    async def fetch_balances(self, credentials: dict) -> list[WalletBalance]:
        result = await self._private(credentials, "/0/private/Balance")
        balances: list[WalletBalance] = []
        for raw_asset, amount in (result or {}).items():
            qty = to_decimal(amount)
            if qty > 0:
                balances.append(WalletBalance(wallet="SPOT", asset=str(raw_asset), quantity=qty))
        return balances
