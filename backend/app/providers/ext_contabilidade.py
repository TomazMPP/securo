"""EXT Contabilidade provider — the accountant's Open Finance feed, read-only.

EXT Contabilidade (a Brazilian accounting firm) connects its clients' business
bank accounts through Pluggy and shows them in its web app. This provider reads
that feed through the same JSON API the web app calls, logged in as the company
owner. EXT talks to the banks; we only read what it already pulled. Nothing is
ever written on their side.

There is no published contract, so everything here is defensive:

  - Every payload is shape-checked before use; a malformed transaction row is
    skipped and counted, never fatal for the batch.
  - Refresh tokens ROTATE: each ``/auth/refresh`` returns a new one and kills
    the previous. A lost or raced token (a manual sync overlapping the nightly
    one, a rolled-back commit) is not an error — we fall back to a fresh
    ``/auth/login`` with the stored password, which starts a new chain.
  - Requests are spaced ``MIN_GAP_SECONDS`` apart process-wide; it's their
    production API, not a bulk endpoint.

Feed quirks, all found the hard way by an earlier integration and checked
against the banks' PDF statements:

  - ``date`` comes without an offset and is already Brasília time. Treating it
    as UTC moves rows posted 00:00–02:59 to the previous day.
  - The transactions endpoint sometimes ignores ``accountId``; rows are
    filtered again on our side.
  - Rows are Pluggy transaction objects, so payee extraction and category
    mapping reuse the Pluggy provider's.

Error messages and logs carry the path only — never the query string (it holds
company/account ids), amounts, descriptions or names.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

import httpx

from app.agents.services.crypto import decrypt, encrypt
from app.providers.base import (
    AccountData,
    BankProvider,
    ConnectionData,
    SessionExpiredError,
    TransactionData,
    mask_last4,
)
from app.providers.pluggy import PluggyProvider

logger = logging.getLogger(__name__)

EXT_API = "https://api.extcontabilidade.com.br"
HTTP_TIMEOUT = 60.0
MIN_GAP_SECONDS = 0.4
PAGE_SIZE = 100
MAX_PAGES = 500
# First sync with no cursor: ask for everything. The feed only holds what EXT
# has pulled since the company was onboarded, so this is bounded in practice.
INITIAL_START = date(2020, 1, 1)
INSTITUTION_NAME = "EXT Contabilidade"
BRT = timezone(timedelta(hours=-3))

# Provider instances are built per call by get_provider(), so the request
# spacing is tracked at module level to hold across them.
_gap_lock = asyncio.Lock()
_last_request_at = 0.0

_DATE_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?)?$",
    re.IGNORECASE,
)


class ExtApiError(Exception):
    def __init__(self, status: int, path: str) -> None:
        super().__init__(f"EXT {path.split('?')[0]}: HTTP {status}")
        self.status = status


def ext_day(value: Any) -> Optional[date]:
    """The Brasília calendar day of an EXT timestamp.

    No offset means it is already Brasília time, so the date part is taken as
    is. With an offset, the instant is converted to UTC-3.
    """
    if not isinstance(value, str):
        return None
    m = _DATE_RE.match(value.strip())
    if not m:
        return None
    day, clock, offset = m.groups()
    try:
        if not offset:
            return date.fromisoformat(day)
        if offset.upper() == "Z":
            offset = "+00:00"
        elif ":" not in offset:
            offset = f"{offset[:3]}:{offset[3:]}"
        clock = re.sub(r"\.(\d+)", lambda f: "." + f.group(1)[:6].ljust(6, "0"), clock or "00:00")
        return datetime.fromisoformat(f"{day}T{clock}{offset}").astimezone(BRT).date()
    except ValueError:
        return None


def _decimal(value: Any) -> Optional[Decimal]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _account_id_of(row: dict) -> Optional[str]:
    acc = row.get("account")
    if isinstance(acc, str):
        return acc
    if isinstance(acc, dict) and isinstance(acc.get("id"), str):
        return acc["id"]
    return row.get("accountId") if isinstance(row.get("accountId"), str) else None


def _first_company_id(payload: Any) -> Optional[str]:
    """``GET /companies/me`` → ``{"total": n, "companies": [{_id, id, ...}]}``."""
    rows = payload.get("companies") if isinstance(payload, dict) else payload
    first = rows[0] if isinstance(rows, list) and rows else None
    if not isinstance(first, dict):
        return None
    cid = first.get("_id") or first.get("id")
    return cid if isinstance(cid, str) and cid else None


def build_transaction(row: Any, payee_source: str = "auto") -> Optional[TransactionData]:
    """One feed row → TransactionData, or None when the row is unusable."""
    if not isinstance(row, dict):
        return None
    txn_id = row.get("id")
    if not isinstance(txn_id, str) or not txn_id:
        return None
    amount_raw = _decimal(row.get("amount"))
    txn_date = ext_day(row.get("date"))
    if amount_raw is None or txn_date is None:
        return None

    # The amount is already signed, but the explicit type wins so a feed that
    # changes its sign convention can't flip money around.
    kind = str(row.get("type") or "").upper()
    if kind == "DEBIT":
        txn_type = "debit"
    elif kind == "CREDIT":
        txn_type = "credit"
    else:
        txn_type = "credit" if amount_raw >= 0 else "debit"

    category = row.get("category") if isinstance(row.get("category"), str) else None
    description = row.get("description") if isinstance(row.get("description"), str) else None
    # The nested account object is ~1 KB repeated on every row; keep the id.
    raw = {k: v for k, v in row.items() if k != "account"}
    raw["account_id"] = _account_id_of(row)
    return TransactionData(
        external_id=txn_id,
        description=(description or category or "Movimentação").strip(),
        amount=amount_raw.copy_abs(),
        date=txn_date,
        type=txn_type,
        currency=row.get("currencyCode") if isinstance(row.get("currencyCode"), str) else None,
        pluggy_category=category,
        status="pending" if str(row.get("status") or "").upper() == "PENDING" else "posted",
        payee=PluggyProvider._extract_payee(row, txn_type, payee_source),
        raw_data=raw,
    )


class ExtContabilidadeProvider(BankProvider):
    """Read-only connector for the EXT Contabilidade bank-statement feed."""

    @property
    def name(self) -> str:
        return "ext_contabilidade"

    @property
    def flow_type(self) -> str:
        return "token"

    # ----- HTTP --------------------------------------------------------------

    async def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=EXT_API,
            timeout=HTTP_TIMEOUT,
            headers={"Accept": "application/json", "User-Agent": "Securo/0.1 (+https://usesecuro.com)"},
        )

    async def _raw(
        self, method: str, path: str, *, params: Optional[dict] = None,
        body: Optional[dict] = None, token: Optional[str] = None,
    ) -> Any:
        global _last_request_at
        async with _gap_lock:
            wait = _last_request_at + MIN_GAP_SECONDS - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            _last_request_at = time.monotonic()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        async with await self._client() as client:
            resp = await client.request(method, path, params=params, json=body, headers=headers)
        if resp.status_code >= 400:
            raise ExtApiError(resp.status_code, path)
        return resp.json() if resp.content else None

    # ----- credentials -------------------------------------------------------

    @staticmethod
    def _secret(credentials: dict, key: str) -> str:
        enc = (credentials or {}).get(f"{key}_enc")
        return (decrypt(enc) or "") if enc else ""

    @staticmethod
    def _tokens(payload: Any) -> tuple[str, Optional[str]]:
        data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else payload
        data = data if isinstance(data, dict) else {}
        access = data.get("accessToken") or data.get("access_token") or data.get("token")
        if not isinstance(access, str) or not access:
            raise ExtApiError(502, "/auth (no accessToken)")
        refresh = data.get("refreshToken") or data.get("refresh_token")
        return access, refresh if isinstance(refresh, str) and refresh else None

    async def _login(self, email: str, password: str) -> tuple[str, Optional[str]]:
        try:
            return self._tokens(await self._raw("POST", "/auth/login", body={"email": email, "password": password}))
        except ExtApiError as exc:
            if exc.status in (400, 401, 403):
                raise SessionExpiredError(
                    "EXT Contabilidade rejected the email/password. Reconnect with the current credentials."
                ) from exc
            raise

    async def _authenticate(self, credentials: dict) -> dict:
        """Return credentials with a live access token, rotating the refresh token.

        Refresh first; a dead or raced refresh token falls back to a password
        login, which starts a new chain. Mutates and returns ``credentials`` so
        a re-login mid-sync is visible to later calls in the same run.
        """
        stored = self._secret(credentials, "refresh_token")
        access = refresh = None
        if stored:
            try:
                access, refresh = self._tokens(
                    await self._raw("POST", "/auth/refresh", body={"refreshToken": stored})
                )
            except ExtApiError:
                logger.info("EXT: refresh token rejected, logging in again")
        if not access:
            email = (credentials or {}).get("email") or ""
            password = self._secret(credentials, "password")
            if not email or not password:
                raise SessionExpiredError("EXT Contabilidade credentials missing")
            access, refresh = await self._login(email, password)
        credentials["access_token_enc"] = encrypt(access)
        # They rotate on every refresh: always persist the newest one.
        credentials["refresh_token_enc"] = encrypt(refresh) if refresh else None
        return credentials

    async def _get(self, credentials: dict, path: str, params: Optional[dict] = None) -> Any:
        token = self._secret(credentials, "access_token")
        if not token:
            await self._authenticate(credentials)
            token = self._secret(credentials, "access_token")
        try:
            return await self._raw("GET", path, params=params, token=token)
        except ExtApiError as exc:
            if exc.status != 401:
                raise
        # Access token expired mid-run: renew once and retry.
        await self._authenticate(credentials)
        return await self._raw("GET", path, params=params, token=self._secret(credentials, "access_token"))

    async def _company_id(self, credentials: dict) -> str:
        cid = (credentials or {}).get("company_id")
        if cid:
            return cid
        cid = _first_company_id(await self._get(credentials, "/companies/me"))
        if not cid:
            raise ExtApiError(502, "/companies/me (no company)")
        credentials["company_id"] = cid
        return cid

    # ----- connection lifecycle ---------------------------------------------

    def get_oauth_url(self, *args, **kwargs):  # type: ignore[override]
        raise NotImplementedError("EXT Contabilidade uses an email/password form, not OAuth redirect")

    async def handle_oauth_callback(self, code: str) -> ConnectionData:
        """Validate a pasted ``{"email": ..., "password": ...}`` and open the connection."""
        try:
            parsed = json.loads((code or "").strip())
        except ValueError:
            parsed = None
        email = str((parsed or {}).get("email") or "").strip() if isinstance(parsed, dict) else ""
        password = str((parsed or {}).get("password") or "") if isinstance(parsed, dict) else ""
        if not email or not password:
            raise ValueError('EXT Contabilidade credentials must be {"email": "...", "password": "..."}')

        access, refresh = await self._login(email, password)
        credentials: dict = {
            "email": email,
            "password_enc": encrypt(password),
            "access_token_enc": encrypt(access),
            "refresh_token_enc": encrypt(refresh) if refresh else None,
        }
        company_id = await self._company_id(credentials)
        accounts = await self.get_accounts(credentials)
        return ConnectionData(
            external_id=f"ext-{company_id}",
            institution_name=INSTITUTION_NAME,
            credentials=credentials,
            accounts=accounts,
        )

    async def refresh_credentials(self, credentials: dict) -> dict:
        return await self._authenticate(dict(credentials or {}))

    # ----- data --------------------------------------------------------------

    async def get_accounts(self, credentials: dict) -> list[AccountData]:
        company_id = await self._company_id(credentials)
        payload = await self._get(
            credentials, "/bank-statements/accounts", {"companyId": company_id, "limit": 50, "offset": 0}
        )
        rows = payload.get("data") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise ExtApiError(502, "/bank-statements/accounts (unexpected shape)")

        accounts: list[AccountData] = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                continue
            connector = (row.get("connection") or {}).get("connector") or {}
            bank = connector.get("name") if isinstance(connector.get("name"), str) else None
            balance = _decimal(row.get("balance"))
            accounts.append(
                AccountData(
                    external_id=row["id"],
                    name=row.get("marketingName") or row.get("name") or bank or "Conta",
                    type=PluggyProvider._map_account_type(str(row.get("type") or "BANK"), row.get("subtype")),
                    balance=balance if balance is not None else Decimal("0"),
                    currency=row.get("currencyCode") or "BRL",
                    masked_number=mask_last4(row.get("number")),
                    institution_external_id=str(connector["id"]) if connector.get("id") is not None else None,
                    institution_name=bank,
                    institution_logo_url=connector.get("imageUrl") if isinstance(connector.get("imageUrl"), str) else None,
                )
            )
        return accounts

    async def get_transactions(
        self, credentials: dict, account_external_id: str,
        since: Optional[date] = None, payee_source: str = "auto",
    ) -> list[TransactionData]:
        company_id = await self._company_id(credentials)
        start = (since or INITIAL_START).isoformat()
        out: list[TransactionData] = []
        seen: set[str] = set()
        skipped = 0
        offset = 0
        for _ in range(MAX_PAGES):
            payload = await self._get(
                credentials, "/bank-statements/transactions",
                {"companyId": company_id, "accountId": account_external_id,
                 "startDate": start, "limit": PAGE_SIZE, "offset": offset},
            )
            if not isinstance(payload, dict) or not isinstance(payload.get("transactions"), list):
                raise ExtApiError(502, "/bank-statements/transactions (unexpected shape)")
            page = payload["transactions"]
            for row in page:
                # The endpoint sometimes ignores accountId.
                owner = _account_id_of(row) if isinstance(row, dict) else None
                if owner is not None and owner != account_external_id:
                    continue
                txn = build_transaction(row, payee_source)
                if txn is None:
                    skipped += 1
                elif txn.external_id not in seen:
                    seen.add(txn.external_id)
                    out.append(txn)
            if not page:
                break
            offset += len(page)
            total = payload.get("total")
            if (offset >= total) if isinstance(total, int) else len(page) < PAGE_SIZE:
                break
        if skipped:
            logger.warning("EXT: skipped %d malformed transaction rows", skipped)
        out.sort(key=lambda t: t.date)
        return out
