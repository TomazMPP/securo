import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { dashboard, reports } from '@/lib/api'
import { buildMonthStrip, formatCompactNet, monthStripLabel, type MonthStripPoint } from '@/lib/transactions-grouping'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const PAST_MONTHS = 6
const FUTURE_MONTHS = 6
// Width of one month slot in the SVG's own coordinate space. The buttons
// below share the row evenly, so slot centres line up with the points.
const SLOT = 100
const CHART_HEIGHT = 56
const CHART_PAD = 8

function linePath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
}

type TransactionsMonthStripProps = {
  /** Current month (`YYYY-MM`) in the workspace's time zone. */
  currentMonth: string
  /** Month shown in the list, or null for a custom range. */
  selectedMonth: string | null
  onSelectMonth: (month: string) => void
  /** Account scope, as the list uses it. Empty means every account. */
  accountIds: string[]
  /** A wallet-only collection: nothing to fetch, nothing to show. */
  disabled?: boolean
  currency: string
  /** Number-format locale for the amounts. */
  locale: string
  /** Language for the month names. */
  labelLocale: string
}

/**
 * Twelve months of net results, six booked and six projected, as one row of
 * buttons that double as the page's month picker. A line ties the values
 * together: solid where it is history, dashed where it is a forecast.
 */
export function TransactionsMonthStrip({
  currentMonth,
  selectedMonth,
  onSelectMonth,
  accountIds,
  disabled = false,
  currency,
  locale,
  labelLocale,
}: TransactionsMonthStripProps) {
  const { t } = useTranslation()
  const { mask } = usePrivacyMode()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const scope = accountIds.length > 0 ? accountIds : undefined

  const { data: trend, isError: trendError } = useQuery({
    queryKey: ['dashboard', 'monthly-trend', PAST_MONTHS, scope ?? null],
    queryFn: () => dashboard.monthlyTrend(PAST_MONTHS, scope),
    enabled: !disabled,
    staleTime: 60_000,
  })
  // One month beyond the strip so its last month is a full forecast rather
  // than one cut off at today's day-of-month.
  const { data: cashFlow, isError: flowError } = useQuery({
    queryKey: ['reports', 'cash-flow', FUTURE_MONTHS + 1, 'monthly', scope ?? null],
    queryFn: () => reports.cashFlow(FUTURE_MONTHS + 1, 'monthly', false, scope),
    enabled: !disabled,
    staleTime: 60_000,
  })

  const points: MonthStripPoint[] = useMemo(
    () => buildMonthStrip(
      currentMonth,
      disabled ? [] : trendError ? [] : trend,
      disabled ? undefined : flowError ? undefined : cashFlow,
      PAST_MONTHS,
      FUTURE_MONTHS,
    ),
    [currentMonth, trend, cashFlow, disabled, trendError, flowError],
  )

  // Keep the selected month in view on narrow screens, where the strip scrolls.
  useEffect(() => {
    const container = scrollRef.current
    const el = selectedRef.current
    if (!container || !el || container.scrollWidth <= container.clientWidth) return
    container.scrollLeft = el.offsetLeft - container.clientWidth / 2 + el.clientWidth / 2
  }, [selectedMonth, points.length])

  const known = points.filter((p) => p.net != null).map((p) => p.net as number)
  const max = Math.max(0, ...known)
  const min = Math.min(0, ...known)
  const span = max - min || 1
  const coords = points.map((p, i) => ({
    x: i * SLOT + SLOT / 2,
    y: p.net == null
      ? null
      : CHART_PAD + ((max - p.net) / span) * (CHART_HEIGHT - CHART_PAD * 2),
    projected: p.projected,
  }))
  const pastCoords = coords.filter((c) => !c.projected && c.y != null) as { x: number; y: number }[]
  // The dashed segment starts at the last booked month so the line is continuous.
  const futureCoords = coords.filter(
    (c, i) => c.y != null && (c.projected || i === PAST_MONTHS - 1),
  ) as { x: number; y: number }[]
  const zeroY = CHART_PAD + (max / span) * (CHART_HEIGHT - CHART_PAD * 2)
  const loading = !disabled && points.every((p) => p.net == null)

  return (
    <section
      className="mb-5 rounded-2xl border border-border bg-card px-3 pb-3 pt-3.5 sm:px-4"
      aria-label={t('transactions.monthStrip.title')}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-1 pb-2">
        <span className="text-[13px] font-medium text-muted-foreground">{t('transactions.monthStrip.title')}</span>
        <span className="text-xs text-muted-foreground">{t('transactions.monthStrip.legend')}</span>
      </div>
      <div ref={scrollRef} className="overflow-x-auto">
        <div className="relative min-w-[900px]">
          {loading ? (
            <Skeleton className="mb-2 h-[56px] w-full" />
          ) : (
            <svg
              viewBox={`0 0 ${SLOT * points.length} ${CHART_HEIGHT}`}
              preserveAspectRatio="none"
              className="block h-14 w-full"
              aria-hidden="true"
            >
              {min < 0 && (
                <line
                  x1={0}
                  x2={SLOT * points.length}
                  y1={zeroY}
                  y2={zeroY}
                  className="stroke-border"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {pastCoords.length > 1 && (
                <path
                  d={linePath(pastCoords)}
                  fill="none"
                  className="stroke-primary"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {futureCoords.length > 1 && (
                <path
                  d={linePath(futureCoords)}
                  fill="none"
                  className="stroke-muted-foreground/60"
                  strokeWidth={2}
                  strokeDasharray="6 6"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          )}
          <div className="flex gap-2">
            {points.map((p) => {
              const selected = p.month === selectedMonth
              const isCurrent = p.month === currentMonth
              const value = p.net == null ? '—' : mask(formatCompactNet(p.net, currency, locale))
              return (
                <button
                  key={p.month}
                  ref={selected ? selectedRef : undefined}
                  type="button"
                  aria-pressed={selected}
                  aria-current={isCurrent ? 'date' : undefined}
                  title={p.projected ? t('transactions.monthStrip.projectedTooltip') : undefined}
                  onClick={() => onSelectMonth(p.month)}
                  className={cn(
                    'min-w-[68px] flex-1 cursor-pointer rounded-xl border px-1.5 pb-2.5 pt-2 text-center transition-colors',
                    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30',
                    p.projected
                      ? 'border-dashed border-border bg-muted/40 hover:bg-muted'
                      : 'border-border bg-card hover:bg-muted/60',
                    selected && 'border-2 border-solid border-primary bg-primary/5 hover:bg-primary/10',
                  )}
                >
                  <div className={cn('text-xs font-semibold text-muted-foreground', isCurrent && 'text-foreground')}>
                    {monthStripLabel(p.month, labelLocale)}
                  </div>
                  <div
                    className={cn(
                      'mt-1 text-sm font-bold tabular-nums',
                      p.net == null || p.projected
                        ? 'text-muted-foreground'
                        : p.net < 0
                          ? 'text-[#B42323] dark:text-rose-400'
                          : 'text-[#0B7A41] dark:text-emerald-400',
                    )}
                  >
                    {value}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
