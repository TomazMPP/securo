import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Link } from 'react-router-dom'
import { CalendarClock, Check, ChevronRight, PiggyBank, Tags } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DashboardCard, CardHeading, Pill, ProgressBar } from '@/components/dashboard/dashboard-card'
import { formatCurrency } from '@/lib/format'
import { formatPercent, type EndingInstallments } from '@/lib/dashboard-insights'
import type { GoalSummary } from '@/types'

export type NextStep =
  | { id: 'installments'; signature: string; data: EndingInstallments; goal: GoalSummary | null }
  | { id: 'uncategorized'; signature: string; count: number; amount: number }
  | { id: 'budget'; signature: string; category: string; spent: number; budget: number }

const DISMISS_KEY = 'securo.dashboard.dismissedSteps'

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeDismissed(values: string[]) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(values.slice(-50)))
  } catch {
    // Storage blocked: dismissal just lasts for this visit.
  }
}

/**
 * One actionable suggestion derived from the user's own data, with a single
 * primary action. Cycles through what qualifies; "Not now" hides a
 * suggestion until its underlying numbers change.
 */
export function NextStepCard({
  loading,
  steps,
  currency,
  locale,
  uiLocale,
  mask,
  onCategorize,
}: {
  loading: boolean
  steps: NextStep[]
  currency: string
  locale: string
  uiLocale: string
  mask: (value: string) => string
  onCategorize: () => void
}) {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState<string[]>(readDismissed)
  const [index, setIndex] = useState(0)

  const visible = steps.filter((s) => !dismissed.includes(`${s.id}:${s.signature}`))
  const current = visible.length > 0 ? visible[index % visible.length] : null

  const monthName = (ym: string) => {
    const [y, m] = ym.split('-').map(Number)
    return new Date(y, m - 1, 2).toLocaleDateString(uiLocale, { month: 'long' })
  }
  const money = (v: number, ccy = currency) => mask(formatCurrency(v, ccy, locale))

  const dismiss = () => {
    if (!current) return
    const next = [...dismissed, `${current.id}:${current.signature}`]
    setDismissed(next)
    writeDismissed(next)
  }

  const iconBox = (tone: 'up' | 'down' | 'info', icon: React.ReactNode) => (
    <span
      className={`flex size-9 shrink-0 items-center justify-center rounded-[10px] ${
        tone === 'up'
          ? 'bg-[#E5F5EC] text-[#0B7A41] dark:bg-emerald-500/15 dark:text-emerald-300'
          : tone === 'down'
            ? 'bg-[#FDECEC] text-[#B42323] dark:bg-rose-500/15 dark:text-rose-300'
            : 'bg-accent text-accent-foreground'
      }`}
      aria-hidden="true"
    >
      {icon}
    </span>
  )

  let body: React.ReactNode = null
  if (current?.id === 'installments') {
    const { data, goal } = current
    body = (
      <>
        <div className="mt-3.5 flex items-center gap-2.5">
          {iconBox('up', <CalendarClock className="size-[18px]" />)}
          <span className="text-base font-bold leading-snug text-foreground">
            {t('dashboard.stepInstallmentsTitle', { count: data.count, month: monthName(data.endMonth) })}
          </span>
        </div>
        <p className="mt-2.5 text-sm leading-relaxed text-foreground/80">
          <Trans
            i18nKey="dashboard.stepInstallmentsBody"
            values={{ month: monthName(data.freedFrom), amount: money(data.monthlyAmount) }}
            components={{ b: <b className="font-bold tabular-nums text-foreground" /> }}
          />
          {goal && (
            <>
              {' '}
              <Trans
                i18nKey="dashboard.stepInstallmentsGoal"
                values={{ goal: goal.name }}
                components={{ b: <b className="font-bold text-foreground" /> }}
              />
            </>
          )}
        </p>
        {goal && (
          <>
            <ProgressBar value={goal.percentage} className="mt-4" barClassName="bg-[#0F8A4B] dark:bg-emerald-400" label={goal.name} />
            <div className="mt-1.5 text-[12.5px] tabular-nums text-muted-foreground">
              <Trans
                i18nKey="dashboard.stepGoalProgress"
                values={{
                  goal: goal.name,
                  current: money(goal.current_amount, goal.currency),
                  target: money(goal.target_amount, goal.currency),
                }}
                components={{ b: <b className="font-semibold text-foreground" /> }}
              />
            </div>
          </>
        )}
      </>
    )
  } else if (current?.id === 'uncategorized') {
    body = (
      <>
        <div className="mt-3.5 flex items-center gap-2.5">
          {iconBox('info', <Tags className="size-[18px]" />)}
          <span className="text-base font-bold leading-snug text-foreground">
            {t('dashboard.stepUncategorizedTitle', { count: current.count })}
          </span>
        </div>
        <p className="mt-2.5 text-sm leading-relaxed text-foreground/80">
          {current.amount > 0 && (
            <>
              <Trans
                i18nKey="dashboard.stepUncategorizedAmount"
                values={{ amount: money(current.amount) }}
                components={{ b: <b className="font-bold tabular-nums text-foreground" /> }}
              />{' '}
            </>
          )}
          {t('dashboard.stepUncategorizedBody')}
        </p>
      </>
    )
  } else if (current?.id === 'budget') {
    const pct = current.budget > 0 ? (current.spent / current.budget) * 100 : 0
    body = (
      <>
        <div className="mt-3.5 flex items-center gap-2.5">
          {iconBox('down', <PiggyBank className="size-[18px]" />)}
          <span className="text-base font-bold leading-snug text-foreground">
            {t('dashboard.stepBudgetTitle', { category: current.category })}
          </span>
        </div>
        <p className="mt-2.5 text-sm leading-relaxed text-foreground/80">
          <Trans
            i18nKey="dashboard.stepBudgetBody"
            values={{ pct: formatPercent(pct, locale), spent: money(current.spent), budget: money(current.budget) }}
            components={{ b: <b className="font-bold tabular-nums text-foreground" /> }}
          />
        </p>
        <ProgressBar value={100} className="mt-4" barClassName="bg-[#B42323] dark:bg-rose-400" label={current.category} />
      </>
    )
  }

  const primaryAction = (() => {
    if (!current) return null
    const cls = 'flex-1 h-11 rounded-xl text-sm font-semibold'
    if (current.id === 'installments') {
      return current.goal ? (
        <Button asChild className={cls}><Link to="/goals">{t('dashboard.stepOpenGoals')}</Link></Button>
      ) : (
        <Button asChild className={cls}><Link to="/transactions">{t('dashboard.stepOpenTransactions')}</Link></Button>
      )
    }
    if (current.id === 'uncategorized') {
      return <Button className={cls} onClick={onCategorize}>{t('dashboard.categorizeNow')}</Button>
    }
    return <Button asChild className={cls}><Link to="/budgets">{t('dashboard.stepOpenBudgets')}</Link></Button>
  })()

  return (
    <DashboardCard labelledBy="dash-next-title" className="flex flex-col">
      <CardHeading
        id="dash-next-title"
        title={t('dashboard.nextStepTitle')}
        aside={visible.length > 1 && (
          <button
            type="button"
            onClick={() => setIndex((i) => (i + 1) % visible.length)}
            aria-label={t('dashboard.nextStepNext')}
            className="cursor-pointer"
          >
            <Pill className="hover:bg-border transition-colors">
              {t('dashboard.nextStepCounter', { current: (index % visible.length) + 1, total: visible.length })}
              <ChevronRight className="size-3" aria-hidden="true" />
            </Pill>
          </button>
        )}
      />
      {loading ? (
        <>
          <Skeleton className="mt-4 h-9 w-3/4" />
          <Skeleton className="mt-3 h-16 w-full" />
          <Skeleton className="mt-6 h-11 w-full" />
        </>
      ) : !current ? (
        <>
          <div className="mt-3.5 flex items-center gap-2.5">
            {iconBox('up', <Check className="size-[18px]" />)}
            <span className="text-base font-bold leading-snug text-foreground">{t('dashboard.nextStepEmptyTitle')}</span>
          </div>
          <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{t('dashboard.nextStepEmptyBody')}</p>
        </>
      ) : (
        <>
          {body}
          <div className="min-h-4 flex-1" />
          <div className="mt-4 flex flex-wrap gap-2">
            {primaryAction}
            <Button variant="ghost" className="h-11 rounded-xl px-3.5 text-sm font-semibold text-muted-foreground" onClick={dismiss}>
              {t('dashboard.notNow')}
            </Button>
          </div>
        </>
      )}
    </DashboardCard>
  )
}
