from typing import Optional

from pydantic import BaseModel


class IncomeStatementLine(BaseModel):
    """One category's net amount (credits minus debits) on one line."""

    category_id: Optional[str]  # None = uncategorized
    name: Optional[str]
    icon: Optional[str] = None
    color: Optional[str] = None
    group_name: Optional[str] = None
    total: float
    months: list[float]  # aligned with IncomeStatement.months


class IncomeStatementSection(BaseModel):
    # revenue | deductions | costs | operating_expenses | financial
    # | unclassified | owners
    key: str
    total: float
    months: list[float]
    lines: list[IncomeStatementLine]


class IncomeStatementAmount(BaseModel):
    total: float
    months: list[float]


class IncomeStatementSubtotals(BaseModel):
    net_revenue: IncomeStatementAmount       # revenue + deductions
    gross_profit: IncomeStatementAmount      # net revenue + costs
    operating_result: IncomeStatementAmount  # gross profit + operating expenses
    net_income: IncomeStatementAmount        # operating result + financial + unclassified


class IncomeStatement(BaseModel):
    start: str
    end: str
    currency: str
    months: list[str]  # "YYYY-MM", oldest first
    sections: list[IncomeStatementSection]
    subtotals: IncomeStatementSubtotals
    # Net income over revenue; None where there was no revenue.
    margin: Optional[float]
    margins: list[Optional[float]]
