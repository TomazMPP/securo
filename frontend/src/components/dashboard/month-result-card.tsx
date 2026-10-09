import { useTranslation, Trans } from 'react-i18next'
import { Skeleton } from '@/components/ui/skeleton'
import { DashboardCard, CardHeading, Pill } from '@/components/dashboard/dashboard-card'
import { formatCurrency } from '@/lib/format'
import { formatPercent, formatSignedPercent, formatWholeCurrency } from '@/lib/dashboard-insights'

/**
 * Net result of the month (income minus expenses) with what it means in
 * plain words, and the two numbers it is made of.
 */
export function MonthResultCard({
  loading,
  income,
  expenses,
  projectedIncome,
  projectedExpenses,
  changePercent,
  isCurrentMonth,
  currency,
  locale,
  mask,
  linkTo,
  onIncomeClick,
  onExpensesClick,
}: {
  loading: boolean
  income: number
  expenses: number
  projectedIncome: number
  projectedExpenses: number
  /** Change of the net result against the same period last month. */
  changePercent: number | null
  isCurrentMonth: boolean
  currency: string
  locale: string
  mask: (value: string) => string
  linkTo?: string
  onIncomeClick?: () => void
  onExpensesClick?: () => void
}) {
  const { t } = useTranslation()
  const net = income - expenses

  const meaning = (() => {
    if (income < 0.01 && expenses < 0.01) return t('dashboard.resultEmpty')
    if (net < 0) {
      return (
        <Trans
          i18nKey={isCurrentMonth ? 'dashboard.resultOverspentSoFar' : 'dashboard.resultOverspent'}
          values={{ amount: mask(formatWholeCurrency(Math.abs(net), currency, locale)) }}
          components={{ b: <b className="font-semibold text-[#B42323] dark:text-rose-400" /> }}
        />
      )
    }
    const pct = income > 0 ? (net / income) * 100 : 0
    return (
      <Trans
        i18nKey={isCurrentMonth ? 'dashboard.resultSavedSoFar' : 'dashboard.resultSaved'}
        values={{ pct: formatPercent(pct, locale) }}
        components={{ b: <b className="font-semibold text-[#0B7A41] dark:text-emerald-400" /> }}
      />
    )
  })()

  const tile = (
    kind: 'income' | 'expenses',
    value: number,
    projected: number,
    onClick?: () => void,
  ) => {
    const isIncome = kind === 'income'
    const body = (
      <>
        <div className={`text-[13px] font-semibold ${isIncome ? 'text-[#0B7A41] dark:text-emerald-400' : 'text-[#B42323] dark:text-rose-400'}`}>
          {isIncome ? t('dashboard.income') : t('dashboard.expenses')}
        </div>
        <div className="mt-0.5 text-[17px] font-bold tabular-nums text-foreground">
          {mask(formatWholeCurrency(value, currency, locale))}
        </div>
        {Math.abs(projected - value) >= 0.01 && (
          <div className="mt-0.5 text-[11.5px] text-muted-foreground tabular-nums">
            {t('dashboard.expectedShort', { amount: mask(formatCurrency(projected, currency, locale)) })}
          </div>
        )}
      </>
    )
    const cls = `min-w-0 rounded-xl px-3.5 py-3 text-left ${isIncome ? 'bg-[#F5FAF7] dark:bg-emerald-500/10' : 'bg-[#FDF6F6] dark:bg-rose-500/10'}`
    return onClick ? (
      <button type="button" onClick={onClick} className={`${cls} cursor-pointer hover:opacity-80 transition-opacity`}>
        {body}
      </button>
    ) : (
      <div className={cls}>{body}</div>
    )
  }

  return (
    <DashboardCard labelledBy="dash-result-title">
      <CardHeading id="dash-result-title" title={t('dashboard.resultTitle')} to={linkTo} linkLabel={t('dashboard.openReports')} />
      {loading ? (
        <>
          <Skeleton className="mt-2 h-9 w-40" />
          <Skeleton className="mt-2 h-4 w-56" />
          <div className="mt-[18px] grid grid-cols-2 gap-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <span className={`text-[30px] font-bold leading-tight tracking-[-0.02em] tabular-nums ${net < 0 ? 'text-[#B42323] dark:text-rose-400' : 'text-foreground'}`}>
              {mask(formatWholeCurrency(net, currency, locale))}
            </span>
            {changePercent != null && (
              <Pill tone={changePercent >= 0 ? 'up' : 'down'} title={t('dashboard.vsSamePeriodHint')}>
                {formatSignedPercent(changePercent, locale)}
              </Pill>
            )}
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{meaning}</p>
          <div className="mt-[18px] grid grid-cols-2 gap-3">
            {tile('income', income, projectedIncome, onIncomeClick)}
            {tile('expenses', expenses, projectedExpenses, onExpensesClick)}
          </div>
        </>
      )}
    </DashboardCard>
  )
}
