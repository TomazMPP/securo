from typing import Optional

from pydantic import BaseModel


class AnalysisCategory(BaseModel):
    category_id: Optional[str]
    name: str
    icon: str
    color: str
    group_name: Optional[str] = None
    total: float
    share: float          # 0..1 of the side's total
    count: int


class AnalysisPayee(BaseModel):
    key: str
    label: str
    total: float
    share: float
    count: int
    recurring: bool


class AnalysisTransaction(BaseModel):
    id: str
    date: str             # ISO
    description: str
    payee: Optional[str] = None
    category_name: Optional[str] = None
    amount: float


class RecurringItem(BaseModel):
    label: str
    total: float
    count: int
    months_seen: int      # distinct months in the lookback window


class RecurrenceSplit(BaseModel):
    recurring_total: float
    one_off_total: float
    recurring_count: int
    one_off_count: int
    items: list[RecurringItem]
    # How recurrence was decided, so the UI can state the rule rather than
    # presenting the split as ground truth.
    lookback_months: int
    min_months: int


class AnalysisSide(BaseModel):
    total: float
    count: int
    daily_average: float
    categories: list[AnalysisCategory]
    payees: list[AnalysisPayee]
    largest: list[AnalysisTransaction]
    recurrence: RecurrenceSplit


class PeriodAnalysis(BaseModel):
    start: str
    end: str               # inclusive, ISO
    days: int
    currency: str
    expenses: AnalysisSide
    income: AnalysisSide
    net: float
    savings_rate: Optional[float] = None   # net / income, null when no income


class AccountMonthPoint(BaseModel):
    month: str            # "2026-02", oldest first in the list
    total: float


class AnalysisAccount(BaseModel):
    account_id: str
    name: str
    type: str             # checking, savings, credit_card, ...
    masked_number: Optional[str] = None
    card_brand: Optional[str] = None
    institution_name: Optional[str] = None
    institution_logo_url: Optional[str] = None
    account_currency: str
    expense_total: float
    expense_share: float  # 0..1 of the period's expenses across all accounts
    expense_count: int
    income_total: float
    income_count: int
    categories: list[AnalysisCategory]  # top expense categories inside this account
    other_categories_total: float       # expense beyond the listed categories
    monthly: list[AccountMonthPoint]    # trailing expense trend
    # Credit-card only; null for every other account type.
    credit_limit: Optional[float] = None
    available_credit: Optional[float] = None
    utilization: Optional[float] = None  # 0..1, utilized / limit
    next_close_date: Optional[str] = None  # ISO
    next_due_date: Optional[str] = None    # ISO


class AccountsAnalysis(BaseModel):
    start: str
    end: str               # inclusive, ISO
    days: int
    currency: str
    total_expenses: float
    total_income: float
    card_expenses: float
    card_expense_share: float   # 0..1 of total_expenses that went through credit cards
    trend_months: int
    accounts: list[AnalysisAccount]


class CategoryAnalysis(BaseModel):
    """One category drilled into: how much, when, and with whom."""
    category_id: Optional[str]   # null = uncategorized
    name: str
    icon: str
    color: str
    group_name: Optional[str] = None
    type: str                    # "debit" or "credit"
    start: str
    end: str                     # inclusive, ISO
    currency: str
    total: float
    count: int
    monthly_average: float       # total / months in the range
    monthly: list[AccountMonthPoint]  # every month of the range, oldest first
    payees: list[AnalysisPayee]
    largest: list[AnalysisTransaction]
    # Lifetime figures, independent of the selected range, so "how much have
    # I ever spent on this" is always one glance away.
    all_time_total: float
    all_time_count: int
    first_date: Optional[str] = None  # ISO, earliest transaction in the category
