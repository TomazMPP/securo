import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis } from 'recharts'
import { ArrowDownRight, ArrowUpRight, ChevronRight, HelpCircle, Repeat } from 'lucide-react'
import { analysis } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { PageHeader } from '@/components/page-header'
import { ChartTooltip } from '@/components/chart-tooltip'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AccountIcon } from '@/components/account-icon'
import { getAccountTypeConfig } from '@/lib/account-type-config'
import { usePrivacyMode } from '@/hooks/use-privacy-mode'
import { useDisplayLocale } from '@/hooks/use-display-locale'
import { useAuth } from '@/contexts/auth-context'
import { useCollectionFilter } from '@/contexts/collection-filter-context'
import type {
  AccountMonthPoint,
  AccountsAnalysis,
  AnalysisAccount,
  AnalysisCategory,
  AnalysisSide,
  CategoryAnalysis,
  PeriodAnalysis,
} from '@/types'

function formatCurrency(value: number, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value)
}

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type RangeKey = 'thisMonth' | 'lastMonth' | 'last3' | 'last12' | 'thisYear' | 'allTime' | 'custom'

/** Presets resolve against today; `custom` keeps whatever is in the inputs.
 *  `allTime`'s start is a placeholder — the server starts at the first
 *  transaction and echoes the real start back. */
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
    case 'last12':
      return { start: iso(new Date(y, m - 11, 1)), end: iso(now) }
    case 'thisYear':
      return { start: iso(new Date(y, 0, 1)), end: iso(now) }
    case 'allTime':
      return { start: iso(new Date(2000, 0, 1)), end: iso(now) }
  }
}

const RANGES: RangeKey[] = ['thisMonth', 'lastMonth', 'last3', 'last12', 'thisYear', 'allTime', 'custom']

/** How many categories the list shows before "show all". */
const CATEGORY_PREVIEW = 10

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

interface TreemapCellProps {
  x?: number
  y?: number
  width?: number
  height?: number
  color?: string
  name?: string
  share?: number
  category?: AnalysisCategory
  onSelect?: (c: AnalysisCategory) => void
}

/** Treemap cell. Labels are dropped when the rectangle is too small to hold
 *  them, which is what keeps a long tail of small categories readable. */
function TreemapCell({
  x = 0, y = 0, width = 0, height = 0, color, name, share = 0, category, onSelect,
}: TreemapCellProps) {
  const showLabel = width > 62 && height > 30
  const showShare = width > 62 && height > 46
  return (
    <g
      onClick={category && onSelect ? () => onSelect(category) : undefined}
      style={category && onSelect ? { cursor: 'pointer' } : undefined}
    >
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
  onSelectCategory: (c: AnalysisCategory) => void
}

function SideSection({ side, currency, locale, mask, tone, onSelectCategory }: SideProps) {
  const { t } = useTranslation()
  const money = (v: number) => mask(formatCurrency(v, currency, locale))
  const isExpense = tone === 'expense'
  const [showAllCategories, setShowAllCategories] = useState(false)
  const visibleCategories = showAllCategories ? side.categories : side.categories.slice(0, CATEGORY_PREVIEW)

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
          category: c,
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
              content={<TreemapCell onSelect={onSelectCategory} />}
            >
              <Tooltip
                formatter={(value) => money(Number(value))}
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
          {visibleCategories.map((c) => (
            <button
              key={c.category_id ?? 'none'}
              type="button"
              onClick={() => onSelectCategory(c)}
              className="w-full flex items-center gap-3 px-4 sm:px-5 py-2.5 text-left hover:bg-accent/50 transition-colors"
            >
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
              <ChevronRight size={14} className="text-muted-foreground shrink-0" />
            </button>
          ))}
          {side.categories.length > CATEGORY_PREVIEW && (
            <button
              type="button"
              onClick={() => setShowAllCategories((v) => !v)}
              className="w-full px-4 sm:px-5 py-2.5 text-xs text-muted-foreground hover:text-foreground text-center"
            >
              {showAllCategories
                ? t('analysis.showFewerCategories')
                : t('analysis.showAllCategories', { count: side.categories.length })}
            </button>
          )}
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
                to={`/transactions?q=${encodeURIComponent(tx.description)}`}
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

function monthShort(month: string, locale: string) {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'short' })
}

function shortDate(iso: string, locale: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

/** Tiny per-account spend trend. Bars are scaled to the account's own busiest
 *  month; the current (last) month is highlighted. */
function MonthSparkline({
  points, locale, money,
}: { points: AccountMonthPoint[]; locale: string; money: (v: number) => string }) {
  const max = Math.max(...points.map((p) => p.total), 1)
  const W = 96
  const H = 28
  const gap = 3
  const bw = (W - gap * (points.length - 1)) / Math.max(points.length, 1)
  return (
    <svg width={W} height={H} className="shrink-0" role="img">
      {points.map((p, i) => {
        const h = p.total > 0 ? Math.max(3, (p.total / max) * H) : 2
        return (
          <rect
            key={p.month}
            x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={1.5}
            className={i === points.length - 1 ? 'fill-primary' : 'fill-muted-foreground/25'}
          >
            <title>{`${monthShort(p.month, locale)} · ${money(p.total)}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

function utilizationColor(u: number) {
  if (u < 0.3) return 'bg-emerald-500'
  if (u < 0.7) return 'bg-amber-500'
  return 'bg-red-500'
}

interface AccountRowProps {
  acc: AnalysisAccount
  currency: string
  locale: string
  mask: (s: string) => string
}

function AccountRow({ acc, currency, locale, mask }: AccountRowProps) {
  const { t } = useTranslation()
  const money = (v: number, cur = currency) => mask(formatCurrency(v, cur, locale))
  const util = acc.utilization

  return (
    <SectionCard className="p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <AccountIcon account={acc} size="lg" />
        <div className="min-w-0 flex-1">
          <Link
            to={`/accounts/${acc.account_id}`}
            className="text-sm font-semibold text-foreground hover:underline truncate block"
          >
            {acc.name}
            {acc.masked_number && (
              <span className="text-muted-foreground font-normal"> ···{acc.masked_number}</span>
            )}
          </Link>
          <p className="text-xs text-muted-foreground truncate">
            {[acc.institution_name, acc.card_brand, t(getAccountTypeConfig(acc.type).label)]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-base font-semibold tabular-nums text-red-500">{money(acc.expense_total)}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {(acc.expense_share * 100).toFixed(1)}% · {t('analysis.transactionCount', { count: acc.expense_count })}
          </p>
        </div>
      </div>

      {/* Share of the period's spending across all accounts */}
      <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${Math.min(100, acc.expense_share * 100)}%` }} />
      </div>

      {/* What this account's spend was made of */}
      {acc.expense_total > 0 && acc.categories.length > 0 && (
        <div className="mt-3">
          <div className="flex h-2 w-full rounded-full overflow-hidden bg-muted">
            {acc.categories.map((c) => (
              <div
                key={c.category_id ?? 'none'}
                style={{ width: `${c.share * 100}%`, background: c.color }}
                title={`${c.category_id ? c.name : t('analysis.uncategorized')} · ${money(c.total)}`}
              />
            ))}
            {acc.other_categories_total > 0 && (
              <div
                className="bg-muted-foreground/30"
                style={{ width: `${(acc.other_categories_total / acc.expense_total) * 100}%` }}
              />
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {acc.categories.slice(0, 3).map((c) => (
              <span
                key={c.category_id ?? 'none'}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: c.color }} />
                {c.category_id ? c.name : t('analysis.uncategorized')}
                <span className="tabular-nums text-foreground">{money(c.total)}</span>
              </span>
            ))}
            {acc.other_categories_total > 0 && (
              <span className="text-xs text-muted-foreground">
                {t('analysis.otherCategories')}{' '}
                <span className="tabular-nums text-foreground">{money(acc.other_categories_total)}</span>
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {acc.income_total > 0 && (
            <>
              {t('analysis.income')}{' '}
              <span className="text-emerald-500 font-medium tabular-nums">+{money(acc.income_total)}</span>
            </>
          )}
        </p>
        <MonthSparkline points={acc.monthly} locale={locale} money={money} />
      </div>

      {(util !== null || acc.next_close_date || acc.next_due_date) && (
        <div className="mt-3 pt-3 border-t border-border space-y-2">
          {util !== null && acc.credit_limit !== null && (
            <div>
              <div className="flex justify-between gap-2 text-xs mb-1">
                <span className="text-muted-foreground">
                  {t('analysis.limitUsed', { pct: (util * 100).toFixed(0) })}
                </span>
                <span className="text-muted-foreground tabular-nums truncate">
                  {t('analysis.availableOfLimit', {
                    available: money(acc.available_credit ?? 0, acc.account_currency),
                    limit: money(acc.credit_limit, acc.account_currency),
                  })}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full ${utilizationColor(util)}`}
                  style={{ width: `${Math.min(100, util * 100)}%` }}
                />
              </div>
            </div>
          )}
          {(acc.next_close_date || acc.next_due_date) && (
            <p className="text-xs text-muted-foreground">
              {acc.next_close_date && t('analysis.closes', { date: shortDate(acc.next_close_date, locale) })}
              {acc.next_close_date && acc.next_due_date && ' · '}
              {acc.next_due_date && t('analysis.due', { date: shortDate(acc.next_due_date, locale) })}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  )
}

interface AccountsSectionProps {
  allTime: boolean
  range: { start: string; end: string }
  accountIds?: string[]
  locale: string
  mask: (s: string) => string
}

function AccountsSection({ range, accountIds, allTime, locale, mask }: AccountsSectionProps) {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery<AccountsAnalysis>({
    queryKey: ['analysis-accounts', range.start, range.end, accountIds, allTime],
    queryFn: () => analysis.accounts(range.start, range.end, accountIds, allTime),
  })

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  if (data.accounts.length === 0) {
    return (
      <SectionCard className="p-8 text-center">
        <p className="text-sm text-muted-foreground">{t('analysis.noData')}</p>
      </SectionCard>
    )
  }

  const money = (v: number) => mask(formatCurrency(v, data.currency, locale))
  const cardPct = data.card_expense_share * 100
  const nonCardExpenses = data.total_expenses - data.card_expenses

  return (
    <div className="space-y-4">
      <Panel title={t('analysis.creditVsDebit')} hint={t('analysis.creditVsDebitHint')}>
        <div className="px-4 sm:px-5 py-4 space-y-3">
          <div className="flex h-3 w-full rounded-full overflow-hidden bg-muted">
            <div className="bg-violet-500 h-full" style={{ width: `${cardPct}%` }} />
            <div className="bg-muted-foreground/30 h-full" style={{ width: `${100 - cardPct}%` }} />
          </div>
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-foreground">
              {t('analysis.onCredit')} · {money(data.card_expenses)}{' '}
              <span className="text-muted-foreground">({cardPct.toFixed(0)}%)</span>
            </span>
            <span className="text-foreground text-right">
              {t('analysis.onOther')} · {money(nonCardExpenses)}
            </span>
          </div>
        </div>
      </Panel>

      <p className="text-xs text-muted-foreground">
        {t('analysis.accountsWithActivity', { count: data.accounts.length })}
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {data.accounts.map((a) => (
          <AccountRow key={a.account_id} acc={a} currency={data.currency} locale={locale} mask={mask} />
        ))}
      </div>
    </div>
  )
}

function monthLong(month: string, locale: string) {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' })
}

interface CategoryDetailProps {
  category: AnalysisCategory | null
  type: 'debit' | 'credit'
  range: { start: string; end: string }
  allTime: boolean
  accountIds?: string[]
  locale: string
  mask: (s: string) => string
  onClose: () => void
}

/** Drill-down for one category: period and lifetime totals, the month-by-month
 *  trend, who the money went to, and a jump to the matching transactions. */
function CategoryDetail({ category, type, range, allTime, accountIds, locale, mask, onClose }: CategoryDetailProps) {
  const { t } = useTranslation()
  const categoryId = category?.category_id ?? null
  const { data, isLoading } = useQuery<CategoryAnalysis>({
    queryKey: ['analysis-category', categoryId, type, range.start, range.end, accountIds, allTime],
    queryFn: () => analysis.category(categoryId, type, range.start, range.end, accountIds, allTime),
    enabled: category !== null,
  })

  const money = (v: number) => mask(formatCurrency(v, data?.currency ?? 'USD', locale))
  const compact = (v: number) =>
    mask(new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v))
  const name = category ? (category.category_id ? category.name : t('analysis.uncategorized')) : ''
  const color = category?.color ?? '#6B7280'
  const txLink = data
    ? `/transactions?${new URLSearchParams({
        ...(categoryId ? { category_id: categoryId } : {}),
        from: data.start,
        to: data.end,
      }).toString()}`
    : null

  return (
    <Dialog open={category !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm shrink-0" style={{ background: color }} />
            {name}
          </DialogTitle>
          <DialogDescription>
            {category?.group_name ? `${category.group_name} · ` : ''}
            {t(type === 'debit' ? 'analysis.expenses' : 'analysis.income')}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <SectionCard className="p-3.5">
                <p className="text-xs text-muted-foreground mb-1">{t('analysis.categoryDetail.inPeriod')}</p>
                <p className="text-lg font-semibold tabular-nums text-foreground">{money(data.total)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('analysis.transactionCount', { count: data.count })}
                </p>
              </SectionCard>
              <SectionCard className="p-3.5">
                <p className="text-xs text-muted-foreground mb-1">{t('analysis.categoryDetail.monthlyAverage')}</p>
                <p className="text-lg font-semibold tabular-nums text-foreground">{money(data.monthly_average)}</p>
              </SectionCard>
              <SectionCard className="p-3.5">
                <p className="text-xs text-muted-foreground mb-1">{t('analysis.categoryDetail.allTime')}</p>
                <p className="text-lg font-semibold tabular-nums text-foreground">{money(data.all_time_total)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('analysis.transactionCount', { count: data.all_time_count })}
                  {data.first_date &&
                    ` · ${t('analysis.categoryDetail.since', {
                      date: new Date(`${data.first_date}T00:00:00`).toLocaleDateString(locale, {
                        day: 'numeric', month: 'short', year: 'numeric',
                      }),
                    })}`}
                </p>
              </SectionCard>
            </div>

            {data.monthly.length > 1 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">{t('analysis.categoryDetail.byMonth')}</p>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.monthly} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <XAxis
                        dataKey="month"
                        tickFormatter={(m) => monthShort(String(m), locale)}
                        tickLine={false}
                        axisLine={false}
                        fontSize={11}
                        minTickGap={8}
                      />
                      <YAxis tickLine={false} axisLine={false} fontSize={11} width={44} tickFormatter={compact} />
                      <Tooltip
                        cursor={{ fill: 'var(--secondary)', opacity: 0.6 }}
                        content={({ active, payload, label }) =>
                          active && payload?.length ? (
                            <ChartTooltip
                              title={monthLong(String(label), locale)}
                              format={money}
                              rows={[{ key: 'total', label: name, value: Number(payload[0].value) || 0, color }]}
                            />
                          ) : null
                        }
                      />
                      <Bar dataKey="total" fill={color} radius={[4, 4, 0, 0]} maxBarSize={36} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {data.payees.length > 0 && (
              <Panel title={t('analysis.topPayees')} hint={t('analysis.payeesHint')}>
                <div className="divide-y divide-border">
                  {data.payees.slice(0, 8).map((p) => (
                    <div key={p.key} className="flex items-center gap-3 px-4 py-2">
                      <span className="text-sm text-foreground truncate flex-1" title={p.label}>{p.label}</span>
                      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">×{p.count}</span>
                      <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
                        {(p.share * 100).toFixed(0)}%
                      </span>
                      <span className="text-sm font-medium tabular-nums text-foreground w-24 text-right">
                        {money(p.total)}
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            {txLink && categoryId && (
              <Link
                to={txLink}
                className="flex items-center justify-center gap-1 w-full rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-accent/50 transition-colors"
              >
                {t('analysis.categoryDetail.viewTransactions')}
                <ChevronRight size={14} />
              </Link>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
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
  const [side, setSide] = useState<'expenses' | 'income' | 'accounts'>('expenses')
  const [selectedCategory, setSelectedCategory] = useState<AnalysisCategory | null>(null)

  const range = rangeKey === 'custom' ? custom : rangeFor(rangeKey)
  const allTime = rangeKey === 'allTime'

  const { data, isLoading } = useQuery<PeriodAnalysis>({
    queryKey: ['analysis', range.start, range.end, accountIds, allTime],
    queryFn: () => analysis.period(range.start, range.end, accountIds, allTime),
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
              // "All time" only knows its real start once the server answers.
              if (key === 'custom' && rangeKey !== 'custom')
                setCustom(allTime && data ? { start: data.start, end: data.end } : range)
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

          {/* Expenses / income / per-account switch — every view gets the same depth */}
          <div className="flex gap-1 mb-4 border-b border-border">
            {(['expenses', 'income', 'accounts'] as const).map((key) => (
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

          {side === 'accounts' ? (
            <AccountsSection range={range} accountIds={accountIds} allTime={allTime} locale={locale} mask={mask} />
          ) : (
            <SideSection
              side={side === 'expenses' ? data.expenses : data.income}
              currency={data.currency}
              locale={locale}
              mask={mask}
              tone={side === 'expenses' ? 'expense' : 'income'}
              onSelectCategory={setSelectedCategory}
            />
          )}
        </>
      )}

      <CategoryDetail
        category={selectedCategory}
        type={side === 'income' ? 'credit' : 'debit'}
        range={range}
        allTime={allTime}
        accountIds={accountIds}
        locale={locale}
        mask={mask}
        onClose={() => setSelectedCategory(null)}
      />
    </div>
  )
}
