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
