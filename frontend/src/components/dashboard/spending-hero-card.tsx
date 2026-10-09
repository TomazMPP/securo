import { useTranslation, Trans } from 'react-i18next'
import { Lightbulb } from 'lucide-react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { Pill } from '@/components/dashboard/dashboard-card'
import { formatCurrency } from '@/lib/format'
import { formatWholeCurrency, type CategoryChange, type CumulativePoint } from '@/lib/dashboard-insights'
import { cn } from '@/lib/utils'

export interface SpendingHeroProps {
  loading: boolean
  /** Month has not started yet: nothing to show but an empty state. */
  isFuture: boolean
  isCurrentMonth: boolean
  spent: number
  /** Spend over the same stretch of the previous month; null when unknown. */
  previousSamePeriod: number | null
  /** "9 de setembro" (current month) or "setembro" (past month). */
  comparisonDate: string
  currentMonthName: string
  previousMonthName: string
  series: CumulativePoint[]
  lastDay: number
  insight: CategoryChange | null
  hasPreviousData: boolean
  currency: string
  locale: string
  mask: (value: string) => string
  onOpen?: () => void
}

/**
 * The dashboard's main KPI: month-to-date spend, framed in the primary colour,
 * with the same stretch of last month as the yardstick and one sentence that
 * explains the biggest move underneath it.
 */
export function SpendingHeroCard(props: SpendingHeroProps) {
  const { t } = useTranslation()
  const {
    loading, isFuture, isCurrentMonth, spent, previousSamePeriod, comparisonDate,
    currentMonthName, previousMonthName, series, lastDay, insight, hasPreviousData,
    currency, locale, mask, onOpen,
  } = props

  const delta = previousSamePeriod != null ? spent - previousSamePeriod : null
  const isBelow = delta != null && delta < 0
  const lineTone = delta == null || Math.abs(delta) < 0.5
    ? 'text-primary'
    : isBelow
      ? 'text-[#0F8A4B] dark:text-emerald-400'
      : 'text-[#B42323] dark:text-rose-400'
  const lastPoint = series.find((p) => p.day === lastDay)

  const insightText = (() => {
    if (isFuture) return t('dashboard.heroFutureInsight')
    if (!hasPreviousData) return t('dashboard.insightNoHistory')
    if (!insight) return t(isCurrentMonth ? 'dashboard.insightNoneSamePeriod' : 'dashboard.insightNonePrevMonth')
    const key = insight.delta < 0
      ? (isCurrentMonth ? 'dashboard.insightLessSamePeriod' : 'dashboard.insightLessPrevMonth')
      : (isCurrentMonth ? 'dashboard.insightMoreSamePeriod' : 'dashboard.insightMorePrevMonth')
    return (
      <Trans
        i18nKey={key}
        values={{
          amount: mask(formatWholeCurrency(Math.abs(insight.delta), currency, locale)),
          category: insight.label,
        }}
        components={{ b: <b className="font-bold" /> }}
      />
    )
  })()

  return (
    <section
      aria-labelledby="dash-hero-title"
      className="flex min-w-0 flex-col rounded-[20px] bg-primary p-1"
    >
      <div className="rounded-[17px] bg-card px-5 pt-5 pb-2 sm:px-[22px] sm:pt-[22px]">
        <div className="flex items-center justify-between gap-2">
          <h2 id="dash-hero-title" className="m-0 text-[13.5px] font-medium text-muted-foreground tracking-normal">
            {isCurrentMonth || isFuture ? t('dashboard.spentToDate') : t('dashboard.spentInMonth')}
          </h2>
          {onOpen && !isFuture && (
            <button
              type="button"
              onClick={onOpen}
              className="text-xs font-medium text-primary hover:underline cursor-pointer"
            >
              {t('dashboard.seeTransactions')}
            </button>
          )}
        </div>

        {loading ? (
          <>
            <Skeleton className="mt-2 h-10 w-48" />
            <Skeleton className="mt-3 h-[150px] w-full" />
          </>
        ) : (
          <>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="text-[32px] sm:text-[38px] font-bold leading-tight tracking-[-0.02em] tabular-nums text-foreground">
                {mask(formatWholeCurrency(isFuture ? 0 : spent, currency, locale))}
              </span>
              {!isFuture && delta != null && (
                <>
                  <Pill tone={Math.abs(delta) < 0.5 ? 'neutral' : isBelow ? 'up' : 'down'}>
                    {Math.abs(delta) < 0.5
                      ? t('dashboard.spentSame')
                      : t(isBelow ? 'dashboard.spentLess' : 'dashboard.spentMore', {
                          amount: mask(formatWholeCurrency(Math.abs(delta), currency, locale)),
                        })}
                  </Pill>
                  <span className="text-[13.5px] text-muted-foreground">
                    {isCurrentMonth
                      ? t('dashboard.vsSameDay', { date: comparisonDate })
                      : t('dashboard.vsPrevMonth', { month: comparisonDate })}
                  </span>
                </>
              )}
            </div>

            {isFuture ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{t('dashboard.heroFuture')}</p>
            ) : (
              <div className="mt-2">
                <div className="flex items-center justify-end gap-3 text-[11.5px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={cn('inline-block h-[3px] w-3.5 rounded-full bg-current', lineTone)} />
                    {currentMonthName}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-3.5 border-t-2 border-dashed border-muted-foreground/60" />
                    {previousMonthName}
                  </span>
                </div>
                <div
                  className={cn('h-[150px] w-full', lineTone)}
                  role="img"
                  aria-label={t('dashboard.heroChartLabel', { current: currentMonthName, previous: previousMonthName })}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={series} margin={{ top: 12, right: 36, bottom: 4, left: 4 }}>
                      <XAxis dataKey="day" hide type="number" domain={[1, 'dataMax']} />
                      <YAxis hide domain={[0, 'auto']} />
                      <ReferenceLine y={0} stroke="var(--border)" />
                      <RechartsTooltip
                        cursor={{ stroke: 'var(--border)' }}
                        contentStyle={{
                          background: 'var(--popover)',
                          border: '1px solid var(--border)',
                          borderRadius: 12,
                          fontSize: 12,
                          color: 'var(--popover-foreground)',
                        }}
                        labelFormatter={(day) => t('dashboard.day', { day })}
                        formatter={(value, name) => [
                          mask(formatCurrency(Number(value), currency, locale)),
                          name === 'current' ? currentMonthName : previousMonthName,
                        ]}
                      />
                      <Line
                        type="monotone"
                        dataKey="previous"
                        stroke="var(--muted-foreground)"
                        strokeOpacity={0.6}
                        strokeWidth={2}
                        strokeDasharray="5 6"
                        dot={false}
                        isAnimationActive={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="current"
                        stroke="currentColor"
                        strokeWidth={3}
                        strokeLinecap="round"
                        isAnimationActive={false}
                        dot={(dotProps: { cx?: number; cy?: number; payload?: CumulativePoint; index?: number }) => {
                          const { cx, cy, payload, index } = dotProps
                          if (!isCurrentMonth || !lastPoint || payload?.day !== lastDay || cx == null || cy == null) {
                            return <g key={`dot-${index}`} />
                          }
                          return (
                            <g key={`dot-${index}`}>
                              <circle cx={cx} cy={cy} r={6} fill="currentColor" stroke="var(--card)" strokeWidth={3} />
                              <text x={cx + 10} y={cy - 6} fontSize={12} fontWeight={600} fill="currentColor">
                                {t('dashboard.today')}
                              </text>
                            </g>
                          )
                        }}
                        activeDot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-5 pt-4 pb-3.5 text-primary-foreground">
        <div className="flex items-center gap-2 text-sm font-bold">
          <Lightbulb className="size-4" aria-hidden="true" />
          {t('dashboard.insightTitle')}
        </div>
        <p className="mt-1.5 mb-1 text-sm leading-relaxed">
          {loading ? <span className="inline-block h-4 w-3/4 rounded bg-primary-foreground/20" /> : insightText}
        </p>
      </div>
    </section>
  )
}
