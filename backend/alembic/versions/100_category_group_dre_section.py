"""category_groups.dre_section: the group's line in the income statement

Business workspaces get an income statement (DRE) built from their
categories. Each group says which line its net amount lands on (revenue,
deductions, costs, operating expenses, financial result, or owners below
the bottom line). NULL means not classified; existing groups start there.

Revision ID: 100
Revises: 099
"""
import sqlalchemy as sa
from alembic import op

revision = "100"
down_revision = "099"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("category_groups", sa.Column("dre_section", sa.String(30), nullable=True))


def downgrade() -> None:
    op.drop_column("category_groups", "dre_section")
