"""loans and financing contracts pulled from Open Finance

Pluggy's /loans returns the credit operations a consent covers (personal
loans, vehicle and real-estate financing, overdraft). Until now a financing
had to be modelled by hand as a `loan` account; this table stores the
contract as the bank reports it so the balance, installments and CET stay
current without manual entry.

Revision ID: 097
Revises: 096
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "097"
down_revision = "096"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "loans",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("connection_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("bank_connections.id", ondelete="SET NULL"), nullable=True),
        sa.Column("source", sa.String(50), nullable=False, server_default="pluggy"),
        sa.Column("external_id", sa.String(255), nullable=False),
        sa.Column("institution_name", sa.String(255), nullable=True),
        sa.Column("contract_number", sa.String(100), nullable=True),
        sa.Column("product_name", sa.String(255), nullable=True),
        sa.Column("loan_type", sa.String(100), nullable=True),
        sa.Column("kind", sa.String(50), nullable=True),
        sa.Column("currency", sa.String(3), nullable=False, server_default="BRL"),
        sa.Column("contract_amount", sa.Numeric(15, 2), nullable=True),
        sa.Column("outstanding_balance", sa.Numeric(15, 2), nullable=True),
        sa.Column("cet", sa.Numeric(10, 6), nullable=True),
        sa.Column("monthly_rate", sa.Numeric(10, 6), nullable=True),
        sa.Column("amortization_system", sa.String(50), nullable=True),
        sa.Column("installment_periodicity", sa.String(50), nullable=True),
        sa.Column("total_installments", sa.Integer(), nullable=True),
        sa.Column("paid_installments", sa.Integer(), nullable=True),
        sa.Column("remaining_installments", sa.Integer(), nullable=True),
        sa.Column("overdue_installments", sa.Integer(), nullable=True),
        sa.Column("installment_amount", sa.Numeric(15, 2), nullable=True),
        sa.Column("contract_date", sa.Date(), nullable=True),
        sa.Column("first_installment_date", sa.Date(), nullable=True),
        sa.Column("final_due_date", sa.Date(), nullable=True),
        sa.Column("next_due_date", sa.Date(), nullable=True),
        sa.Column("payments", sa.JSON(), nullable=True),
        sa.Column("raw_data", sa.JSON(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("workspace_id", "source", "external_id", name="uq_loans_workspace_source_external_id"),
    )
    op.create_index("ix_loans_workspace_id", "loans", ["workspace_id"])
    op.create_index("ix_loans_connection_id", "loans", ["connection_id"])


def downgrade() -> None:
    op.drop_index("ix_loans_connection_id", table_name="loans")
    op.drop_index("ix_loans_workspace_id", table_name="loans")
    op.drop_table("loans")
