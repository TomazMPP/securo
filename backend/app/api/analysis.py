import uuid
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import WorkspaceContext, current_workspace
from app.schemas.analysis import AccountsAnalysis, PeriodAnalysis
from app.services import analysis_service

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


def _default_range(start: Optional[date], end: Optional[date]) -> tuple[date, date]:
    """Fill missing bounds with the current calendar month."""
    if start is None:
        start = date.today().replace(day=1)
    if end is None:
        next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        end = min(next_month - timedelta(days=1), date.today())
        if end < start:
            end = next_month - timedelta(days=1)
    return start, end


@router.get("/period", response_model=PeriodAnalysis)
async def get_period_analysis(
    start: Optional[date] = Query(None, description="Inclusive start date"),
    end: Optional[date] = Query(None, description="Inclusive end date"),
    account_ids: Optional[list[uuid.UUID]] = Query(None),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Break a date range down by category, payee and recurrence.

    Defaults to the current calendar month when no range is given.
    """
    start, end = _default_range(start, end)
    return await analysis_service.get_period_analysis(
        session, ctx.workspace.id, ctx.user_id, start, end, account_ids
    )


@router.get("/accounts", response_model=AccountsAnalysis)
async def get_accounts_analysis(
    start: Optional[date] = Query(None, description="Inclusive start date"),
    end: Optional[date] = Query(None, description="Inclusive end date"),
    account_ids: Optional[list[uuid.UUID]] = Query(None),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Break a date range down by account: per-card spend, credit-vs-debit
    split, limit utilization and statement cycle dates.

    Defaults to the current calendar month when no range is given.
    """
    start, end = _default_range(start, end)
    return await analysis_service.get_accounts_analysis(
        session, ctx.workspace.id, ctx.user_id, start, end, account_ids
    )
