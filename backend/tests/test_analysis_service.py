import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.category import Category
from app.models.transaction import Transaction
from app.services.analysis_service import (
    ACCOUNT_TOP_CATEGORIES,
    LOOKBACK_MONTHS,
    MIN_MONTHS_FOR_RECURRING,
    TREND_MONTHS,
    _subtract_months,
    first_activity_date,
    get_accounts_analysis,
    get_category_analysis,
    get_period_analysis,
)

# A fixed period well clear of "today" so the tests do not drift with the
# calendar. The lookback window reaches back from START, not from today.
START = date(2026, 6, 1)
END = date(2026, 6, 30)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _account(
    session: AsyncSession, user_id, name="Analysis Test", is_closed=False,
    account_type="checking", **extra,
):
    account = Account(
        id=uuid.uuid4(), user_id=user_id, name=name, type=account_type,
        balance=extra.pop("balance", Decimal("0.00")), currency="BRL",
        is_closed=is_closed, **extra,
    )
    session.add(account)
    await session.commit()
    await session.refresh(account)
    return account


async def _card(session: AsyncSession, user_id, name="Cartão Teste", **extra):
    defaults = dict(
        balance=Decimal("-1500.00"), credit_limit=Decimal("5000.00"),
        statement_close_day=28, payment_due_day=5,
    )
    defaults.update(extra)
    return await _account(session, user_id, name=name, account_type="credit_card", **defaults)


async def _category(session: AsyncSession, user_id, name, **flags):
    cat = Category(
        id=uuid.uuid4(), user_id=user_id, name=name, icon="tag",
        color="#000", is_system=False, **flags,
    )
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    return cat


async def _txn(
    session: AsyncSession, user_id, account_id, amount, txn_type, txn_date,
    description="Generic", source="manual", category_id=None,
    payee=None, is_ignored=False, transfer_pair_id=None,
    effective_date=None, effective_bill_date=None,
):
    txn = Transaction(
        id=uuid.uuid4(), user_id=user_id, account_id=account_id,
        description=description, amount=Decimal(str(amount)), date=txn_date,
        effective_date=effective_date or txn_date, type=txn_type, source=source,
        currency="BRL", category_id=category_id, payee=payee, is_ignored=is_ignored,
        transfer_pair_id=transfer_pair_id, effective_bill_date=effective_bill_date,
        created_at=datetime.now(timezone.utc),
    )
    session.add(txn)
    await session.commit()
    return txn


async def _analyze(session, workspace, user, start=START, end=END):
    return await get_period_analysis(session, workspace.id, user.id, start, end)


# ---------------------------------------------------------------------------
# _subtract_months (pure)
# ---------------------------------------------------------------------------


def test_subtract_months_within_year():
    assert _subtract_months(date(2026, 6, 15), 3) == date(2026, 3, 15)


def test_subtract_months_crosses_year_boundary():
    assert _subtract_months(date(2026, 2, 10), 6) == date(2025, 8, 10)


def test_subtract_months_clamps_short_month():
    """31 March minus one month is 28 February, not an invalid date."""
    assert _subtract_months(date(2026, 3, 31), 1) == date(2026, 2, 28)


def test_subtract_months_handles_leap_year():
    assert _subtract_months(date(2024, 3, 31), 1) == date(2024, 2, 29)


# ---------------------------------------------------------------------------
# Totals and the debit/credit split
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_expenses_and_income_are_separated(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 100, "debit", date(2026, 6, 5))
    await _txn(session, test_user.id, acc.id, 40, "debit", date(2026, 6, 9))
    await _txn(session, test_user.id, acc.id, 500, "credit", date(2026, 6, 2))

    r = await _analyze(session, test_workspace, test_user)

    assert r.expenses.total == 140
    assert r.expenses.count == 2
    assert r.income.total == 500
    assert r.net == 360


@pytest.mark.asyncio
async def test_period_end_is_inclusive(session, test_user, test_workspace):
    """A transaction on the last day counts; the next day does not."""
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 10, "debit", date(2026, 6, 30))
    await _txn(session, test_user.id, acc.id, 99, "debit", date(2026, 7, 1))

    r = await _analyze(session, test_workspace, test_user)

    assert r.expenses.total == 10
    assert r.days == 30


@pytest.mark.asyncio
async def test_daily_average_uses_period_length(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 300, "debit", date(2026, 6, 10))

    r = await _analyze(session, test_workspace, test_user)

    assert r.expenses.daily_average == 10  # 300 over 30 days


@pytest.mark.asyncio
async def test_savings_rate_is_null_without_income(session, test_user, test_workspace):
    """Dividing by zero income would be a crash or a meaningless infinity."""
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 50, "debit", date(2026, 6, 4))

    r = await _analyze(session, test_workspace, test_user)

    assert r.savings_rate is None


# ---------------------------------------------------------------------------
# Exclusions — these must agree with the dashboard's definition
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_opening_balance_is_not_income(session, test_user, test_workspace):
    """Seed rows exist to make an account start at the right number."""
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 9999, "credit", date(2026, 6, 1),
               source="opening_balance")

    r = await _analyze(session, test_workspace, test_user)

    assert r.income.total == 0
    assert r.income.count == 0


@pytest.mark.asyncio
async def test_paired_transfers_are_excluded(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    pair = uuid.uuid4()
    await _txn(session, test_user.id, acc.id, 200, "debit", date(2026, 6, 7),
               transfer_pair_id=pair)

    r = await _analyze(session, test_workspace, test_user)

    assert r.expenses.total == 0


@pytest.mark.asyncio
async def test_ignored_transactions_and_categories_are_excluded(
    session, test_user, test_workspace
):
    acc = await _account(session, test_user.id)
    ignored_cat = await _category(session, test_user.id, "Hidden", is_ignored=True)
    transfer_cat = await _category(session, test_user.id, "Invest", treat_as_transfer=True)

    await _txn(session, test_user.id, acc.id, 11, "debit", date(2026, 6, 3), is_ignored=True)
    await _txn(session, test_user.id, acc.id, 22, "debit", date(2026, 6, 4),
               category_id=ignored_cat.id)
    await _txn(session, test_user.id, acc.id, 33, "debit", date(2026, 6, 5),
               category_id=transfer_cat.id)
    await _txn(session, test_user.id, acc.id, 44, "debit", date(2026, 6, 6))

    r = await _analyze(session, test_workspace, test_user)

    assert r.expenses.total == 44


@pytest.mark.asyncio
async def test_closed_accounts_are_excluded(session, test_user, test_workspace):
    closed = await _account(session, test_user.id, "Closed", is_closed=True)
    await _txn(session, test_user.id, closed.id, 77, "debit", date(2026, 6, 8))

    r = await _analyze(session, test_workspace, test_user)

    assert r.expenses.total == 0


# ---------------------------------------------------------------------------
# Category breakdown
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_category_shares_sum_to_one(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    food = await _category(session, test_user.id, "Food")
    rent = await _category(session, test_user.id, "Rent")
    await _txn(session, test_user.id, acc.id, 250, "debit", date(2026, 6, 3), category_id=food.id)
    await _txn(session, test_user.id, acc.id, 750, "debit", date(2026, 6, 4), category_id=rent.id)

    r = await _analyze(session, test_workspace, test_user)

    assert sum(c.share for c in r.expenses.categories) == pytest.approx(1.0)
    assert r.expenses.categories[0].name == "Rent"      # ordered by size
    assert r.expenses.categories[0].share == pytest.approx(0.75)


@pytest.mark.asyncio
async def test_uncategorized_spend_is_reported_not_dropped(
    session, test_user, test_workspace
):
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 60, "debit", date(2026, 6, 3))

    r = await _analyze(session, test_workspace, test_user)

    uncategorized = [c for c in r.expenses.categories if c.category_id is None]
    assert len(uncategorized) == 1
    assert uncategorized[0].total == 60


# ---------------------------------------------------------------------------
# Payee grouping — payee_id is sparse, so the fallback chain matters
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_payees_group_by_description_when_payee_is_absent(
    session, test_user, test_workspace
):
    acc = await _account(session, test_user.id)
    for day in (3, 10, 20):
        await _txn(session, test_user.id, acc.id, 30, "debit", date(2026, 6, day),
                   description="NETFLIX.COM")

    r = await _analyze(session, test_workspace, test_user)

    netflix = [p for p in r.expenses.payees if "NETFLIX" in p.label.upper()]
    assert len(netflix) == 1
    assert netflix[0].total == 90
    assert netflix[0].count == 3


@pytest.mark.asyncio
async def test_payee_grouping_is_case_insensitive(session, test_user, test_workspace):
    """Different import sources spell the same merchant differently."""
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 10, "debit", date(2026, 6, 3), payee="Uber")
    await _txn(session, test_user.id, acc.id, 15, "debit", date(2026, 6, 4), payee="UBER")

    r = await _analyze(session, test_workspace, test_user)

    assert len(r.expenses.payees) == 1
    assert r.expenses.payees[0].total == 25


@pytest.mark.asyncio
async def test_payee_field_wins_over_description(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 10, "debit", date(2026, 6, 3),
               description="PIX 8891 REF 001", payee="Padaria")
    await _txn(session, test_user.id, acc.id, 20, "debit", date(2026, 6, 4),
               description="PIX 8891 REF 002", payee="Padaria")

    r = await _analyze(session, test_workspace, test_user)

    assert len(r.expenses.payees) == 1
    assert r.expenses.payees[0].label == "Padaria"
    assert r.expenses.payees[0].total == 30


# ---------------------------------------------------------------------------
# Recurrence detection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recurring_needs_the_minimum_number_of_months(
    session, test_user, test_workspace
):
    """Appearing in enough distinct months is what makes a charge recurring."""
    acc = await _account(session, test_user.id)

    # Present in the period plus the preceding months — enough to qualify.
    for offset in range(MIN_MONTHS_FOR_RECURRING):
        await _txn(session, test_user.id, acc.id, 50, "debit",
                   _subtract_months(date(2026, 6, 15), offset), description="SPOTIFY")

    r = await _analyze(session, test_workspace, test_user)

    spotify = [p for p in r.expenses.payees if p.label == "SPOTIFY"]
    assert spotify and spotify[0].recurring is True


@pytest.mark.asyncio
async def test_one_off_purchase_is_not_recurring(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 1200, "debit", date(2026, 6, 12),
               description="LOJA DE MOVEIS")

    r = await _analyze(session, test_workspace, test_user)

    assert r.expenses.payees[0].recurring is False
    assert r.expenses.recurrence.one_off_total == 1200
    assert r.expenses.recurrence.recurring_total == 0


@pytest.mark.asyncio
async def test_repeats_within_one_month_are_not_recurring(
    session, test_user, test_workspace
):
    """Three trips to the same shop in one month is not a subscription."""
    acc = await _account(session, test_user.id)
    for day in (5, 12, 19):
        await _txn(session, test_user.id, acc.id, 40, "debit", date(2026, 6, day),
                   description="SUPERMERCADO")

    r = await _analyze(session, test_workspace, test_user)

    assert r.expenses.recurrence.recurring_total == 0
    assert r.expenses.recurrence.one_off_total == 120


@pytest.mark.asyncio
async def test_recurrence_split_reconciles_with_the_total(
    session, test_user, test_workspace
):
    """Every real expense lands on exactly one side of the split."""
    acc = await _account(session, test_user.id)
    for offset in range(MIN_MONTHS_FOR_RECURRING):
        await _txn(session, test_user.id, acc.id, 100, "debit",
                   _subtract_months(date(2026, 6, 10), offset), description="ALUGUEL")
    await _txn(session, test_user.id, acc.id, 70, "debit", date(2026, 6, 20),
               description="COMPRA AVULSA")

    r = await _analyze(session, test_workspace, test_user)
    split = r.expenses.recurrence

    assert split.recurring_total + split.one_off_total == pytest.approx(r.expenses.total)
    assert split.recurring_count + split.one_off_count == r.expenses.count


@pytest.mark.asyncio
async def test_activity_outside_the_lookback_does_not_make_it_recurring(
    session, test_user, test_workspace
):
    """A subscription cancelled long ago must stop counting as recurring."""
    acc = await _account(session, test_user.id)
    old = _subtract_months(START, LOOKBACK_MONTHS + 2)
    for offset in range(MIN_MONTHS_FOR_RECURRING):
        await _txn(session, test_user.id, acc.id, 25, "debit",
                   _subtract_months(old, offset), description="REVISTA ANTIGA")
    await _txn(session, test_user.id, acc.id, 25, "debit", date(2026, 6, 6),
               description="REVISTA ANTIGA")

    r = await _analyze(session, test_workspace, test_user)

    magazine = [p for p in r.expenses.payees if p.label == "REVISTA ANTIGA"]
    assert magazine and magazine[0].recurring is False


@pytest.mark.asyncio
async def test_income_recurrence_is_tracked_separately(session, test_user, test_workspace):
    """A regular salary is recurring income, not lumped in with spending."""
    acc = await _account(session, test_user.id)
    for offset in range(MIN_MONTHS_FOR_RECURRING):
        await _txn(session, test_user.id, acc.id, 5000, "credit",
                   _subtract_months(date(2026, 6, 5), offset), description="SALARIO")
    await _txn(session, test_user.id, acc.id, 300, "credit", date(2026, 6, 18),
               description="VENDA AVULSA")

    r = await _analyze(session, test_workspace, test_user)

    assert r.income.recurrence.recurring_total == 5000
    assert r.income.recurrence.one_off_total == 300
    assert r.expenses.recurrence.recurring_total == 0


# ---------------------------------------------------------------------------
# Largest transactions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_largest_transactions_are_ordered(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    for amount in (10, 900, 250):
        await _txn(session, test_user.id, acc.id, amount, "debit", date(2026, 6, 11),
                   description=f"COMPRA {amount}")

    r = await _analyze(session, test_workspace, test_user)

    assert [t.amount for t in r.expenses.largest] == [900, 250, 10]


@pytest.mark.asyncio
async def test_reversed_range_is_normalized(session, test_user, test_workspace):
    """Start after end should not silently return an empty period."""
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 80, "debit", date(2026, 6, 15))

    r = await _analyze(session, test_workspace, test_user, start=END, end=START)

    assert r.expenses.total == 80
    assert r.start == START.isoformat()


# ---------------------------------------------------------------------------
# Per-account breakdown (get_accounts_analysis)
# ---------------------------------------------------------------------------


async def _analyze_accounts(session, workspace, user, start=START, end=END, account_ids=None):
    return await get_accounts_analysis(session, workspace.id, user.id, start, end, account_ids)


@pytest.mark.asyncio
async def test_accounts_are_split_and_ranked_by_spend(session, test_user, test_workspace):
    acc_a = await _account(session, test_user.id, name="Conta A")
    acc_b = await _account(session, test_user.id, name="Conta B")
    await _txn(session, test_user.id, acc_a.id, 300, "debit", date(2026, 6, 5))
    await _txn(session, test_user.id, acc_b.id, 100, "debit", date(2026, 6, 9))
    await _txn(session, test_user.id, acc_b.id, 50, "credit", date(2026, 6, 10))

    r = await _analyze_accounts(session, test_workspace, test_user)

    assert r.total_expenses == 400
    assert r.total_income == 50
    assert [a.name for a in r.accounts] == ["Conta A", "Conta B"]
    assert r.accounts[0].expense_share == pytest.approx(0.75)
    assert r.accounts[1].expense_share == pytest.approx(0.25)
    assert r.accounts[1].income_total == 50
    assert r.accounts[1].income_count == 1


@pytest.mark.asyncio
async def test_card_vs_non_card_split(session, test_user, test_workspace):
    card = await _card(session, test_user.id)
    checking = await _account(session, test_user.id)
    await _txn(session, test_user.id, card.id, 150, "debit", date(2026, 6, 5))
    await _txn(session, test_user.id, checking.id, 50, "debit", date(2026, 6, 6))

    r = await _analyze_accounts(session, test_workspace, test_user)

    assert r.card_expenses == 150
    assert r.card_expense_share == pytest.approx(0.75)


@pytest.mark.asyncio
async def test_manual_card_utilization_comes_from_transactions(session, test_user, test_workspace):
    """A manual card's `accounts.balance` is only a creation-time seed; its
    real debt is the signed transaction sum (mirrors serialize_account)."""
    card = await _card(session, test_user.id)  # limit 5000, seed balance -1500 (ignored)
    checking = await _account(session, test_user.id)
    await _txn(session, test_user.id, card.id, 1500, "debit", date(2026, 6, 5))
    await _txn(session, test_user.id, checking.id, 5, "debit", date(2026, 6, 5))

    r = await _analyze_accounts(session, test_workspace, test_user)

    by_id = {a.account_id: a for a in r.accounts}
    cc = by_id[str(card.id)]
    assert cc.credit_limit == 5000
    assert cc.available_credit == 3500
    assert cc.utilization == pytest.approx(0.3)
    assert cc.next_close_date is not None
    assert cc.next_due_date is not None

    plain = by_id[str(checking.id)]
    assert plain.credit_limit is None
    assert plain.utilization is None
    assert plain.next_due_date is None


@pytest.mark.asyncio
async def test_connected_card_debt_is_stored_positive(session, test_user, test_workspace):
    """Providers report card debt as a POSITIVE balance; the breakdown must
    negate it (like serialize_account) before computing utilization."""
    from app.models.bank_connection import BankConnection

    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id,
        provider="pluggy", external_id="item-1", institution_name="Banco Teste",
    )
    session.add(conn)
    await session.commit()
    card = await _card(
        session, test_user.id, balance=Decimal("1500.00"), connection_id=conn.id,
    )
    await _txn(session, test_user.id, card.id, 10, "debit", date(2026, 6, 5))

    r = await _analyze_accounts(session, test_workspace, test_user)

    cc = r.accounts[0]
    assert cc.available_credit == 3500
    assert cc.utilization == pytest.approx(0.3)
    assert cc.institution_name == "Banco Teste"


@pytest.mark.asyncio
async def test_card_without_limit_has_no_utilization(session, test_user, test_workspace):
    card = await _card(session, test_user.id, credit_limit=None)
    await _txn(session, test_user.id, card.id, 10, "debit", date(2026, 6, 5))

    r = await _analyze_accounts(session, test_workspace, test_user)

    assert r.accounts[0].credit_limit is None
    assert r.accounts[0].available_credit is None
    assert r.accounts[0].utilization is None


@pytest.mark.asyncio
async def test_account_categories_roll_the_tail_into_other(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    # 7 categories with strictly decreasing spend: 70, 60, ... 10.
    for i in range(7):
        cat = await _category(session, test_user.id, f"Cat {i}")
        await _txn(session, test_user.id, acc.id, 70 - i * 10, "debit",
                   date(2026, 6, 5), category_id=cat.id)

    r = await _analyze_accounts(session, test_workspace, test_user)

    a = r.accounts[0]
    assert len(a.categories) == ACCOUNT_TOP_CATEGORIES
    assert [c.total for c in a.categories] == [70, 60, 50, 40, 30]
    assert a.other_categories_total == 30  # 20 + 10
    assert a.categories[0].share == pytest.approx(70 / 280)


@pytest.mark.asyncio
async def test_uncategorized_account_spend_is_reported(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 42, "debit", date(2026, 6, 5))

    r = await _analyze_accounts(session, test_workspace, test_user)

    assert r.accounts[0].categories[0].category_id is None
    assert r.accounts[0].categories[0].total == 42


@pytest.mark.asyncio
async def test_monthly_trend_covers_the_trailing_window(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 100, "debit", date(2026, 6, 5))
    await _txn(session, test_user.id, acc.id, 40, "debit", date(2026, 4, 20))
    # Outside the trailing window ending in June — must not appear.
    await _txn(session, test_user.id, acc.id, 999, "debit", date(2025, 10, 5))

    r = await _analyze_accounts(session, test_workspace, test_user)

    monthly = r.accounts[0].monthly
    assert len(monthly) == TREND_MONTHS
    assert monthly[0].month == "2026-01"
    assert monthly[-1].month == "2026-06"
    by_month = {p.month: p.total for p in monthly}
    assert by_month["2026-06"] == 100
    assert by_month["2026-04"] == 40
    assert by_month["2026-01"] == 0


@pytest.mark.asyncio
async def test_accounts_with_only_excluded_rows_do_not_appear(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    pair = uuid.uuid4()
    await _txn(session, test_user.id, acc.id, 500, "debit", date(2026, 6, 5),
               transfer_pair_id=pair)
    await _txn(session, test_user.id, acc.id, 900, "credit", date(2026, 6, 1),
               source="opening_balance")

    r = await _analyze_accounts(session, test_workspace, test_user)

    assert r.accounts == []
    assert r.total_expenses == 0


@pytest.mark.asyncio
async def test_closed_accounts_are_excluded_from_breakdown(session, test_user, test_workspace):
    acc = await _account(session, test_user.id, is_closed=True)
    await _txn(session, test_user.id, acc.id, 100, "debit", date(2026, 6, 5))

    r = await _analyze_accounts(session, test_workspace, test_user)

    assert r.accounts == []


@pytest.mark.asyncio
async def test_account_ids_filter_scopes_everything(session, test_user, test_workspace):
    acc_a = await _account(session, test_user.id, name="Conta A")
    acc_b = await _account(session, test_user.id, name="Conta B")
    await _txn(session, test_user.id, acc_a.id, 300, "debit", date(2026, 6, 5))
    await _txn(session, test_user.id, acc_b.id, 100, "debit", date(2026, 6, 9))

    r = await _analyze_accounts(session, test_workspace, test_user, account_ids=[acc_b.id])

    assert [a.name for a in r.accounts] == ["Conta B"]
    assert r.total_expenses == 100
    assert r.accounts[0].expense_share == 1.0


@pytest.mark.asyncio
async def test_breakdown_totals_reconcile_with_period_analysis(session, test_user, test_workspace):
    card = await _card(session, test_user.id)
    checking = await _account(session, test_user.id)
    await _txn(session, test_user.id, card.id, 150, "debit", date(2026, 6, 5))
    await _txn(session, test_user.id, checking.id, 50, "debit", date(2026, 6, 6))
    await _txn(session, test_user.id, checking.id, 700, "credit", date(2026, 6, 1))

    by_account = await _analyze_accounts(session, test_workspace, test_user)
    by_period = await _analyze(session, test_workspace, test_user)

    assert by_account.total_expenses == by_period.expenses.total
    assert by_account.total_income == by_period.income.total


@pytest.mark.asyncio
async def test_mixed_sign_debits_do_not_net_at_account_level(session, test_user, test_workspace):
    """A refund stored as a negative debit must not shrink the account's
    header total below what its category segments add up to."""
    acc = await _account(session, test_user.id)
    food = await _category(session, test_user.id, "Food")
    refunds = await _category(session, test_user.id, "Refunds")
    await _txn(session, test_user.id, acc.id, 100, "debit", date(2026, 6, 5), category_id=food.id)
    await _txn(session, test_user.id, acc.id, -30, "debit", date(2026, 6, 9), category_id=refunds.id)

    r = await _analyze_accounts(session, test_workspace, test_user)
    p = await _analyze(session, test_workspace, test_user)

    a = r.accounts[0]
    assert a.expense_total == 130
    assert sorted(c.total for c in a.categories) == [30, 100]
    assert a.other_categories_total == 0
    assert a.categories[0].share == pytest.approx(100 / 130)
    # Still reconciles with the category view, which abs's per category too.
    assert r.total_expenses == p.expenses.total == 130


@pytest.mark.asyncio
async def test_effective_bill_date_override_decides_the_period(session, test_user, test_workspace):
    """The manual invoice override must win over the purchase date in every
    query (main rows, categories, trend) — the issue #232 bug class."""
    card = await _card(session, test_user.id)
    # May purchase whose invoice lands in June: counts in June.
    await _txn(session, test_user.id, card.id, 100, "debit", date(2026, 5, 20),
               effective_bill_date=date(2026, 6, 5))
    # June purchase whose invoice lands in July: not in June.
    await _txn(session, test_user.id, card.id, 40, "debit", date(2026, 6, 20),
               effective_bill_date=date(2026, 7, 5))

    r = await _analyze_accounts(session, test_workspace, test_user)
    p = await _analyze(session, test_workspace, test_user)

    assert r.total_expenses == 100
    assert p.expenses.total == 100
    a = r.accounts[0]
    assert a.categories[0].total == 100
    assert {pt.month: pt.total for pt in a.monthly}["2026-06"] == 100


@pytest.mark.asyncio
async def test_accrual_mode_buckets_by_effective_date(session, test_user, test_workspace):
    """In accrual mode a card purchase lands in its bill's month, not the
    purchase month."""
    from app.services import admin_service

    await admin_service.set_app_setting(session, "credit_card_accounting_mode", "accrual")
    try:
        card = await _card(session, test_user.id)
        await _txn(session, test_user.id, card.id, 80, "debit", date(2026, 5, 30),
                   effective_date=date(2026, 6, 5))

        r = await _analyze_accounts(session, test_workspace, test_user)

        assert r.total_expenses == 80
        assert {pt.month: pt.total for pt in r.accounts[0].monthly}["2026-06"] == 80
    finally:
        await admin_service.set_app_setting(session, "credit_card_accounting_mode", "cash")


@pytest.mark.asyncio
async def test_other_workspaces_do_not_leak(session, test_user, test_workspace):
    """Tenant isolation: another workspace's accounts and spend must never
    appear, in neither the account list nor the totals."""
    import bcrypt as _bcrypt

    from app.models.user import User
    from app.models.workspace import Workspace, WorkspaceMember

    other = User(
        id=uuid.uuid4(), email="other@example.com",
        hashed_password=_bcrypt.hashpw(b"x", _bcrypt.gensalt()).decode(),
        is_active=True, is_superuser=False, is_verified=True,
    )
    session.add(other)
    await session.flush()
    other_ws = Workspace(
        id=uuid.uuid4(), name="Outro", kind="personal",
        created_by_user_id=other.id, default_currency="BRL", locale="pt-BR",
    )
    session.add(other_ws)
    await session.flush()
    session.add(WorkspaceMember(
        id=uuid.uuid4(), workspace_id=other_ws.id, user_id=other.id, role="owner",
    ))
    await session.commit()

    other_acc = await _account(session, other.id, name="Conta Alheia")
    await _txn(session, other.id, other_acc.id, 777, "debit", date(2026, 6, 5))

    mine = await _account(session, test_user.id, name="Minha Conta")
    await _txn(session, test_user.id, mine.id, 50, "debit", date(2026, 6, 5))

    r = await _analyze_accounts(session, test_workspace, test_user)

    assert [a.name for a in r.accounts] == ["Minha Conta"]
    assert r.total_expenses == 50
    assert sum(pt.total for pt in r.accounts[0].monthly) == 50


@pytest.mark.asyncio
async def test_trend_window_crosses_the_year_boundary(session, test_user, test_workspace):
    """Labels must roll 2025-12 → 2026-01 correctly, and the window edge is
    exact: the first day of the first window month is in, the day before is out."""
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 25, "debit", date(2026, 2, 10))
    await _txn(session, test_user.id, acc.id, 60, "debit", date(2025, 9, 1))    # first window day
    await _txn(session, test_user.id, acc.id, 999, "debit", date(2025, 8, 31))  # just outside

    r = await _analyze_accounts(
        session, test_workspace, test_user,
        start=date(2026, 2, 1), end=date(2026, 2, 28),
    )

    monthly = r.accounts[0].monthly
    assert [pt.month for pt in monthly] == [
        "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02",
    ]
    by_month = {pt.month: pt.total for pt in monthly}
    assert by_month["2025-09"] == 60
    assert by_month["2026-02"] == 25
    assert sum(pt.total for pt in monthly) == 85



# ---------------------------------------------------------------------------
# Category drill-down
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_category_total_matches_the_period_view(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    donations = await _category(session, test_user.id, "Donations")
    other = await _category(session, test_user.id, "Other")
    await _txn(session, test_user.id, acc.id, 5, "debit", date(2026, 6, 3), category_id=donations.id)
    await _txn(session, test_user.id, acc.id, 3, "debit", date(2026, 6, 20), category_id=donations.id)
    await _txn(session, test_user.id, acc.id, 99, "debit", date(2026, 6, 4), category_id=other.id)

    r = await get_category_analysis(
        session, test_workspace.id, test_user.id, donations.id, START, END
    )
    period = await _analyze(session, test_workspace, test_user)

    assert r.name == "Donations"
    assert r.total == 8
    assert r.count == 2
    row = next(c for c in period.expenses.categories if c.category_id == str(donations.id))
    assert r.total == row.total


@pytest.mark.asyncio
async def test_category_reports_lifetime_total_beyond_the_range(
    session, test_user, test_workspace
):
    acc = await _account(session, test_user.id)
    cat = await _category(session, test_user.id, "Donations")
    await _txn(session, test_user.id, acc.id, 10, "debit", date(2025, 11, 2), category_id=cat.id)
    await _txn(session, test_user.id, acc.id, 4, "debit", date(2026, 6, 8), category_id=cat.id)

    r = await get_category_analysis(session, test_workspace.id, test_user.id, cat.id, START, END)

    assert r.total == 4
    assert r.all_time_total == 14
    assert r.all_time_count == 2
    assert r.first_date == "2025-11-02"


@pytest.mark.asyncio
async def test_category_monthly_series_starts_at_first_activity(
    session, test_user, test_workspace
):
    """A wide range doesn't pad the series (and dilute the average) with
    months before the category was ever used; gaps after that stay as zeros."""
    acc = await _account(session, test_user.id)
    cat = await _category(session, test_user.id, "Gaming")
    await _txn(session, test_user.id, acc.id, 30, "debit", date(2026, 3, 15), category_id=cat.id)
    await _txn(session, test_user.id, acc.id, 30, "debit", date(2026, 5, 2), category_id=cat.id)

    r = await get_category_analysis(
        session, test_workspace.id, test_user.id, cat.id, date(2020, 1, 1), END
    )

    assert [p.month for p in r.monthly] == ["2026-03", "2026-04", "2026-05", "2026-06"]
    assert [p.total for p in r.monthly] == [30, 0, 30, 0]
    assert r.monthly_average == 15


@pytest.mark.asyncio
async def test_uncategorized_drill_down(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    cat = await _category(session, test_user.id, "Food")
    await _txn(session, test_user.id, acc.id, 7, "debit", date(2026, 6, 3))
    await _txn(session, test_user.id, acc.id, 50, "debit", date(2026, 6, 3), category_id=cat.id)

    r = await get_category_analysis(session, test_workspace.id, test_user.id, None, START, END)

    assert r.category_id is None
    assert r.total == 7


@pytest.mark.asyncio
async def test_category_payees_and_type_split(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    cat = await _category(session, test_user.id, "Gambling")
    await _txn(session, test_user.id, acc.id, 20, "debit", date(2026, 6, 3),
               description="BET A", category_id=cat.id)
    await _txn(session, test_user.id, acc.id, 15, "debit", date(2026, 6, 4),
               description="bet a", category_id=cat.id)
    await _txn(session, test_user.id, acc.id, 5, "debit", date(2026, 6, 5),
               description="BET B", category_id=cat.id)
    await _txn(session, test_user.id, acc.id, 100, "credit", date(2026, 6, 6),
               description="BET A", category_id=cat.id)

    spent = await get_category_analysis(session, test_workspace.id, test_user.id, cat.id, START, END)
    won = await get_category_analysis(
        session, test_workspace.id, test_user.id, cat.id, START, END, tx_type="credit"
    )

    assert spent.total == 40
    assert [(p.label.upper(), p.total) for p in spent.payees] == [("BET A", 35), ("BET B", 5)]
    assert spent.largest[0].amount == 20
    assert won.total == 100


@pytest.mark.asyncio
async def test_unknown_category_returns_none(session, test_user, test_workspace):
    r = await get_category_analysis(
        session, test_workspace.id, test_user.id, uuid.uuid4(), START, END
    )
    assert r is None


@pytest.mark.asyncio
async def test_first_activity_date_skips_opening_balance(session, test_user, test_workspace):
    acc = await _account(session, test_user.id)
    await _txn(session, test_user.id, acc.id, 1000, "credit", date(2024, 1, 1), source="opening_balance")
    await _txn(session, test_user.id, acc.id, 10, "debit", date(2025, 3, 9))

    assert await first_activity_date(session, test_workspace.id) == date(2025, 3, 9)
