import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import WorkspaceContext, current_workspace
from app.models.loan import Loan
from app.schemas.loan import LoanRead

router = APIRouter(prefix="/api/loans", tags=["loans"])


@router.get("", response_model=list[LoanRead])
async def list_loans(
    include_inactive: bool = Query(False, description="Also return settled or no-longer-shared contracts"),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Loan and financing contracts pulled from Open Finance, largest balance first."""
    query = select(Loan).where(Loan.workspace_id == ctx.workspace.id)
    if not include_inactive:
        query = query.where(Loan.is_active.is_(True))
    loans = (await session.execute(query)).scalars().all()
    loans = sorted(loans, key=lambda loan: loan.outstanding_balance or 0, reverse=True)
    return [LoanRead.from_loan(loan) for loan in loans]


@router.get("/{loan_id}", response_model=LoanRead)
async def get_loan(
    loan_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    loan = await session.scalar(
        select(Loan).where(Loan.id == loan_id, Loan.workspace_id == ctx.workspace.id)
    )
    if loan is None:
        raise HTTPException(status_code=404, detail="Loan not found")
    return LoanRead.from_loan(loan)
