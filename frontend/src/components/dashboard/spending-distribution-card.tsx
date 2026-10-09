import { useTranslation } from 'react-i18next'
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import { PieChart as PieChartIcon } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { CategoryIcon } from '@/components/category-icon'
import { DashboardCard, CardHeading, CardEmpty, Pill } from '@/components/dashboard/dashboard-card'
import { formatPercent, formatWholeCurrency } from '@/lib/dashboard-insights'

export interface DistributionSlice {
  key: string
  categoryId: string | null
  name: string
  icon: string | null
  color: string
  amount: number
  /** "Outros": the long tail folded into one row, not clickable. */
  isOther?: boolean
}

const OTHER_COLOR = '#A0A7B4'

/** Donut + ranked list of where this month's money went. */
export function SpendingDistributionCard({
  loading,
  slices,
  total,
  currency,
  locale,
  mask,
  linkTo,
  onSliceClick,
}: {
  loading: boolean
  slices: DistributionSlice[]
  total: number
  currency: string
  locale: string
  mask: (value: string) => string
  linkTo?: string
  onSliceClick?: (slice: DistributionSlice) => void
}) {
  const { t } = useTranslation()

  return (
    <DashboardCard labelledBy="dash-distribution-title">
      <CardHeading
        id="dash-distribution-title"
        title={t('dashboard.distributionTitle')}
        to={linkTo}
        linkLabel={t('dashboard.openCategories')}
      />
      {loading ? (
        <div className="mt-3 flex flex-wrap items-center gap-6">
          <Skeleton className="size-[180px] rounded-full" />
          <div className="flex-1 space-y-3 min-w-[200px]">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
          </div>
        </div>
      ) : slices.length === 0 ? (
        <CardEmpty icon={<PieChartIcon className="size-7" />}>{t('dashboard.distributionEmpty')}</CardEmpty>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center justify-center gap-6">
          <div className="relative size-[180px] sm:size-[200px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="amount"
                  nameKey="name"
                  innerRadius="69%"
                  outerRadius="91%"
                  startAngle={90}
                  endAngle={-270}
                  paddingAngle={slices.length > 1 ? 1.2 : 0}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {slices.map((s) => (
                    <Cell key={s.key} fill={s.isOther ? OTHER_COLOR : s.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[13.5px] font-medium text-muted-foreground">{t('dashboard.total')}</span>
              <span className="text-[22px] font-bold tabular-nums text-foreground">
                {mask(formatWholeCurrency(total, currency, locale))}
              </span>
            </div>
          </div>

          <ul className="m-0 flex min-w-0 flex-[1_1_240px] list-none flex-col p-0">
            {slices.map((s) => {
              const pct = total > 0 ? (s.amount / total) * 100 : 0
              const content = (
                <>
                  {s.isOther ? (
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-bold text-muted-foreground">…</span>
                  ) : (
                    <CategoryIcon icon={s.icon} color={s.color} size="sm" />
                  )}
                  <span className="truncate text-sm font-medium text-foreground">{s.name}</span>
                  <Pill className="shrink-0">{formatPercent(pct, locale)}</Pill>
                  <span className="ml-auto shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {mask(formatWholeCurrency(s.amount, currency, locale))}
                  </span>
                </>
              )
              return (
                <li key={s.key} className="border-b border-border/70 last:border-b-0">
                  {onSliceClick && !s.isOther ? (
                    <button
                      type="button"
                      onClick={() => onSliceClick(s)}
                      className="flex w-full min-w-0 items-center gap-3 py-2 text-left cursor-pointer rounded-md hover:bg-muted/50 transition-colors"
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex min-w-0 items-center gap-3 py-2">{content}</div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </DashboardCard>
  )
}
