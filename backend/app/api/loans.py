import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import WorkspaceContext, current_workspace, current_writable_workspace
from app.models.account import Account
from app.models.loan import Loan, LoanPayment
from app.models.transaction import Transaction
from app.schemas.loan import (
    LinkPayment,
    LoanRead,
    LoanSchedule,
    ManualLoanCreate,
    ManualLoanUpdate,
    PaymentSuggestion,
    ProjectedInstallment,
    ScheduledPayment,
)
from app.services import loan_service

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


async def _loan(session: AsyncSession, ctx: WorkspaceContext, loan_id: uuid.UUID) -> Loan:
    loan = await session.scalar(select(Loan).where(Loan.id == loan_id, Loan.workspace_id == ctx.workspace.id))
    if loan is None:
        raise HTTPException(status_code=404, detail="Loan not found")
    return loan


@router.post("/manual", response_model=LoanRead, status_code=201)
async def create_manual_loan(
    body: ManualLoanCreate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Describe a financing by its contract. Installments already paid are
    linked automatically when their description and amount are unambiguous."""
    if body.account_id is not None:
        account = await session.scalar(select(Account).where(Account.id == body.account_id, Account.workspace_id == ctx.workspace.id))
        if account is None:
            raise HTTPException(status_code=404, detail="Account not found")
    if body.total_installments <= 0 or body.contract_amount <= 0 or body.installment_amount <= 0:
        raise HTTPException(status_code=422, detail="Contract amounts and installments must be positive")
    loan = Loan(
        workspace_id=ctx.workspace.id,
        user_id=ctx.user_id,
        source="manual",
        external_id=f"manual:{uuid.uuid4()}",
        account_id=body.account_id,
        product_name=body.product_name,
        institution_name=body.institution_name,
        kind=body.kind,
        currency="BRL",
        contract_amount=body.contract_amount,
        installment_amount=body.installment_amount,
        total_installments=body.total_installments,
        contract_date=body.contract_date,
        first_installment_date=body.first_installment_date,
        monthly_rate=body.monthly_rate,
        amortization_system=body.amortization_system,
        installment_periodicity="MENSAL",
        is_active=True,
    )
    if body.account_id is not None:
        account = await session.get(Account, body.account_id)
        loan.currency = account.currency
    session.add(loan)
    await session.flush()
    await loan_service.auto_link(session, loan)
    await loan_service.recompute(session, loan)
    await session.commit()
    await session.refresh(loan)
    return LoanRead.from_loan(loan)


@router.patch("/{loan_id}", response_model=LoanRead)
async def update_manual_loan(
    loan_id: uuid.UUID,
    body: ManualLoanUpdate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    loan = await _loan(session, ctx, loan_id)
    if loan.source != "manual":
        raise HTTPException(status_code=409, detail="Contracts from Open Finance are updated by the bank")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(loan, field, value)
    await loan_service.recompute(session, loan)
    await session.commit()
    await session.refresh(loan)
    return LoanRead.from_loan(loan)


@router.delete("/{loan_id}", status_code=204)
async def delete_manual_loan(
    loan_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    loan = await _loan(session, ctx, loan_id)
    if loan.source != "manual":
        raise HTTPException(status_code=409, detail="Contracts from Open Finance can't be deleted")
    mirrors = (await session.execute(
        select(LoanPayment.mirror_transaction_id).where(LoanPayment.loan_id == loan.id, LoanPayment.mirror_transaction_id.is_not(None))
    )).scalars().all()
    await session.delete(loan)
    await session.flush()
    for mirror_id in mirrors:
        tx = await session.get(Transaction, mirror_id)
        if tx is not None:
            await session.delete(tx)
    await session.commit()


@router.get("/{loan_id}/schedule", response_model=LoanSchedule)
async def get_schedule(
    loan_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Payments split into interest and principal, the projection to payoff,
    and how the actual contract compares with the one signed."""
    loan = await _loan(session, ctx, loan_id)
    sched = await loan_service.schedule(session, loan)
    if sched is None:
        raise HTTPException(status_code=404, detail="Not enough contract terms to build a schedule")
    pairs = {str(lp.id): (lp, tx) for lp, tx in (await session.execute(
        select(LoanPayment, Transaction).join(Transaction, LoanPayment.transaction_id == Transaction.id).where(LoanPayment.loan_id == loan.id)
    )).all()}
    return LoanSchedule(
        rate=sched.rate, installment=sched.installment, principal=sched.principal,
        balance=sched.balance, balance_today=sched.balance_today,
        interest_paid=round(sched.interest_paid, 2), principal_paid=round(sched.principal_paid, 2),
        projected_interest=round(sched.projected_interest, 2), total_interest=round(sched.total_interest, 2),
        baseline_interest=round(sched.baseline_interest, 2), interest_saved=round(sched.interest_saved, 2),
        months_saved=sched.months_saved, paid_installments=sched.paid_installments,
        remaining_installments=sched.remaining_installments, next_due=sched.next_due,
        payoff_date=sched.payoff_date, baseline_end=sched.baseline_end,
        payments=[
            ScheduledPayment(
                date=p.date, amount=p.amount, kind=p.kind, interest=p.interest, principal=p.principal,
                balance_after=p.balance_after, payment_id=p.ref,
                transaction_id=pairs[p.ref][1].id if p.ref in pairs else None,
                description=pairs[p.ref][1].description if p.ref in pairs else None,
            )
            for p in sched.payments
        ],
        projected=[ProjectedInstallment(**vars(p)) for p in sched.projected],
    )


@router.get("/{loan_id}/suggestions", response_model=list[PaymentSuggestion])
async def get_suggestions(
    loan_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    loan = await _loan(session, ctx, loan_id)
    return [PaymentSuggestion(**vars(s)) for s in await loan_service.suggestions(session, loan)]


@router.post("/{loan_id}/payments", response_model=LoanRead)
async def link_payment(
    loan_id: uuid.UUID,
    body: LinkPayment,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    if body.kind not in ("installment", "extra"):
        raise HTTPException(status_code=422, detail="kind must be installment or extra")
    loan = await _loan(session, ctx, loan_id)
    try:
        await loan_service.link_payment(session, loan, body.transaction_id, body.kind)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    await session.refresh(loan)
    return LoanRead.from_loan(loan)


@router.delete("/{loan_id}/payments/{transaction_id}", response_model=LoanRead)
async def unlink_payment(
    loan_id: uuid.UUID,
    transaction_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    loan = await _loan(session, ctx, loan_id)
    await loan_service.unlink_payment(session, loan, transaction_id)
    await session.commit()
    await session.refresh(loan)
    return LoanRead.from_loan(loan)
