from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.module_gate import require_module
from app.core.workspace_context import WorkspaceContext
from app.schemas.income_statement import IncomeStatement
from app.services import income_statement_service
from app.services.module_service import ModuleId

router = APIRouter(prefix="/api/income-statement", tags=["income-statement"])


@router.get("", response_model=IncomeStatement)
async def get_income_statement(
    start: Optional[date] = Query(None, description="Inclusive start date"),
    end: Optional[date] = Query(None, description="Inclusive end date"),
    ctx: WorkspaceContext = Depends(require_module(ModuleId.INCOME_STATEMENT)),
    session: AsyncSession = Depends(get_async_session),
):
    """Monthly income statement (DRE). Defaults to the last 6 months, this one included."""
    today = date.today()
    end = end or today
    if start is None:
        y, m = end.year, end.month - 5
        while m <= 0:
            y, m = y - 1, m + 12
        start = date(y, m, 1)
    return await income_statement_service.get_income_statement(
        session, ctx.workspace.id, ctx.user_id, start, end
    )
