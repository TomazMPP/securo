import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.category import Category
from app.models.transaction import Transaction
from app.services.analysis_service import (
    LOOKBACK_MONTHS,
    MIN_MONTHS_FOR_RECURRING,
    _subtract_months,
    get_period_analysis,
)

# A fixed period well clear of "today" so the tests do not drift with the
# calendar. The lookback window reaches back from START, not from today.
START = date(2026, 6, 1)
END = date(2026, 6, 30)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _account(session: AsyncSession, user_id, name="Analysis Test", is_closed=False):
    account = Account(
        id=uuid.uuid4(), user_id=user_id, name=name, type="checking",
        balance=Decimal("0.00"), currency="BRL", is_closed=is_closed,
    )
    session.add(account)
    await session.commit()
    await session.refresh(account)
    return account


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
):
    txn = Transaction(
        id=uuid.uuid4(), user_id=user_id, account_id=account_id,
        description=description, amount=Decimal(str(amount)), date=txn_date,
        effective_date=txn_date, type=txn_type, source=source, currency="BRL",
        category_id=category_id, payee=payee, is_ignored=is_ignored,
        transfer_pair_id=transfer_pair_id,
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
