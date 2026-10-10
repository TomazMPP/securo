import uuid
from typing import TYPE_CHECKING, Literal, Optional, get_args

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.category import Category
    from app.models.user import User


# Where a group's net amount lands in the income statement (DRE). Set on the
# group, not the category, so a whole family ("Pessoal": pró-labore, payroll,
# benefits) moves together and a new category inherits its line by joining
# the group. NULL = not classified: still shown, so the statement reconciles
# with the cash that moved, but outside the subtotals.
#
# `owners` is the one section below the bottom line: distributions and owner
# contributions are equity movements, not profit or loss.
DreSection = Literal[
    "revenue", "deductions", "costs", "operating_expenses", "financial", "owners",
]
DRE_SECTIONS: tuple[str, ...] = get_args(DreSection)


class CategoryGroup(Base):
    __tablename__ = "category_groups"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    icon: Mapped[str] = mapped_column(String(50), default="folder")
    color: Mapped[str] = mapped_column(String(7), default="#6B7280")
    position: Mapped[int] = mapped_column(Integer, default=0)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    is_hidden: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    dre_section: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)

    user: Mapped["User"] = relationship(back_populates="category_groups")
    categories: Mapped[list["Category"]] = relationship(
        back_populates="group",
        order_by="Category.name",
    )
