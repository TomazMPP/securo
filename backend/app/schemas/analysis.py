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
