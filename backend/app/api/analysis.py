import uuid
from datetime import date, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import WorkspaceContext, current_workspace
from app.schemas.analysis import AccountsAnalysis, CategoryAnalysis, PeriodAnalysis
from app.services import analysis_service

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


async def _resolve_range(
    session: AsyncSession, workspace_id: uuid.UUID, account_ids: Optional[list[uuid.UUID]],
    start: Optional[date], end: Optional[date], all_time: bool,
) -> tuple[date, date]:
    """`all_time` runs from the first counted transaction to `end` (default
    today); otherwise missing bounds fall back to the current month."""
    if all_time:
        end = end or date.today()
        first = await analysis_service.first_activity_date(session, workspace_id, account_ids)
        return (min(first, end) if first else end), end
    return _default_range(start, end)


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
    all_time: bool = Query(False, description="Start at the first transaction; ignores start"),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Break a date range down by category, payee and recurrence.

    Defaults to the current calendar month when no range is given.
    """
    start, end = await _resolve_range(session, ctx.workspace.id, account_ids, start, end, all_time)
    return await analysis_service.get_period_analysis(
        session, ctx.workspace.id, ctx.user_id, start, end, account_ids
    )


@router.get("/accounts", response_model=AccountsAnalysis)
async def get_accounts_analysis(
    start: Optional[date] = Query(None, description="Inclusive start date"),
    end: Optional[date] = Query(None, description="Inclusive end date"),
    account_ids: Optional[list[uuid.UUID]] = Query(None),
    all_time: bool = Query(False, description="Start at the first transaction; ignores start"),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Break a date range down by account: per-card spend, credit-vs-debit
    split, limit utilization and statement cycle dates.

    Defaults to the current calendar month when no range is given.
    """
    start, end = await _resolve_range(session, ctx.workspace.id, account_ids, start, end, all_time)
    return await analysis_service.get_accounts_analysis(
        session, ctx.workspace.id, ctx.user_id, start, end, account_ids
    )


@router.get("/category", response_model=CategoryAnalysis)
async def get_category_analysis(
    category_id: Optional[uuid.UUID] = Query(None, description="Omit for uncategorized"),
    type: Literal["debit", "credit"] = Query("debit"),
    start: Optional[date] = Query(None, description="Inclusive start date"),
    end: Optional[date] = Query(None, description="Inclusive end date"),
    account_ids: Optional[list[uuid.UUID]] = Query(None),
    all_time: bool = Query(False, description="Start at the first transaction; ignores start"),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Drill into one category: monthly totals, top payees, largest
    transactions, plus its lifetime total.

    Defaults to the current calendar month when no range is given.
    """
    start, end = await _resolve_range(session, ctx.workspace.id, account_ids, start, end, all_time)
    result = await analysis_service.get_category_analysis(
        session, ctx.workspace.id, ctx.user_id, category_id, start, end, type, account_ids
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Category not found")
    return result
