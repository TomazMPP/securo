"""Coinbase provider — read-only balances as investment holdings.

Coinbase has two generations of API credential and both are still in use:

* **CDP keys** (current). A key *name* like
  ``organizations/{org}/apiKeys/{key}`` plus an EC private key in PEM form.
  Each request carries a short-lived ES256 JWT.
* **Legacy HMAC keys**. api key + secret + passphrase, signed with
  HMAC-SHA256 over ``timestamp + method + path + body``.

Which one a user has depends on when they created it, so the scheme is
detected from the credential shape rather than asked for. Create the key
with *view* permission only — nothing here trades or withdraws.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from typing import Optional

import httpx

from app.agents.services.crypto import decrypt, encrypt
from app.providers.base import ConnectionData, SessionExpiredError
from app.providers.crypto_exchange import (
    CryptoExchangeProvider,
    WalletBalance,
    to_decimal,
)

logger = logging.getLogger(__name__)

COINBASE_API_HOST = "api.coinbase.com"
COINBASE_API = f"https://{COINBASE_API_HOST}"
ACCOUNTS_PATH = "/api/v3/brokerage/accounts"
HTTP_TIMEOUT = 30.0

# CDP JWTs are intentionally short-lived; Coinbase rejects anything older
# than two minutes.
JWT_TTL_SECONDS = 110


def _looks_like_cdp(credentials: dict) -> bool:
    """CDP keys carry a PEM private key; legacy ones carry a passphrase."""
    return bool(credentials.get("private_key_enc") or credentials.get("private_key"))


class CoinbaseProvider(CryptoExchangeProvider):
    """Read-only Coinbase connector (Advanced Trade brokerage accounts)."""

    @property
    def name(self) -> str:
        return "coinbase"

    # ----- credentials -------------------------------------------------------

    @staticmethod
    def _secret(credentials: dict, enc_field: str, plain_field: str) -> str:
        enc = (credentials or {}).get(enc_field)
        if enc:
            decoded = decrypt(enc)
            if decoded:
                return decoded
        return (credentials or {}).get(plain_field) or ""

    # ----- auth --------------------------------------------------------------

    def _cdp_jwt(self, credentials: dict, method: str, path: str) -> str:
        import jwt  # PyJWT, with the cryptography backend for ES256

        from cryptography.hazmat.primitives import serialization

        key_name = credentials.get("api_key") or ""
        private_key_pem = self._secret(credentials, "private_key_enc", "private_key")
        if not key_name or not private_key_pem:
            raise SessionExpiredError("Coinbase CDP credentials missing")

        # Env vars and JSON files routinely carry the PEM with escaped
        # newlines, which the PEM parser rejects outright.
        private_key_pem = private_key_pem.replace("\\n", "\n").strip()

        try:
            private_key = serialization.load_pem_private_key(
                private_key_pem.encode(), password=None
            )
        except Exception as exc:  # noqa: BLE001
            raise SessionExpiredError(
                "Coinbase private key could not be parsed — expected an EC key in PEM form"
            ) from exc

        now = int(time.time())
        # `uri` binds the token to one method+path, so a captured token cannot
        # be replayed against a different endpoint.
        payload = {
            "sub": key_name,
            "iss": "cdp",
            "nbf": now,
            "exp": now + JWT_TTL_SECONDS,
            "uri": f"{method} {COINBASE_API_HOST}{path}",
        }
        return jwt.encode(
            payload,
            private_key,
            algorithm="ES256",
            headers={"kid": key_name, "nonce": secrets.token_hex(16)},
        )

    def _legacy_headers(self, credentials: dict, method: str, path: str, body: str = "") -> dict:
        api_key = credentials.get("api_key") or ""
        api_secret = self._secret(credentials, "api_secret_enc", "api_secret")
        passphrase = self._secret(credentials, "passphrase_enc", "passphrase")
        if not api_key or not api_secret:
            raise SessionExpiredError("Coinbase API credentials missing")

        timestamp = str(int(time.time()))
        message = f"{timestamp}{method}{path}{body}"
        try:
            key = base64.b64decode(api_secret)
        except Exception:  # noqa: BLE001
            # Advanced Trade legacy keys are plain strings, not base64.
            key = api_secret.encode()
        signature = base64.b64encode(
            hmac.new(key, message.encode(), hashlib.sha256).digest()
        ).decode()

        headers = {
            "CB-ACCESS-KEY": api_key,
            "CB-ACCESS-SIGN": signature,
            "CB-ACCESS-TIMESTAMP": timestamp,
        }
        if passphrase:
            headers["CB-ACCESS-PASSPHRASE"] = passphrase
        return headers

    async def _get(self, credentials: dict, path: str) -> dict:
        if _looks_like_cdp(credentials):
            token = self._cdp_jwt(credentials, "GET", path)
            headers = {"Authorization": f"Bearer {token}"}
        else:
            headers = self._legacy_headers(credentials, "GET", path)
        headers["User-Agent"] = "Securo/0.1 (+https://usesecuro.com)"
        headers["Accept"] = "application/json"

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            resp = await client.get(f"{COINBASE_API}{path}", headers=headers)

        if resp.status_code in (401, 403):
            raise SessionExpiredError(
                f"Coinbase rejected the API key ({resp.status_code}). Check that "
                "it is valid and has the view permission."
            )
        if resp.status_code >= 400:
            raise RuntimeError(f"Coinbase {path} failed: {resp.status_code} {resp.text[:200]}")
        return resp.json()

    # ----- connection lifecycle ---------------------------------------------

    async def handle_oauth_callback(self, code: str) -> ConnectionData:
        """Validate pasted credentials and open the connection.

        Accepts the JSON Coinbase hands out when a CDP key is created
        (``{"name": ..., "privateKey": ...}``) as well as Securo's own field
        names, so the downloaded file can be pasted unedited.
        """
        raw = (code or "").strip()
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            parsed = None
        if not isinstance(parsed, dict):
            raise ValueError(
                'Coinbase credentials must be JSON: {"api_key": "...", "private_key": "..."} '
                'for CDP keys, or {"api_key": "...", "api_secret": "..."} for legacy keys'
            )

        api_key = str(parsed.get("api_key") or parsed.get("name") or "").strip()
        private_key = str(parsed.get("private_key") or parsed.get("privateKey") or "").strip()
        api_secret = str(parsed.get("api_secret") or "").strip()
        passphrase = str(parsed.get("passphrase") or "").strip()

        if not api_key:
            raise ValueError("Coinbase credentials are missing the key name")

        credentials: dict = {"api_key": api_key}
        if private_key:
            credentials["private_key_enc"] = encrypt(private_key)
        elif api_secret:
            credentials["api_secret_enc"] = encrypt(api_secret)
            if passphrase:
                credentials["passphrase_enc"] = encrypt(passphrase)
        else:
            raise ValueError("Coinbase credentials need either a private_key (CDP) or api_secret")

        # Fail fast on bad credentials rather than storing them.
        await self._get(credentials, f"{ACCOUNTS_PATH}?limit=1")

        return ConnectionData(
            external_id=f"coinbase:{api_key[-12:]}",
            institution_name="Coinbase",
            credentials=credentials,
            accounts=[],
        )

    async def refresh_credentials(self, credentials: dict) -> dict:
        if not (credentials or {}).get("api_key"):
            raise SessionExpiredError("Coinbase API credentials missing")
        return credentials

    # ----- balances ----------------------------------------------------------

    async def fetch_balances(self, credentials: dict) -> list[WalletBalance]:
        """Walk the paginated accounts list and sum available + held funds.

        Coinbase returns one account per currency, including a long tail of
        zero-balance ones for every asset it lists, so pagination has to be
        followed to reach the funded accounts.
        """
        balances: list[WalletBalance] = []
        cursor: Optional[str] = None
        seen_pages = 0

        while True:
            path = f"{ACCOUNTS_PATH}?limit=250"
            if cursor:
                path = f"{path}&cursor={cursor}"
            payload = await self._get(credentials, path)

            for acc in payload.get("accounts") or []:
                currency = str(acc.get("currency") or "").strip()
                if not currency:
                    continue
                available = to_decimal((acc.get("available_balance") or {}).get("value"))
                held = to_decimal((acc.get("hold") or {}).get("value"))
                qty = available + held
                if qty > 0:
                    balances.append(
                        WalletBalance(wallet="SPOT", asset=currency, quantity=qty)
                    )

            cursor = payload.get("cursor") or None
            seen_pages += 1
            # `has_next` is the documented flag; the cursor check guards
            # against a truthy-but-terminal response.
            if not payload.get("has_next") or not cursor or seen_pages >= 20:
                break

        return balances
