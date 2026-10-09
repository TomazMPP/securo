import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import type { CommitmentKind, ForecastMonth } from '@/lib/recurring-overview'
import { SERIES_COLOR } from './series'
import { SectionCard, Swatch } from './recurring-ui'

const SERIES: { kind: CommitmentKind; key: 'fixed' | 'installments' | 'financing'; label: string }[] = [
  { kind: 'fixed', key: 'fixed', label: 'recurring.fixedBills' },
  { kind: 'installment', key: 'installments', label: 'recurring.installments' },
  { kind: 'financing', key: 'financing', label: 'recurring.financing' },
]

function shortMonth(month: string, locale: string): string {
  const [y, m] = month.split('-').map(Number)
  const label = new Date(y, m - 1, 2).toLocaleDateString(locale, { month: 'short' }).replace('.', '')
  return label.charAt(0).toUpperCase() + label.slice(1)
}

function longMonth(month: string, locale: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 2).toLocaleDateString(locale, { month: 'long' })
}

function compact(value: number, locale: string, currency: string | null): string {
  try {
    return new Intl.NumberFormat(locale, {
      ...(currency ? { style: 'currency' as const, currency } : {}),
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  } catch {
    return String(Math.round(value))
  }
}

interface TooltipEntry {
  dataKey?: string | number
  value?: number | string
  payload?: ForecastMonth
}

/**
 * Stacked bars for the next six months: fixed bills, card installments and,
 * when there are loans, financing. The first bar is the month on screen; the
 * rest are dimmed as forecast. A line under the chart says when installment
 * plans end and how much they free, only when the data shows it.
 */
export function RecurringForecastCard({
  forecast,
  hasLoans,
  relief,
  locale,
  currency,
  formatMoney,
  mask,
}: {
  forecast: ForecastMonth[]
  hasLoans: boolean
  relief: { month: string; count: number; amount: number } | null
  locale: string
  currency: string
  formatMoney: (value: number) => string
  mask: (value: string) => string
}) {
  const { t } = useTranslation()
  // On narrow cards the bars are too close for "R$ 8,2 mil"; drop the symbol.
  const [narrow, setNarrow] = useState(false)
  const series = SERIES.filter((s) => s.kind !== 'financing' || hasLoans)
  const data = forecast.map((m) => ({ ...m, label: shortMonth(m.month, locale) }))
  const empty = forecast.every((m) => m.total === 0)
  const topKey = series[series.length - 1].key

  return (
    <SectionCard className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="m-0 text-sm font-medium text-muted-foreground">{t('recurring.nextSixMonths')}</h2>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <Swatch kind={s.kind} />
              {t(s.label)}
            </span>
          ))}
        </div>
      </div>

      {empty ? (
        <p className="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted-foreground">
          {t('recurring.forecastEmpty')}
        </p>
      ) : (
        <div className="mt-4 h-[220px]" role="img" aria-label={t('recurring.nextSixMonths')}>
          <ResponsiveContainer width="100%" height="100%" onResize={(width) => setNarrow(width < 480)}>
            <BarChart data={data} margin={{ top: 22, right: 4, bottom: 0, left: 4 }} barCategoryGap="22%">
              <XAxis
                dataKey="label"
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
                tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
              />
              <Tooltip
                cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
                content={({ active, payload }) => {
                  const entries = (payload ?? []) as TooltipEntry[]
                  if (!active || entries.length === 0) return null
                  const row = entries[0].payload!
                  return (
                    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs shadow-md">
                      <p className="mb-1 font-semibold capitalize text-foreground">{longMonth(row.month, locale)}</p>
                      {series.map((s) => (
                        <p key={s.key} className="flex items-center gap-2 text-muted-foreground">
                          <Swatch kind={s.kind} />
                          {t(s.label)}
                          <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">{formatMoney(row[s.key])}</span>
                        </p>
                      ))}
                      <p className="mt-1 flex border-t border-border pt-1 font-semibold text-foreground">
                        {t('recurring.total')}
                        <span className="ml-auto pl-3 tabular-nums">{formatMoney(row.total)}</span>
                      </p>
                    </div>
                  )
                }}
              />
              {series.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  stackId="commitments"
                  fill={SERIES_COLOR[s.kind]}
                  stroke="var(--card)"
                  strokeWidth={1}
                  maxBarSize={46}
                  radius={s.key === topKey ? [4, 4, 0, 0] : 0}
                  isAnimationActive={false}
                >
                  {data.map((row, i) => (
                    <Cell key={row.month} fillOpacity={i === 0 ? 1 : 0.55} />
                  ))}
                  {s.key === topKey && (
                    <LabelList
                      dataKey="total"
                      position="top"
                      formatter={(value: unknown) => mask(compact(Number(value) || 0, locale, narrow ? null : currency))}
                      style={{ fontSize: narrow ? 11 : 12, fontWeight: 600, fill: 'var(--foreground)' }}
                    />
                  )}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {relief && (
        <p className="mt-3.5 rounded-xl bg-[#F5FAF7] px-3.5 py-3 text-[13.5px] leading-normal text-[#24432F] dark:bg-emerald-500/10 dark:text-emerald-200">
          <Trans
            i18nKey="recurring.reliefLine"
            count={relief.count}
            values={{ month: longMonth(relief.month, locale), amount: formatMoney(relief.amount) }}
            components={{ b: <b className="font-semibold tabular-nums" /> }}
          />
        </p>
      )}
    </SectionCard>
  )
}
