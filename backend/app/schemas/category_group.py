import uuid
from typing import Optional

from pydantic import BaseModel, ConfigDict

from app.models.category_group import DreSection
from app.schemas.category import CategoryRead


class CategoryGroupBase(BaseModel):
    name: str
    icon: str = "folder"
    color: str = "#6B7280"
    position: int = 0
    dre_section: Optional[DreSection] = None


class CategoryGroupCreate(CategoryGroupBase):
    pass


class CategoryGroupUpdate(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    position: Optional[int] = None
    is_hidden: Optional[bool] = None
    # Explicit null clears it (the update applies only fields that were sent).
    dre_section: Optional[DreSection] = None


class CategoryGroupRead(CategoryGroupBase):
    id: uuid.UUID
    user_id: uuid.UUID
    is_system: bool
    is_hidden: bool = False
    categories: list[CategoryRead] = []

    model_config = ConfigDict(from_attributes=True)
