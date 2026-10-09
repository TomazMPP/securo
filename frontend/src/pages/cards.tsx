import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { CalendarCheck, CreditCard, Sparkles } from 'lucide-react'
import { cards as cardsApi } from '@/lib/api'
import type { CardSummary, CardsMonth, CardsOverview, InstallmentPlan } from '@/types'
import { PageHeader } from '@/components/page-header'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { CategoryIcon } from '@/components/category-icon'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'

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
            <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-secondary" aria-hidden>
              {data.cards.map((c) => data.total_limit > 0 && (
                <span key={c.id} style={{ width: `${(c.used / data.total_limit) * 100}%`, background: colorOf[c.id] }} />
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {data.cards.map((c) => <CardTile key={c.id} card={c} color={colorOf[c.id]} f={f} />)}
      </div>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="gap-0 p-0">
          <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4 sm:px-6">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold">{t('cards.plansTitle')}</h2>
              <p className="text-[13px] text-muted-foreground">{t('cards.plansSummary', { count: plans.length, amount: f.money(plans.reduce((s, p) => s + p.remaining_amount, 0)) })}</p>
            </div>
            <div className="flex flex-wrap gap-1 rounded-xl bg-secondary p-1" role="tablist" aria-label={t('cards.filterByCard')}>
              <button role="tab" aria-selected={filter === null} onClick={() => setFilter(null)} className={cn('h-8 rounded-lg px-3 text-[13px] font-medium text-muted-foreground', filter === null && 'bg-card font-semibold text-foreground shadow-xs')}>{t('cards.allCards')}</button>
              {data.cards.filter((c) => c.active_plans > 0).map((c) => (
                <button key={c.id} role="tab" aria-selected={filter === c.id} onClick={() => setFilter(c.id)} className={cn('flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-muted-foreground', filter === c.id && 'bg-card font-semibold text-foreground shadow-xs')}>
                  <span className="size-2 rounded-full" style={{ background: colorOf[c.id] }} />{c.name}
                </button>
              ))}
            </div>
          </div>
          {plans.length === 0 && <p className="px-6 py-10 text-center text-sm text-muted-foreground">{t('cards.noPlans')}</p>}
          <ul>{plans.map((p) => <PlanRow key={p.key} plan={p} card={data.cards.find((c) => c.id === p.card_id)} color={colorOf[p.card_id]} f={f} />)}</ul>
        </Card>

        <Card className="gap-0 p-5 sm:p-6">
          <h2 className="text-[13.5px] font-medium text-muted-foreground">{t('cards.categoriesTitle')}</h2>
          {data.categories.length === 0 && <p className="mt-3 text-sm text-muted-foreground">{t('cards.noSpending')}</p>}
          <ul className="mt-3 flex flex-col gap-3">
            {data.categories.slice(0, 8).map((c) => {
              const max = data.categories[0].amount || 1
              return (
                <li key={c.name}>
                  <div className="flex items-center gap-2.5 text-sm">
                    <CategoryIcon icon={c.icon} color={c.color} size="sm" />
                    <span className="flex-1 font-medium">{c.name}</span>
                    <span className="font-semibold tabular-nums">{f.money(c.amount)}</span>
                  </div>
                  <div className="mt-1.5 ml-8 h-1.5 overflow-hidden rounded-full bg-secondary"><span className="block h-full rounded-full" style={{ width: `${(c.amount / max) * 100}%`, background: c.color }} /></div>
                </li>
              )
            })}
          </ul>
          <Link to="/transactions" className="mt-4 text-[13px] font-medium">{t('cards.seeTransactions')}</Link>
        </Card>
      </div>
    </div>
  )
}

type Fmt = ReturnType<typeof useFmt>

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'warn' }) {
  return (
    <Card className={cn('gap-0 p-4 sm:p-5', tone === 'warn' && 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30')}>
      <div className="text-[13px] font-medium text-muted-foreground">{label}</div>
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
              <Tooltip formatter={(v, name) => [f.money(Number(v)), cards.find((c) => c.id === name)?.name ?? String(name)]} labelFormatter={(k) => f.monthLong(String(k))} />
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
  const dueIn = daysUntil(card.closed_due ?? card.next_due)
  return (
    <Card className="gap-0 p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white" style={{ background: color }}>
          {(card.institution ?? card.name).slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{card.name}</div>
          <div className="text-[12.5px] text-muted-foreground">{card.institution}</div>
        </div>
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', util >= 0.8 ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : util >= 0.5 ? 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300' : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300')}>
          {f.pct(card.utilization)}
        </span>
      </div>
      <div className="mt-4 flex items-baseline justify-between gap-2">
        <span className="text-xl font-bold tabular-nums">{f.money(card.used)}</span>
        <span className="text-[13px] text-muted-foreground">{t('cards.ofLimit', { limit: f.money(card.limit) })}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, util * 100)}%`, background: color }} /></div>
      <div className="mt-1.5 text-[12.5px] text-muted-foreground">{t('cards.available', { amount: f.money(card.available) })}</div>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-[13px]">
        {card.closed_bill != null && (
          <div className="col-span-2 flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2 dark:bg-amber-950/40">
            <dt className="text-amber-900 dark:text-amber-200">{t('cards.closedBillDue', { date: f.day(card.closed_due) })}</dt>
            <dd className="font-semibold tabular-nums">{f.money(card.closed_bill)}</dd>
          </div>
        )}
        <div className="rounded-xl bg-secondary px-3 py-2"><dt className="text-muted-foreground">{t('cards.openBill')}</dt><dd className="font-semibold tabular-nums">{f.money(card.current_bill)}</dd></div>
        <div className="rounded-xl bg-secondary px-3 py-2"><dt className="text-muted-foreground">{t('cards.installmentsInBill')}</dt><dd className="font-semibold tabular-nums">{f.money(card.installments_in_bill)}</dd></div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
        {closeIn != null && <span>{t('cards.closesIn', { count: closeIn })}</span>}
        {dueIn != null && <span>{t('cards.dueIn', { count: dueIn })}</span>}
        {card.best_day && <span className="inline-flex items-center gap-1 font-medium text-foreground/80"><CalendarCheck size={13} />{t('cards.bestDay', { day: card.best_day })}</span>}
      </div>
    </Card>
  )
}

function PlanRow({ plan, card, color, f }: { plan: InstallmentPlan; card?: CardSummary; color: string; f: Fmt }) {
  const { t } = useTranslation()
  const progress = plan.paid / plan.total
  const endsSoon = plan.remaining <= 2
  return (
    <li className="flex flex-wrap items-center gap-3 border-b px-5 py-3.5 last:border-0 sm:px-6">
      <CategoryIcon icon={plan.category_icon} color={plan.category_color} size="lg" />
      <div className="min-w-[10rem] flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="truncate">{plan.description}</span>
          {endsSoon && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"><Sparkles size={11} />{t('cards.endsSoon')}</span>}
        </div>
        <div className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <span className="size-2 rounded-full" style={{ background: color }} />{card?.name}
          {plan.category && <> · {plan.category}</>}
          <> · {t('cards.planTotal', { amount: f.money(plan.total_amount) })}</>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"><span className="block h-full rounded-full" style={{ width: `${progress * 100}%`, background: color }} /></div>
          <span className="text-[12px] font-semibold tabular-nums text-muted-foreground">{plan.paid}/{plan.total}</span>
        </div>
      </div>
      <div className="w-36 text-right">
        <div className="text-sm font-semibold tabular-nums">{t('cards.perMonth', { amount: f.money(plan.installment) })}</div>
        <div className="text-[12px] text-muted-foreground tabular-nums">{t('cards.remainingUntil', { amount: f.money(plan.remaining_amount), month: f.month(plan.last_month) })}</div>
      </div>
    </li>
  )
}
