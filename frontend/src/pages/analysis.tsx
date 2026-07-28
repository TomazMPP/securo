import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ResponsiveContainer, Tooltip, Treemap } from 'recharts'
import { ArrowDownRight, ArrowUpRight, HelpCircle, Repeat } from 'lucide-react'
import { analysis } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { PageHeader } from '@/components/page-header'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { useAuth } from '@/contexts/auth-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import type { AnalysisSide, PeriodAnalysis } from '@/types'

function formatCurrency(value: number, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value)
}

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type RangeKey = 'thisMonth' | 'lastMonth' | 'last3' | 'thisYear' | 'custom'

/** Presets resolve against today; `custom` keeps whatever is in the inputs. */
function rangeFor(key: Exclude<RangeKey, 'custom'>): { start: string; end: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  switch (key) {
    case 'thisMonth':
      return { start: iso(new Date(y, m, 1)), end: iso(now) }
    case 'lastMonth':
      return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 0)) }
    case 'last3':
      return { start: iso(new Date(y, m - 2, 1)), end: iso(now) }
    case 'thisYear':
      return { start: iso(new Date(y, 0, 1)), end: iso(now) }
  }
}

const RANGES: RangeKey[] = ['thisMonth', 'lastMonth', 'last3', 'thisYear', 'custom']

function SectionCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-card rounded-xl border border-border shadow-sm ${className}`}>{children}</div>
  )
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <SectionCard>
      <div className="px-4 sm:px-5 py-3.5 border-b border-border flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint && (
          <Popover>
            <PopoverTrigger aria-label={hint}>
              <HelpCircle size={13} className="text-muted-foreground hover:text-foreground" />
            </PopoverTrigger>
            <PopoverContent className="text-xs leading-relaxed max-w-xs">{hint}</PopoverContent>
          </Popover>
        )}
      </div>
      {children}
    </SectionCard>
  )
}

/** Treemap cell. Labels are dropped when the rectangle is too small to hold
 *  them, which is what keeps a long tail of small categories readable. */
function TreemapCell(props: any) {
  const { x, y, width, height, color, name, share } = props
  const showLabel = width > 62 && height > 30
  const showShare = width > 62 && height > 46
  return (
    <g>
      <rect
        x={x} y={y} width={width} height={height}
        style={{ fill: color || '#6B7280', stroke: 'var(--background, #fff)', strokeWidth: 2 }}
        rx={3}
      />
      {showLabel && (
        <text x={x + 8} y={y + 20} fill="#fff" fontSize={11} fontWeight={600}>
          {String(name).length > Math.floor(width / 7) ? `${String(name).slice(0, Math.floor(width / 7))}…` : name}
        </text>
      )}
      {showShare && (
        <text x={x + 8} y={y + 36} fill="#fff" fontSize={10} opacity={0.85}>
          {(share * 100).toFixed(1)}%
        </text>
      )}
    </g>
  )
}

interface SideProps {
  side: AnalysisSide
  currency: string
  locale: string
  mask: (s: string) => string
  tone: 'expense' | 'income'
}

function SideSection({ side, currency, locale, mask, tone }: SideProps) {
  const { t } = useTranslation()
  const money = (v: number) => mask(formatCurrency(v, currency, locale))
  const isExpense = tone === 'expense'

  const treemapData = useMemo(
    () =>
      side.categories
        .filter((c) => c.total > 0)
        .map((c) => ({
          name: c.category_id ? c.name : t('analysis.uncategorized'),
          size: c.total,
          share: c.share,
          color: c.color,
          count: c.count,
        })),
    [side.categories, t],
  )

  const rec = side.recurrence
  const recTotal = rec.recurring_total + rec.one_off_total
  const recPct = recTotal > 0 ? (rec.recurring_total / recTotal) * 100 : 0

  if (side.count === 0) {
    return (
      <SectionCard className="p-8 text-center">
        <p className="text-sm text-muted-foreground">{t('analysis.noData')}</p>
      </SectionCard>
    )
  }

  return (
    <div className="space-y-4">
      {/* Headline numbers for this side */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SectionCard className="p-4">
          <p className="text-xs text-muted-foreground mb-1">{t('analysis.total')}</p>
          <p className={`text-xl font-semibold tabular-nums ${isExpense ? 'text-red-500' : 'text-emerald-500'}`}>
            {money(side.total)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('analysis.transactionCount', { count: side.count })}
          </p>
        </SectionCard>
        <SectionCard className="p-4">
          <p className="text-xs text-muted-foreground mb-1">{t('analysis.dailyAverage')}</p>
          <p className="text-xl font-semibold tabular-nums text-foreground">{money(side.daily_average)}</p>
        </SectionCard>
        <SectionCard className="p-4">
          <p className="text-xs text-muted-foreground mb-1">{t('analysis.recurringShare')}</p>
          <p className="text-xl font-semibold tabular-nums text-foreground">{recPct.toFixed(0)}%</p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${recPct}%` }} />
          </div>
        </SectionCard>
      </div>

      {/* Categories */}
      <Panel title={t('analysis.byCategory')}>
        <div className="h-[280px] p-3">
          <ResponsiveContainer width="100%" height="100%">
            <Treemap
              data={treemapData}
              dataKey="size"
              isAnimationActive={false}
              content={<TreemapCell />}
            >
              <Tooltip
                formatter={(value: any) => money(Number(value))}
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
            </Treemap>
          </ResponsiveContainer>
        </div>
        <div className="border-t border-border divide-y divide-border">
          {side.categories.slice(0, 10).map((c) => (
            <div key={c.category_id ?? 'none'} className="flex items-center gap-3 px-4 sm:px-5 py-2.5">
              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: c.color }} />
              <span className="text-sm text-foreground truncate flex-1">
                {c.category_id ? c.name : t('analysis.uncategorized')}
                {c.group_name && (
                  <span className="text-xs text-muted-foreground ml-2">{c.group_name}</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums w-12 text-right">
                {(c.share * 100).toFixed(1)}%
              </span>
              <span className="text-sm font-medium tabular-nums text-foreground w-28 text-right">
                {money(c.total)}
              </span>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top payees */}
        <Panel title={t('analysis.topPayees')} hint={t('analysis.payeesHint')}>
          <div className="divide-y divide-border">
            {side.payees.map((p) => (
              <div key={p.key} className="flex items-center gap-3 px-4 sm:px-5 py-2.5">
                <span className="text-sm text-foreground truncate flex-1" title={p.label}>
                  {p.label}
                </span>
                {p.recurring && (
                  <span title={t('analysis.recurringBadge')}>
                    <Repeat size={12} className="text-muted-foreground shrink-0" />
                  </span>
                )}
                <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">×{p.count}</span>
                <span className="text-sm font-medium tabular-nums text-foreground w-28 text-right">
                  {money(p.total)}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        {/* Largest single movements */}
        <Panel title={t('analysis.largest')}>
          <div className="divide-y divide-border">
            {side.largest.map((tx) => (
              <Link
                key={tx.id}
                to={`/transactions?search=${encodeURIComponent(tx.description)}`}
                className="flex items-center gap-3 px-4 sm:px-5 py-2.5 hover:bg-accent/50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground truncate">{tx.payee || tx.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {tx.date}
                    {tx.category_name && ` · ${tx.category_name}`}
                  </p>
                </div>
                <span className="text-sm font-medium tabular-nums text-foreground shrink-0">
                  {money(tx.amount)}
                </span>
              </Link>
            ))}
          </div>
        </Panel>
      </div>

      {/* Recurrence */}
      <Panel
        title={t('analysis.recurring')}
        hint={t('analysis.recurringHint', { months: rec.lookback_months, min: rec.min_months })}
      >
        <div className="px-4 sm:px-5 py-4 space-y-3">
          <div className="flex h-3 w-full rounded-full overflow-hidden bg-muted">
            <div className="bg-primary h-full" style={{ width: `${recPct}%` }} />
            <div className="bg-muted-foreground/30 h-full" style={{ width: `${100 - recPct}%` }} />
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-foreground">
              {t('analysis.recurringLabel')} · {money(rec.recurring_total)}{' '}
              <span className="text-muted-foreground">({rec.recurring_count})</span>
            </span>
            <span className="text-foreground">
              {t('analysis.oneOffLabel')} · {money(rec.one_off_total)}{' '}
              <span className="text-muted-foreground">({rec.one_off_count})</span>
            </span>
          </div>
        </div>
        {rec.items.length > 0 && (
          <div className="border-t border-border divide-y divide-border">
            {rec.items.map((item) => (
              <div key={item.label} className="flex items-center gap-3 px-4 sm:px-5 py-2.5">
                <span className="text-sm text-foreground truncate flex-1" title={item.label}>
                  {item.label}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  {t('analysis.monthsSeen', { count: item.months_seen })}
                </span>
                <span className="text-sm font-medium tabular-nums text-foreground w-28 text-right">
                  {money(item.total)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

export default function AnalysisPage() {
  const { t } = useTranslation()
  const { mask } = usePrivacyMode()
  const { user } = useAuth()
  const locale = useDisplayLocale()
  const { activeAccountIds } = useCollectionFilter()
  const accountIds = activeAccountIds ?? undefined
  const userCurrency = user?.preferences?.currency_display ?? 'USD'

  const [rangeKey, setRangeKey] = useState<RangeKey>('thisMonth')
  const [custom, setCustom] = useState(() => rangeFor('thisMonth'))
  const [side, setSide] = useState<'expenses' | 'income'>('expenses')

  const range = rangeKey === 'custom' ? custom : rangeFor(rangeKey)

  const { data, isLoading } = useQuery<PeriodAnalysis>({
    queryKey: ['analysis', range.start, range.end, accountIds],
    queryFn: () => analysis.period(range.start, range.end, accountIds),
  })

  const money = (v: number) => mask(formatCurrency(v, data?.currency ?? userCurrency, locale))

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <PageHeader section={t('nav.groupAnalysis')} title={t('analysis.title')} />

      {/* Period picker */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {RANGES.map((key) => (
          <button
            key={key}
            onClick={() => {
              if (key === 'custom' && rangeKey !== 'custom') setCustom(range)
              setRangeKey(key)
            }}
            className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
              rangeKey === key
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:text-foreground'
            }`}
          >
            {t(`analysis.range.${key}`)}
          </button>
        ))}
        {rangeKey === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={custom.start}
              onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))}
              className="px-2 py-1.5 text-xs rounded-lg border border-border bg-card text-foreground"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="date"
              value={custom.end}
              onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))}
              className="px-2 py-1.5 text-xs rounded-lg border border-border bg-card text-foreground"
            />
          </div>
        )}
      </div>

      {isLoading || !data ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : (
        <>
          {/* Period totals */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <SectionCard className="p-4">
              <div className="flex items-center gap-1.5 mb-1">
                <ArrowUpRight size={13} className="text-emerald-500" />
                <p className="text-xs text-muted-foreground">{t('analysis.income')}</p>
              </div>
              <p className="text-xl font-semibold tabular-nums text-emerald-500">
                {money(data.income.total)}
              </p>
            </SectionCard>
            <SectionCard className="p-4">
              <div className="flex items-center gap-1.5 mb-1">
                <ArrowDownRight size={13} className="text-red-500" />
                <p className="text-xs text-muted-foreground">{t('analysis.expenses')}</p>
              </div>
              <p className="text-xl font-semibold tabular-nums text-red-500">
                {money(data.expenses.total)}
              </p>
            </SectionCard>
            <SectionCard className="p-4">
              <p className="text-xs text-muted-foreground mb-1">{t('analysis.net')}</p>
              <p
                className={`text-xl font-semibold tabular-nums ${
                  data.net >= 0 ? 'text-emerald-500' : 'text-red-500'
                }`}
              >
                {money(data.net)}
              </p>
            </SectionCard>
            <SectionCard className="p-4">
              <p className="text-xs text-muted-foreground mb-1">{t('analysis.savingsRate')}</p>
              <p className="text-xl font-semibold tabular-nums text-foreground">
                {data.savings_rate === null ? '—' : `${(data.savings_rate * 100).toFixed(0)}%`}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('analysis.overDays', { count: data.days })}
              </p>
            </SectionCard>
          </div>

          {/* Expenses / income switch — both sides get the same depth */}
          <div className="flex gap-1 mb-4 border-b border-border">
            {(['expenses', 'income'] as const).map((key) => (
              <button
                key={key}
                onClick={() => setSide(key)}
                className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
                  side === key
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(`analysis.${key}`)}
              </button>
            ))}
          </div>

          <SideSection
            side={side === 'expenses' ? data.expenses : data.income}
            currency={data.currency}
            locale={locale}
            mask={mask}
            tone={side === 'expenses' ? 'expense' : 'income'}
          />
        </>
      )}
    </div>
  )
}
