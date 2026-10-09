import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, ConfigDict


class LoanPayment(BaseModel):
    date: date
    amount: Decimal
    installment_id: Optional[str] = None
    over_parcel: bool = False


class LoanRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    connection_id: Optional[uuid.UUID] = None
    account_id: Optional[uuid.UUID] = None
    source: str
    institution_name: Optional[str] = None
    contract_number: Optional[str] = None
    product_name: Optional[str] = None
    loan_type: Optional[str] = None
    kind: Optional[str] = None
    currency: str
    contract_amount: Optional[Decimal] = None
    outstanding_balance: Optional[Decimal] = None
    cet: Optional[Decimal] = None
    monthly_rate: Optional[Decimal] = None
    amortization_system: Optional[str] = None
    installment_periodicity: Optional[str] = None
    total_installments: Optional[int] = None
    paid_installments: Optional[int] = None
    remaining_installments: Optional[int] = None
    overdue_installments: Optional[int] = None
    installment_amount: Optional[Decimal] = None
    contract_date: Optional[date] = None
    first_installment_date: Optional[date] = None
    final_due_date: Optional[date] = None
    next_due_date: Optional[date] = None
    payments: list[LoanPayment] = []
    warranties: list[dict] = []
    contracted_fees: list[dict] = []
    is_active: bool
    last_synced_at: Optional[datetime] = None

    @classmethod
    def from_loan(cls, loan) -> "LoanRead":
        raw = loan.raw_data or {}
        data = cls.model_validate(loan, from_attributes=True).model_dump()
        data["payments"] = loan.payments or []
        data["warranties"] = raw.get("warranties") or []
        data["contracted_fees"] = raw.get("contractedFees") or []
        return cls.model_validate(data)


class ManualLoanCreate(BaseModel):
    """A financing described by its contract, carried by a manual account."""

    account_id: Optional[uuid.UUID] = None
    product_name: str
    institution_name: Optional[str] = None
    kind: str = "FINANCING"
    contract_amount: Decimal
    installment_amount: Decimal
    total_installments: int
    contract_date: date
    first_installment_date: date
    monthly_rate: Optional[Decimal] = None  # fraction; derived from the terms when omitted
    amortization_system: str = "PRICE"


class ManualLoanUpdate(BaseModel):
    product_name: Optional[str] = None
    institution_name: Optional[str] = None
    contract_amount: Optional[Decimal] = None
    installment_amount: Optional[Decimal] = None
    total_installments: Optional[int] = None
    contract_date: Optional[date] = None
    first_installment_date: Optional[date] = None
    monthly_rate: Optional[Decimal] = None


class ScheduledPayment(BaseModel):
    date: date
    amount: float
    kind: str
    interest: float
    principal: float
    balance_after: float
    payment_id: Optional[str] = None
    transaction_id: Optional[uuid.UUID] = None
    description: Optional[str] = None


class ProjectedInstallment(BaseModel):
    date: date
    payment: float
    interest: float
    principal: float
    balance_after: float


class LoanSchedule(BaseModel):
    rate: float
    installment: float
    principal: float
    balance: float
    balance_today: float
    interest_paid: float
    principal_paid: float
    projected_interest: float
    total_interest: float
    baseline_interest: float
    interest_saved: float
    months_saved: int
    paid_installments: int
    remaining_installments: int
    next_due: Optional[date] = None
    payoff_date: Optional[date] = None
    baseline_end: Optional[date] = None
    payments: list[ScheduledPayment]
    projected: list[ProjectedInstallment]


class PaymentSuggestion(BaseModel):
    transaction_id: uuid.UUID
    date: date
    description: str
    amount: float
    account_name: str
    kind: str
    reason: str


class LinkPayment(BaseModel):
    transaction_id: uuid.UUID
    kind: str = "installment"
