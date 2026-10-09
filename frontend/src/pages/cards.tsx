import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CalendarCheck, ChevronDown, CreditCard } from 'lucide-react'
import { cards as cardsApi } from '@/lib/api'
import type { CardSummary, CardsMonth, CardsOverview, InstallmentPlan } from '@/types'
import { PageHeader } from '@/components/page-header'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { CategoryIcon } from '@/components/category-icon'
import { ChartTooltip } from '@/components/chart-tooltip'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import { merchantName } from '@/lib/merchant-name'

// One stable colour per card, in the order cards are listed (most used first).
const CARD_COLORS = ['#2456E6', '#E08A1E', '#18A58A', '#8B5CF6', '#E8608A', '#0EA5C6', '#6B7280']

function useFmt(currency: string) {
  const locale = useDisplayLocale()
  const { mask } = usePrivacyMode()
  return useMemo(() => ({
    money: (v: number | null | undefined) => mask(formatCurrency(v ?? null, currency, locale)),
    compact: (v: number) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v),
    pct: (v: number | null | undefined) => (v == null ? '—' : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(v)),
    month: (key: string) => new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit' }).format(new Date(`${key}-01T12:00:00`)),
    monthLong: (key: string) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(`${key}-01T12:00:00`)),
    day: (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' }).format(new Date(`${iso}T12:00:00`)) : '—'),
  }), [currency, locale, mask])
}

const daysUntil = (iso: string | null) => {
  if (!iso) return null
  const ms = new Date(`${iso}T12:00:00`).getTime() - new Date(new Date().toDateString()).getTime()
  return Math.round(ms / 86400000)
}

export default function CardsPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({ queryKey: ['cards', 'overview'], queryFn: cardsApi.overview })

  return (
    <div>
      <PageHeader section={t('nav.groupControl')} title={t('cards.title')} />
      {isLoading && <div className="grid gap-5"><Skeleton className="h-48 rounded-2xl" /><Skeleton className="h-80 rounded-2xl" /></div>}
      {data && data.cards.length === 0 && (
        <Card className="items-center px-6 py-14 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><CreditCard size={26} /></span>
          <h2 className="mt-5 text-lg font-bold">{t('cards.emptyTitle')}</h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">{t('cards.emptyBody')}</p>
        </Card>
      )}
      {data && data.cards.length > 0 && <CardsContent data={data} />}
    </div>
  )
}

function CardsContent({ data }: { data: CardsOverview }) {
  const { t } = useTranslation()
  const f = useFmt(data.currency)
  const colorOf = useMemo(() => Object.fromEntries(data.cards.map((c, i) => [c.id, CARD_COLORS[i % CARD_COLORS.length]])), [data.cards])
  const [filter, setFilter] = useState<string | null>(null)
  const plans = filter ? data.plans.filter((p) => p.card_id === filter) : data.plans
  const committedShare = data.total_limit ? data.future_installments / data.total_limit : null
  const categoriesTotal = data.categories.reduce((sum, c) => sum + c.amount, 0) || 1

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="flex flex-col rounded-[20px] bg-primary p-1">
          <div className="rounded-[17px] bg-card p-5 sm:p-6">
            <div className="text-[13.5px] font-medium text-muted-foreground">{t('cards.totalLimit')}</div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
              <span className="text-[34px] font-bold tracking-tight tabular-nums">{f.money(data.total_available)}</span>
              <span className="text-sm text-muted-foreground">{t('cards.availableOf', { limit: f.money(data.total_limit) })}</span>
            </div>
            <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-secondary">
              {data.cards.map((c) => data.total_limit > 0 && (
                <span
                  key={c.id}
                  title={t('cards.segmentTitle', { name: c.name, used: f.money(c.used), share: f.pct(c.used / data.total_limit), ofUsed: f.pct(data.total_used ? c.used / data.total_used : null) })}
                  style={{ width: `${(c.used / data.total_limit) * 100}%`, background: colorOf[c.id] }}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-[13px] text-muted-foreground">
              <span>{t('cards.usedOf', { used: f.money(data.total_used), pct: f.pct(data.utilization) })}</span>
              <span>{t('cards.cardsCount', { count: data.cards.length })}</span>
            </div>
          </div>
          <p className="px-5 py-3.5 text-sm leading-relaxed text-primary-foreground">
            {t('cards.committedInsight', { amount: f.money(data.future_installments), pct: f.pct(committedShare) })}
            {data.freed_next_3_months > 0 && ` ${t('cards.freedInsight', { amount: f.money(data.freed_next_3_months) })}`}
          </p>
        </section>

        <div className="grid grid-cols-2 gap-4">
          <Kpi label={t('cards.closedBills')} value={f.money(data.closed_bills)} note={t('cards.closedBillsHint')} tone="warn" />
          <Kpi label={t('cards.openBills')} value={f.money(data.open_bills)} note={t('cards.openBillsHint')} />
          <Kpi label={t('cards.monthlyInstallments')} value={f.money(data.monthly_installments)} note={t('cards.plansCount', { count: data.plans.length })} />
          <Kpi label={t('cards.futureInstallments')} value={f.money(data.future_installments)} note={t('cards.futureInstallmentsHint')} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <MonthChart title={t('cards.commitmentsTitle')} hint={t('cards.commitmentsHint')} rows={data.commitments.slice(0, 12)} cards={data.cards} colorOf={colorOf} f={f} />
        <MonthChart title={t('cards.historyTitle')} hint={t('cards.historyHint')} rows={data.history} cards={data.cards} colorOf={colorOf} f={f} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.cards.map((c) => <CardTile key={c.id} card={c} color={colorOf[c.id]} f={f} />)}
      </div>

      <PlansCard data={data} plans={plans} filter={filter} setFilter={setFilter} colorOf={colorOf} f={f} />

      <Card className="gap-0 p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[13.5px] font-medium text-muted-foreground">{t('cards.categoriesTitle')}</h2>
          <Link to="/transactions" className="text-[13px] font-medium">{t('cards.seeTransactions')}</Link>
        </div>
        {data.categories.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t('cards.noSpending')}</p>}
        <ul className="mt-4 grid grid-cols-1 gap-x-10 gap-y-3.5 md:grid-cols-2">
          {data.categories.slice(0, 10).map((c) => {
            const max = data.categories[0].amount || 1
            return (
              <li key={c.name || 'uncategorized'}>
                <div className="flex items-center gap-2.5 text-sm">
                  <CategoryIcon icon={c.icon} color={c.color} size="sm" />
                  <span className="flex-1 truncate font-medium">{c.name || t('cards.uncategorized')}</span>
                  <span className="text-[12px] text-muted-foreground tabular-nums">{f.pct(c.amount / categoriesTotal)}</span>
                  <span className="w-28 text-right font-semibold tabular-nums">{f.money(c.amount)}</span>
                </div>
                <div className="mt-1.5 ml-8 h-1.5 overflow-hidden rounded-full bg-secondary"><span className="block h-full rounded-full" style={{ width: `${(c.amount / max) * 100}%`, background: c.color }} /></div>
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}

type Fmt = ReturnType<typeof useFmt>

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'warn' }) {
  return (
    <Card className="gap-0 p-4 sm:p-5">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        {tone === 'warn' && <span className="size-2 rounded-full bg-amber-500" aria-hidden />}
        {label}
      </div>
      <div className="mt-1 text-[22px] font-bold tracking-tight tabular-nums">{value}</div>
      {note && <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{note}</div>}
    </Card>
  )
}

function MonthChart({ title, hint, rows, cards, colorOf, f }: { title: string; hint: string; rows: CardsMonth[]; cards: CardSummary[]; colorOf: Record<string, string>; f: Fmt }) {
  const { t } = useTranslation()
  const data = rows.map((r) => ({ month: r.month, ...r.by_card }))
  const used = cards.filter((c) => rows.some((r) => r.by_card[c.id]))
  return (
    <Card className="gap-0 p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13.5px] font-medium text-muted-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {rows.length === 0 ? <p className="mt-6 text-sm text-muted-foreground">{t('cards.noData')}</p> : (
        <div className="mt-3 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="month" tickFormatter={f.month} tickLine={false} axisLine={false} fontSize={12} minTickGap={8} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} width={52} tickFormatter={f.compact} />
              <Tooltip
                cursor={{ fill: 'var(--secondary)', opacity: 0.6 }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <ChartTooltip
                      title={f.monthLong(String(label))}
                      format={f.money}
                      totalLabel={t('cards.tooltipTotal')}
                      shares
                      rows={[...payload].reverse().map((p) => ({
                        key: String(p.dataKey),
                        label: cards.find((c) => c.id === p.dataKey)?.name ?? String(p.dataKey),
                        value: Number(p.value) || 0,
                        color: colorOf[String(p.dataKey)],
                      }))}
                    />
                  ) : null
                }
              />
              <Legend formatter={(id) => cards.find((c) => c.id === id)?.name ?? id} wrapperStyle={{ fontSize: 12 }} />
              {used.map((c, i) => <Bar key={c.id} dataKey={c.id} stackId="c" fill={colorOf[c.id]} radius={i === used.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

function CardTile({ card, color, f }: { card: CardSummary; color: string; f: Fmt }) {
  const { t } = useTranslation()
  const util = card.utilization ?? 0
  const closeIn = daysUntil(card.next_close)
  const dueIn = daysUntil(card.next_due)
  const tone = util >= 0.8 ? 'text-red-700 dark:text-red-300' : util >= 0.5 ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'
  return (
    <Card className="gap-0 p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl text-[13px] font-bold text-white" style={{ background: color }}>
          {(card.institution ?? card.name).slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{card.name}</div>
          <div className="truncate text-[12.5px] text-muted-foreground">{card.institution}</div>
        </div>
        <span className={cn('text-[13px] font-semibold tabular-nums', tone)}>{f.pct(card.utilization)}</span>
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-2">
        <span className="text-[22px] font-bold tracking-tight tabular-nums">{f.money(card.used)}</span>
        <span className="text-[12.5px] text-muted-foreground tabular-nums">{t('cards.ofLimit', { limit: f.money(card.limit) })}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, util * 100)}%`, background: color }} /></div>
      <div className="mt-1.5 text-[12.5px] text-muted-foreground tabular-nums">{t('cards.available', { amount: f.money(card.available) })}</div>

      <div className="mt-4 flex flex-col gap-2 border-t pt-3.5 text-[13px]">
        {card.closed_bill != null && (
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-muted-foreground"><span className="size-1.5 rounded-full bg-amber-500" />{t('cards.closedBillDue', { date: f.day(card.closed_due) })}</span>
            <span className="font-semibold tabular-nums">{f.money(card.closed_bill)}</span>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">
            {t('cards.openBill')}
            {dueIn != null && <span className="text-muted-foreground/80"> · {t('cards.dueIn', { count: dueIn })}</span>}
          </span>
          <span className="font-semibold tabular-nums">{f.money(card.current_bill)}</span>
        </div>
        {card.installments_in_bill > 0 && (
          <div className="text-[12px] text-muted-foreground tabular-nums">
            {t('cards.billInstallmentsLine', { amount: f.money(card.installments_in_bill), count: card.active_plans })}
          </div>
        )}
      </div>
      {(closeIn != null || card.best_day) && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {closeIn != null && <span>{t('cards.closesIn', { count: closeIn })}</span>}
          {card.best_day && <span className="inline-flex items-center gap-1"><CalendarCheck size={12} />{t('cards.bestDay', { day: card.best_day })}</span>}
        </div>
      )}
    </Card>
  )
}

function PlansCard({ data, plans, filter, setFilter, colorOf, f }: {
  data: CardsOverview
  plans: InstallmentPlan[]
  filter: string | null
  setFilter: (id: string | null) => void
  colorOf: Record<string, string>
  f: Fmt
}) {
  const { t } = useTranslation()
  const [showAll, setShowAll] = useState(false)
  const openKey = data.cards.map((c) => c.bill_month).filter(Boolean).sort()[0] ?? ''
  const soonLimit = openKey ? shiftKey(openKey, 2) : ''
  const ending = plans.filter((p) => p.last_month <= soonLimit)
  const ongoing = plans.filter((p) => p.last_month > soonLimit)
  const visibleOngoing = showAll ? ongoing : ongoing.slice(0, Math.max(0, 8 - ending.length))
  const hidden = ongoing.length - visibleOngoing.length
  const cardName = (id: string) => data.cards.find((c) => c.id === id)?.name ?? ''

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-4 sm:px-6">
        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
          <h2 className="text-base font-bold">{t('cards.plansTitle')}</h2>
          <p className="text-[13px] text-muted-foreground tabular-nums">{t('cards.plansSummary', { count: plans.length, amount: f.money(plans.reduce((s, p) => s + p.remaining_amount, 0)) })}</p>
        </div>
        <select
          aria-label={t('cards.filterByCard')}
          value={filter ?? ''}
          onChange={(e) => setFilter(e.target.value || null)}
          className="h-9 w-full rounded-xl border border-input bg-card px-3 text-[13px] font-medium outline-none focus:border-ring sm:w-auto"
        >
          <option value="">{t('cards.allCards')}</option>
          {data.cards.filter((c) => c.active_plans > 0).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {plans.length === 0 && <p className="px-6 pb-10 pt-4 text-center text-sm text-muted-foreground">{t('cards.noPlans')}</p>}

      {plans.length > 0 && (
        <div className="hidden grid-cols-[minmax(0,2.4fr)_minmax(0,1.6fr)_8rem_8rem_7rem] gap-4 border-y bg-secondary/50 px-6 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground md:grid">
          <span>{t('cards.colPurchase')}</span>
          <span>{t('cards.colProgress')}</span>
          <span className="text-right">{t('cards.colInstallment')}</span>
          <span className="text-right">{t('cards.colRemaining')}</span>
          <span className="text-right">{t('cards.colEnds')}</span>
        </div>
      )}

      {ending.length > 0 && <GroupLabel>{t('cards.groupEnding', { amount: f.money(ending.reduce((s, p) => s + p.installment, 0)) })}</GroupLabel>}
      {ending.map((p) => <PlanRow key={p.key} plan={p} cardName={cardName(p.card_id)} color={colorOf[p.card_id]} f={f} highlight />)}
      {ongoing.length > 0 && ending.length > 0 && <GroupLabel>{t('cards.groupOngoing')}</GroupLabel>}
      {visibleOngoing.map((p) => <PlanRow key={p.key} plan={p} cardName={cardName(p.card_id)} color={colorOf[p.card_id]} f={f} />)}

      {hidden > 0 && (
        <button onClick={() => setShowAll(true)} className="flex w-full items-center justify-center gap-1.5 border-t py-3 text-[13px] font-semibold text-primary hover:bg-secondary/50">
          {t('cards.showAll', { count: hidden })}<ChevronDown size={15} />
        </button>
      )}
    </Card>
  )
}

function shiftKey(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="border-t bg-secondary/30 px-5 py-2 text-[12px] font-semibold text-muted-foreground sm:px-6">{children}</div>
}

function PlanRow({ plan, cardName, color, f, highlight }: { plan: InstallmentPlan; cardName: string; color: string; f: Fmt; highlight?: boolean }) {
  const { t } = useTranslation()
  const progress = plan.paid / plan.total
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t px-5 py-3 sm:px-6 md:grid-cols-[minmax(0,2.4fr)_minmax(0,1.6fr)_8rem_8rem_7rem]">
      <div className="flex min-w-0 items-center gap-3">
        <CategoryIcon icon={plan.category_icon} color={plan.category_color} size="md" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold" title={plan.description}>{merchantName(plan.description)}</div>
          <div className="flex items-center gap-1.5 truncate text-[12px] text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="truncate">{cardName}{plan.category ? ` · ${plan.category}` : ''}</span>
          </div>
        </div>
      </div>
      <div className="text-right text-sm font-semibold tabular-nums md:order-3">{f.money(plan.installment)}</div>
      <div
        className="col-span-2 flex items-center gap-2.5 md:order-2 md:col-span-1"
        title={t('cards.progressTitle', { paid: plan.paid, total: plan.total, paidAmount: f.money(plan.installment * plan.paid), left: f.money(plan.remaining_amount), all: f.money(plan.total_amount) })}
      >
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"><span className="block h-full rounded-full" style={{ width: `${progress * 100}%`, background: highlight ? '#18A058' : color }} /></div>
        <span className="w-11 text-right text-[12px] font-semibold tabular-nums text-muted-foreground">{plan.paid}/{plan.total}</span>
      </div>
      <div className="hidden text-right text-[13px] tabular-nums text-muted-foreground md:order-4 md:block">{f.money(plan.remaining_amount)}</div>
      <div className="col-span-2 flex justify-between text-[12px] text-muted-foreground md:order-5 md:col-span-1 md:block md:text-right md:text-[13px]">
        <span className="md:hidden tabular-nums">{t('cards.remainingShort', { amount: f.money(plan.remaining_amount) })}</span>
        <span className={cn('tabular-nums', highlight && 'font-semibold text-emerald-700 dark:text-emerald-300')}>{f.month(plan.last_month)}</span>
      </div>
    </div>
  )
}
