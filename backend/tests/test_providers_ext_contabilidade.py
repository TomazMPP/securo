"""Unit tests for the EXT Contabilidade provider.

The EXT API is faked with ``httpx.MockTransport``: no credentials, no network.
Payload shapes follow what the API returned when probed (values synthetic).
"""
from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import httpx
import pytest

from app.agents.services.crypto import decrypt, encrypt
from app.providers import ext_contabilidade as ext
from app.providers.base import SessionExpiredError
from app.providers.ext_contabilidade import (
    ExtContabilidadeProvider,
    build_transaction,
    ext_day,
)

COMPANY = "c0000000-0000-0000-0000-000000000001"
ITAU = "a0000000-0000-0000-0000-0000000000a1"
INTER = "a0000000-0000-0000-0000-0000000000a2"


@pytest.fixture(autouse=True)
def _no_request_gap():
    with patch.object(ext, "MIN_GAP_SECONDS", 0):
        yield


def _account(acc_id: str, name: str, bank: str, balance: float) -> dict:
    return {
        "id": acc_id, "name": name, "marketingName": None, "type": "BANK",
        "subtype": "CHECKING_ACCOUNT", "number": "0001/12345-6", "balance": balance,
        "currencyCode": "BRL", "company": COMPANY,
        "connection": {"id": "item-1", "status": "UPDATED", "connector": {
            "id": 201, "name": bank, "bankId": "341", "imageUrl": "https://cdn.example/logo.svg",
        }},
    }


def _tx(tx_id: str, day: str, amount: float, kind: str, account: str = ITAU, **extra) -> dict:
    return {
        "id": tx_id, "date": f"{day} 01:30:00.000", "description": "PIX ENVIADO", "type": kind,
        "amount": amount, "balance": None, "currencyCode": "BRL", "category": "Transfer - PIX",
        "status": "1", "merchant": None,
        "paymentData": {"paymentMethod": "PIX", "payer": {"name": "Meppo"}, "receiver": {"name": "Fornecedor"}},
        "account": {"id": account, "name": "x" * 50}, "company": COMPANY, **extra,
    }


class FakeExt:
    """Minimal stateful stand-in for api.extcontabilidade.com.br."""

    def __init__(self, transactions: list[dict] | None = None) -> None:
        self.transactions = transactions or []
        self.calls: list[str] = []
        self.refresh_tokens = {"r0"}  # the currently valid refresh token(s)
        self.access_tokens: set[str] = set()
        self.issued = 0
        self.expire_next_get = False

    def _issue(self) -> httpx.Response:
        self.issued += 1
        access, refresh = f"a{self.issued}", f"r{self.issued}"
        self.access_tokens = {access}
        self.refresh_tokens = {refresh}
        return httpx.Response(200, json={"accessToken": access, "refreshToken": refresh})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(path)
        if path == "/auth/login":
            body = json.loads(request.content)
            if body != {"email": "dono@meppo.com", "password": "s3nha"}:
                return httpx.Response(401)
            return self._issue()
        if path == "/auth/refresh":
            if json.loads(request.content).get("refreshToken") not in self.refresh_tokens:
                return httpx.Response(401)
            return self._issue()

        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if token not in self.access_tokens or self.expire_next_get:
            self.expire_next_get = False
            return httpx.Response(401)
        if path == "/companies/me":
            return httpx.Response(200, json={"total": 1, "companies": [{"_id": COMPANY, "id": COMPANY}]})
        if path == "/bank-statements/accounts":
            return httpx.Response(200, json=[
                _account(ITAU, "Conta Corrente", "Itaú Emps", 1234.56),
                _account(INTER, "Conta PJ", "Inter Empresas", 10.0),
            ])
        if path == "/bank-statements/transactions":
            q = request.url.params
            start, offset, limit = q["startDate"], int(q["offset"]), int(q["limit"])
            rows = [t for t in self.transactions if not isinstance(t, dict) or t.get("date", "")[:10] >= start]
            return httpx.Response(200, json={
                "total": len(rows), "uncategorizedCount": 0, "transactions": rows[offset:offset + limit],
            })
        return httpx.Response(404)


def _patched(fake: FakeExt):
    transport = httpx.MockTransport(fake)

    async def fake_client(self):  # noqa: ANN001
        return httpx.AsyncClient(base_url=ext.EXT_API, transport=transport, timeout=30)

    return patch.object(ExtContabilidadeProvider, "_client", fake_client)


def _creds(**extra) -> dict:
    return {"email": "dono@meppo.com", "password_enc": encrypt("s3nha"), "company_id": COMPANY, **extra}


# ----- pure helpers -----------------------------------------------------------


def test_ext_day_without_offset_is_already_brasilia_time():
    # 01:30 BRT must stay on the 15th; reading it as UTC would move it to the 14th.
    assert ext_day("2026-09-15 01:30:00.000") == date(2026, 9, 15)
    assert ext_day("2026-09-20") == date(2026, 9, 20)


def test_ext_day_with_offset_converts_to_brasilia():
    assert ext_day("2026-09-15T02:00:00.000Z") == date(2026, 9, 14)
    assert ext_day("2026-09-15T17:03:22.000Z") == date(2026, 9, 15)
    assert ext_day("2026-09-15T01:00:00-0300") == date(2026, 9, 15)


def test_ext_day_rejects_garbage():
    assert ext_day("15/09/2026") is None
    assert ext_day(None) is None


def test_build_transaction_maps_sign_payee_and_category():
    txn = build_transaction(_tx("t1", "2026-09-15", -150.5, "DEBIT"))
    assert txn is not None
    assert (txn.type, txn.amount, txn.date) == ("debit", Decimal("150.5"), date(2026, 9, 15))
    assert txn.payee == "Fornecedor"  # receiver on a debit
    assert txn.pluggy_category == "Transfer - PIX"
    assert txn.status == "posted"
    # The ~1 KB account object is not kept on every row.
    assert txn.raw_data["account_id"] == ITAU and "account" not in txn.raw_data


def test_build_transaction_type_wins_over_amount_sign():
    txn = build_transaction(_tx("t1", "2026-09-15", 99.0, "DEBIT"))
    assert txn.type == "debit" and txn.amount == Decimal("99.0")


def test_build_transaction_prefers_merchant_then_payer_on_credit():
    merchant = build_transaction(_tx("t1", "2026-09-15", 10, "CREDIT", merchant={"businessName": "Loja SA"}))
    assert merchant.payee == "Loja SA"
    assert build_transaction(_tx("t2", "2026-09-15", 10, "CREDIT")).payee == "Meppo"


@pytest.mark.parametrize("row", [
    "not a dict",
    {"date": "2026-09-15 00:00:00.000", "amount": 1, "type": "CREDIT"},  # no id
    {"id": "x", "date": "nope", "amount": 1},
    {"id": "x", "date": "2026-09-15 00:00:00.000", "amount": "abc"},
])
def test_build_transaction_skips_malformed_rows(row):
    assert build_transaction(row) is None


# ----- connection lifecycle ---------------------------------------------------


@pytest.mark.asyncio
async def test_connect_logs_in_and_stores_credentials_encrypted():
    fake = FakeExt()
    with _patched(fake):
        conn = await ExtContabilidadeProvider().handle_oauth_callback(
            json.dumps({"email": " dono@meppo.com ", "password": "s3nha"})
        )

    assert conn.external_id == f"ext-{COMPANY}"
    assert conn.institution_name == "EXT Contabilidade"
    creds = conn.credentials
    assert "password" not in creds and decrypt(creds["password_enc"]) == "s3nha"
    assert decrypt(creds["refresh_token_enc"]) == "r1"
    assert creds["company_id"] == COMPANY

    itau, inter = conn.accounts
    assert (itau.external_id, itau.balance, itau.type, itau.currency) == (ITAU, Decimal("1234.56"), "checking", "BRL")
    assert (itau.institution_name, itau.institution_external_id) == ("Itaú Emps", "201")
    assert itau.masked_number == "3456"
    assert inter.institution_name == "Inter Empresas"


@pytest.mark.asyncio
async def test_connect_rejects_wrong_password():
    with _patched(FakeExt()), pytest.raises(SessionExpiredError):
        await ExtContabilidadeProvider().handle_oauth_callback(
            json.dumps({"email": "dono@meppo.com", "password": "errada"})
        )


@pytest.mark.asyncio
async def test_connect_requires_both_fields():
    with pytest.raises(ValueError):
        await ExtContabilidadeProvider().handle_oauth_callback(json.dumps({"email": "dono@meppo.com"}))


@pytest.mark.asyncio
async def test_refresh_rotates_and_persists_the_new_refresh_token():
    fake = FakeExt()
    with _patched(fake):
        creds = await ExtContabilidadeProvider().refresh_credentials(_creds(refresh_token_enc=encrypt("r0")))
    assert fake.calls == ["/auth/refresh"]
    assert decrypt(creds["refresh_token_enc"]) == "r1"
    assert decrypt(creds["access_token_enc"]) == "a1"


@pytest.mark.asyncio
async def test_dead_refresh_token_falls_back_to_password_login():
    # Another process already rotated it (e.g. a manual sync raced the nightly one).
    fake = FakeExt()
    with _patched(fake):
        creds = await ExtContabilidadeProvider().refresh_credentials(_creds(refresh_token_enc=encrypt("stale")))
    assert fake.calls == ["/auth/refresh", "/auth/login"]
    assert decrypt(creds["refresh_token_enc"]) == "r1"


@pytest.mark.asyncio
async def test_changed_password_surfaces_as_session_expired():
    fake = FakeExt()
    with _patched(fake), pytest.raises(SessionExpiredError):
        await ExtContabilidadeProvider().refresh_credentials(
            {"email": "dono@meppo.com", "password_enc": encrypt("old"), "refresh_token_enc": encrypt("stale")}
        )


# ----- transactions -----------------------------------------------------------


@pytest.mark.asyncio
async def test_get_transactions_paginates_filters_and_sorts():
    rows = [_tx(f"t{i:03d}", f"2026-09-{1 + i % 28:02d}", -1.0 - i, "DEBIT") for i in range(230)]
    rows.insert(5, _tx("other", "2026-09-10", -1, "DEBIT", account=INTER))  # endpoint ignored accountId
    rows.insert(7, {"id": "broken", "date": "??", "amount": 1})
    fake = FakeExt(rows)
    provider = ExtContabilidadeProvider()
    with _patched(fake):
        creds = await provider.refresh_credentials(_creds(refresh_token_enc=encrypt("r0")))
        txns = await provider.get_transactions(creds, ITAU, since=date(2026, 9, 1))

    assert len(txns) == 230
    assert "other" not in {t.external_id for t in txns}
    assert [t.date for t in txns] == sorted(t.date for t in txns)
    assert fake.calls.count("/bank-statements/transactions") == 3  # 232 rows / 100 per page


@pytest.mark.asyncio
async def test_expired_access_token_mid_run_renews_once_and_retries():
    fake = FakeExt([_tx("t1", "2026-09-15", -5, "DEBIT")])
    provider = ExtContabilidadeProvider()
    with _patched(fake):
        creds = await provider.refresh_credentials(_creds(refresh_token_enc=encrypt("r0")))
        fake.expire_next_get = True
        txns = await provider.get_transactions(creds, ITAU, since=date(2026, 9, 1))

    assert [t.external_id for t in txns] == ["t1"]
    assert fake.calls == ["/auth/refresh", "/bank-statements/transactions", "/auth/refresh", "/bank-statements/transactions"]
    # The rotated token from the mid-run renewal is what gets persisted.
    assert decrypt(creds["refresh_token_enc"]) == "r2"
