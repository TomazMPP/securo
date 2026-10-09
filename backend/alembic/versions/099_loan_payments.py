"""manual loans linked to an account, and payments matched to transactions

A financing can now be described by its contract terms and tied to the
manual `loan` account that carries it, so its balance, installments and
interest are computed from the payments that actually happened. Each
matched payment records its principal/interest split and the principal
mirror written into the loan account.

Revision ID: 099
Revises: 098
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "099"
down_revision = "098"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("loans", sa.Column("account_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True))
    op.create_index("ix_loans_account_id", "loans", ["account_id"])
    op.create_table(
        "loan_payments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("loan_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("loans.id", ondelete="CASCADE"), nullable=False),
        sa.Column("transaction_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("kind", sa.String(20), nullable=False, server_default="installment"),
        sa.Column("principal", sa.Numeric(15, 2), nullable=True),
        sa.Column("interest", sa.Numeric(15, 2), nullable=True),
        sa.Column("mirror_transaction_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("transactions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_loan_payments_loan_id", "loan_payments", ["loan_id"])


def downgrade() -> None:
    op.drop_index("ix_loan_payments_loan_id", table_name="loan_payments")
    op.drop_table("loan_payments")
    op.drop_index("ix_loans_account_id", table_name="loans")
    op.drop_column("loans", "account_id")
