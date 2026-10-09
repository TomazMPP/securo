import { useTranslation } from 'react-i18next'
import { AreaChart, Area, YAxis, ResponsiveContainer } from 'recharts'
import { Skeleton } from '@/components/ui/skeleton'
import { DashboardCard, CardHeading, Pill } from '@/components/dashboard/dashboard-card'
import { formatSignedPercent, formatWholeCurrency } from '@/lib/dashboard-insights'

/** Net worth with its two halves (what you own, what you owe) and a trend line. */
export function NetWorthCard({
  loading,
  netWorth,
  assets,
  debts,
  trend,
  changePercent,
  currency,
  locale,
  mask,
  linkTo,
}: {
  loading: boolean
  netWorth: number
  assets: number
  debts: number
  trend: { date: string; value: number }[]
  /** Change against the previous month-end, when the history has one. */
  changePercent: number | null
  currency: string
  locale: string
  mask: (value: string) => string
  linkTo?: string
}) {
  const { t } = useTranslation()

  return (
    <DashboardCard labelledBy="dash-networth-title">
      <CardHeading id="dash-networth-title" title={t('dashboard.netWorth')} to={linkTo} linkLabel={t('dashboard.openNetWorth')} />
      {loading ? (
        <>
          <Skeleton className="mt-2 h-9 w-44" />
          <Skeleton className="mt-3 h-10 w-56" />
          <Skeleton className="mt-3 h-[70px] w-full" />
        </>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <span className={`text-[30px] font-bold leading-tight tracking-[-0.02em] tabular-nums ${netWorth < 0 ? 'text-[#B42323] dark:text-rose-400' : 'text-foreground'}`}>
              {mask(formatWholeCurrency(netWorth, currency, locale))}
            </span>
            {changePercent != null && (
              <Pill tone={changePercent >= 0 ? 'up' : 'down'} title={t('dashboard.vsLastMonthHint')}>
                {formatSignedPercent(changePercent, locale)}
              </Pill>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-[22px] gap-y-2 text-[13px]">
            <div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                {t('dashboard.assets')}
              </div>
              <div className="text-[15px] font-bold tabular-nums text-foreground">{mask(formatWholeCurrency(assets, currency, locale))}</div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full bg-[#E08A1E]" aria-hidden="true" />
                {t('dashboard.debts')}
              </div>
              <div className="text-[15px] font-bold tabular-nums text-foreground">{mask(formatWholeCurrency(debts, currency, locale))}</div>
            </div>
          </div>
          {trend.length > 1 ? (
            <div className="mt-3 h-[70px] w-full" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <YAxis hide domain={['dataMin', 'dataMax']} />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="var(--primary)"
                    strokeWidth={2.5}
                    fill="var(--primary)"
                    fillOpacity={0.1}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">{t('dashboard.netWorthNoHistory')}</p>
          )}
        </>
      )}
    </DashboardCard>
  )
}
