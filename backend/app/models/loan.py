import uuid
from datetime import date as _date, datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import Date, DateTime, ForeignKey, Integer, JSON, Numeric, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Loan(Base):
    """A loan or financing contract pulled from a provider (Open Finance).

    Mirrors the universal shape of a credit operation: what was contracted,
    what is still owed, how many installments there are and how many are
    paid. Pluggy's /loans is the first source; anything provider-specific
    (fees, warranties, the payment history) is kept in `raw_data` so the UI
    can show it without a schema change.

    `installment_amount` and `next_due_date` are derived at sync time —
    Open Finance does not report them directly (see
    app.providers.pluggy._build_loan_data).
    """

    __tablename__ = "loans"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    connection_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("bank_connections.id", ondelete="SET NULL"), nullable=True, index=True
    )
    source: Mapped[str] = mapped_column(String(50), default="pluggy")
    external_id: Mapped[str] = mapped_column(String(255), nullable=False)
    institution_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    contract_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    product_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # Open Finance subtype (e.g. FINANCIAMENTO_AQUISICAO_BENS_VEICULOS_AUTOMOTORES)
    loan_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    # LOAN | FINANCING | INVOICE_FINANCING | UNARRANGED_ACCOUNT_OVERDRAFT
    kind: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="BRL")
    contract_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(15, 2), nullable=True)
    outstanding_balance: Mapped[Optional[Decimal]] = mapped_column(Numeric(15, 2), nullable=True)
    # Annual CET as a fraction (0.179 = 17.9% a.a.)
    cet: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 6), nullable=True)
    # Monthly nominal rate as a fraction, when the contract reports a fixed rate
    monthly_rate: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 6), nullable=True)
    amortization_system: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    installment_periodicity: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    total_installments: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    paid_installments: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    remaining_installments: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    overdue_installments: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    installment_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(15, 2), nullable=True)
    contract_date: Mapped[Optional[_date]] = mapped_column(Date, nullable=True)
    first_installment_date: Mapped[Optional[_date]] = mapped_column(Date, nullable=True)
    final_due_date: Mapped[Optional[_date]] = mapped_column(Date, nullable=True)
    next_due_date: Mapped[Optional[_date]] = mapped_column(Date, nullable=True)
    # Payment history: [{"date", "amount", "installment_id", "over_parcel"}]
    payments: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    raw_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    last_synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        UniqueConstraint("workspace_id", "source", "external_id", name="uq_loans_workspace_source_external_id"),
    )
