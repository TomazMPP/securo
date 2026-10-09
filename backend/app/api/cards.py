from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import WorkspaceContext, current_workspace
from app.schemas.card import CardSummary, CardsOverviewOut, CategoryShare, InstallmentPlanOut, MonthCards
from app.services import card_service

router = APIRouter(prefix="/api/cards", tags=["cards"])


@router.get("/overview", response_model=CardsOverviewOut)
async def cards_overview(
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Limits across cards, open bills, installment plans and the months
    already committed to them, bill history and open-bill categories."""
    o = await card_service.overview(session, ctx.workspace.id)
    open_key = min((c.bill_key for c in o.cards if c.bill_key), default=None)
    in_bill: dict[str, float] = {}
    plans_per_card: dict[str, int] = {}
    for p in o.plans:
        cid = str(p.card_id)
        plans_per_card[cid] = plans_per_card.get(cid, 0) + 1
        card = next(c for c in o.cards if c.id == p.card_id)
        in_bill[cid] = in_bill.get(cid, 0.0) + p.months.get(card.bill_key or "", 0.0)
    freed = 0.0
    if open_key:
        horizon = card_service.shift_month(open_key, 2)
        freed = sum(p.installment for p in o.plans if p.last_month <= horizon)
    return CardsOverviewOut(
        currency=o.currency,
        total_limit=round(o.total_limit, 2),
        total_used=round(o.total_used, 2),
        total_available=round(max(0.0, o.total_limit - o.total_used), 2),
        utilization=round(o.total_used / o.total_limit, 4) if o.total_limit else None,
        open_bills=round(sum(c.current_bill for c in o.cards), 2),
        closed_bills=round(sum(c.closed_bill or 0 for c in o.cards), 2),
        future_installments=o.future_installments,
        monthly_installments=round(sum(in_bill.values()), 2),
        freed_next_3_months=round(freed, 2),
        cards=[
            CardSummary(
                id=c.id, name=c.name, institution=c.institution, logo_url=c.logo_url, limit=c.limit, used=c.used,
                available=c.available, utilization=round(c.utilization, 4) if c.utilization is not None else None,
                close_day=c.close_day, due_day=c.due_day, next_close=c.next_close, next_due=c.next_due,
                best_day=c.best_day, current_bill=c.current_bill, bill_month=c.bill_key,
                closed_bill=c.closed_bill, closed_due=c.closed_due, projected_in_bill=round(c.projected_in_bill, 2),
                installments_in_bill=round(in_bill.get(str(c.id), 0.0), 2), active_plans=plans_per_card.get(str(c.id), 0),
            )
            for c in o.cards
        ],
        plans=[
            InstallmentPlanOut(
                key=p.key, card_id=p.card_id, description=p.description, category=p.category,
                category_color=p.category_color, category_icon=p.category_icon, installment=p.installment,
                total=p.total, paid=p.paid, remaining=p.remaining, remaining_amount=p.remaining_amount,
                total_amount=p.total_amount, purchase_date=p.purchase_date, first_month=p.first_month,
                last_month=p.last_month,
            )
            for p in o.plans
        ],
        commitments=[MonthCards(month=m, by_card=d, total=round(sum(d.values()), 2)) for m, d in o.commitments.items()],
        history=[MonthCards(month=m, by_card=d, total=round(sum(d.values()), 2)) for m, d in o.history.items()],
        categories=[CategoryShare(name=n, color=c, icon=i, amount=a) for n, c, i, a in o.categories],
    )
