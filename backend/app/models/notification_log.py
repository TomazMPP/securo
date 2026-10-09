import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NotificationLog(Base):
    """One row per notification sent, so a scheduled job never sends twice.

    `key` identifies the occurrence ("monthly:2026-09", "large_tx:<id>",
    "bills:<recurring id>:2026-10-15"); the (user, key) pair is unique, so
    inserting the row is also the lock that claims the send.
    """

    __tablename__ = "notification_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(40))
    key: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="sent")  # sent | failed
    sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_notification_log_user_key"),)
