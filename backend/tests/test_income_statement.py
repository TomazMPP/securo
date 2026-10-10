"""Income statement (DRE) built from the business categories."""
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.account import Account
from app.models.category import Category
from app.models.transaction import Transaction
from app.models.user import User
from app.services import workspace_service
from app.services.income_statement_service import get_income_statement


async def _business(session, user):
    ws = await workspace_service.create_workspace(
        session, name="Meppo", creator=user, kind="business", locale="pt-BR", self_membership=True,
    )
    await session.commit()
    account = Account(
        id=uuid.uuid4(), user_id=user.id, workspace_id=ws.id, name="Inter PJ",
        type="checking", balance=Decimal("0"), currency="BRL",
    )
    session.add(account)
    await session.commit()
    cats = {
        c.name: c for c in (await session.execute(
            select(Category).where(Category.workspace_id == ws.id)
        )).scalars().all()
    }
    return ws, account, cats


def _tx(user, ws, account, category, amount, day, kind, **extra):
    return Transaction(
        id=uuid.uuid4(), user_id=user.id, workspace_id=ws.id, account_id=account.id,
        category_id=category.id if category else None, description="x",
        amount=Decimal(amount), date=day, type=kind, source="manual", currency="BRL",
        created_at=datetime.now(timezone.utc), **extra,
    )


def _section(statement, key):
    return next(s for s in statement.sections if s.key == key)


@pytest.mark.asyncio
async def test_statement_lines_subtotals_and_margin(session, test_user: User):
    ws, acc, c = await _business(session, test_user)
    sep, oct_ = date(2026, 9, 10), date(2026, 10, 5)
    session.add_all([
        _tx(test_user, ws, acc, c["Receita de serviços"], "10000", sep, "credit"),
        _tx(test_user, ws, acc, c["Receita de serviços"], "500", sep, "debit"),  # refund nets out
        _tx(test_user, ws, acc, c["Impostos sobre faturamento"], "600", sep, "debit"),
        _tx(test_user, ws, acc, c["Prestadores e fornecedores"], "2000", sep, "debit"),
        _tx(test_user, ws, acc, c["Pró-labore"], "1500", sep, "debit"),
        _tx(test_user, ws, acc, c["Contabilidade"], "170", sep, "debit"),
        _tx(test_user, ws, acc, c["Tarifas bancárias"], "30", sep, "debit"),
        _tx(test_user, ws, acc, c["Rendimentos financeiros"], "100", sep, "credit"),
        _tx(test_user, ws, acc, None, "200", sep, "debit"),  # uncategorized
        _tx(test_user, ws, acc, c["Distribuição de lucros"], "3000", sep, "debit"),
        _tx(test_user, ws, acc, c["Transferências"], "999", sep, "debit"),  # own accounts
        _tx(test_user, ws, acc, c["Contabilidade"], "50", sep, "debit", is_ignored=True),
        _tx(test_user, ws, acc, c["Receita de serviços"], "4000", oct_, "credit"),
        _tx(test_user, ws, acc, c["Receita de serviços"], "777", date(2026, 8, 31), "credit"),  # outside
    ])
    await session.commit()

    st = await get_income_statement(session, ws.id, test_user.id, date(2026, 9, 1), date(2026, 10, 31))

    assert st.months == ["2026-09", "2026-10"]
    assert _section(st, "revenue").months == [9500.0, 4000.0]
    assert _section(st, "deductions").total == -600.0
    assert _section(st, "costs").total == -2000.0
    opex = _section(st, "operating_expenses")
    assert opex.total == -1670.0
    assert {ln.name for ln in opex.lines} == {"Pró-labore", "Contabilidade"}
    assert _section(st, "financial").total == 70.0
    unclassified = _section(st, "unclassified")
    assert unclassified.total == -200.0 and unclassified.lines[0].category_id is None

    sub = st.subtotals
    assert sub.net_revenue.months == [8900.0, 4000.0]
    assert sub.gross_profit.months == [6900.0, 4000.0]
    assert sub.operating_result.months == [5230.0, 4000.0]
    assert sub.net_income.months == [5100.0, 4000.0]
    assert st.margins == [round(5100 / 9500, 4), 1.0]
    assert st.margin == round(9100 / 13500, 4)

    # Equity movements are shown but stay out of net income; transfers between
    # own accounts appear nowhere.
    assert _section(st, "owners").total == -3000.0
    names = {ln.name for s in st.sections for ln in s.lines}
    assert "Transferências" not in names


@pytest.mark.asyncio
async def test_group_without_section_is_unclassified(session, test_user: User):
    ws, acc, c = await _business(session, test_user)
    other = c["Outros"]  # group "Outros" has no dre_section
    session.add(_tx(test_user, ws, acc, other, "80", date(2026, 9, 3), "debit"))
    await session.commit()

    st = await get_income_statement(session, ws.id, test_user.id, date(2026, 9, 1), date(2026, 9, 30))
    assert _section(st, "unclassified").total == -80.0
    assert st.subtotals.net_income.total == -80.0
    assert st.margin is None  # no revenue


@pytest.mark.asyncio
async def test_endpoint_is_business_only(client, auth_headers, test_workspace, session, test_user: User):
    personal = await client.get(
        "/api/income-statement", headers={**auth_headers, "X-Workspace-Id": str(test_workspace.id)},
    )
    assert personal.status_code == 404

    ws, _, _ = await _business(session, test_user)
    business = await client.get(
        "/api/income-statement?start=2026-01-01&end=2026-03-31",
        headers={**auth_headers, "X-Workspace-Id": str(ws.id)},
    )
    assert business.status_code == 200, business.text
    body = business.json()
    assert body["months"] == ["2026-01", "2026-02", "2026-03"]
    assert [s["key"] for s in body["sections"]] == [
        "revenue", "deductions", "costs", "operating_expenses", "financial", "unclassified", "owners",
    ]
