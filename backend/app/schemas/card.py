import uuid
from datetime import date
from typing import Optional

from pydantic import BaseModel


class CardSummary(BaseModel):
    id: uuid.UUID
    name: str
    institution: Optional[str] = None
    logo_url: Optional[str] = None
    limit: Optional[float] = None
    used: float
    available: Optional[float] = None
    utilization: Optional[float] = None
    close_day: Optional[int] = None
    due_day: Optional[int] = None
    next_close: Optional[date] = None
    next_due: Optional[date] = None
    best_day: Optional[int] = None
    current_bill: float
    bill_month: Optional[str] = None
    closed_bill: Optional[float] = None
    closed_due: Optional[date] = None
    installments_in_bill: float = 0.0
    active_plans: int = 0


class InstallmentPlanOut(BaseModel):
    key: str
    card_id: uuid.UUID
    description: str
    category: Optional[str] = None
    category_color: Optional[str] = None
    category_icon: Optional[str] = None
    installment: float
    total: int
    paid: int
    remaining: int
    remaining_amount: float
    total_amount: float
    purchase_date: Optional[date] = None
    first_month: str
    last_month: str


class MonthCards(BaseModel):
    month: str
    by_card: dict[str, float]
    total: float


class CategoryShare(BaseModel):
    name: str
    color: str
    icon: str
    amount: float


class CardsOverviewOut(BaseModel):
    currency: str
    total_limit: float
    total_used: float
    total_available: float
    utilization: Optional[float] = None
    open_bills: float
    closed_bills: float
    future_installments: float
    monthly_installments: float  # installments on the open bills
    freed_next_3_months: float  # monthly installments that end within 3 bills
    cards: list[CardSummary]
    plans: list[InstallmentPlanOut]
    commitments: list[MonthCards]
    history: list[MonthCards]
    categories: list[CategoryShare]
