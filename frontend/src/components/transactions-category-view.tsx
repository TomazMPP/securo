import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, PieChart } from 'lucide-react'
import { CategoryIcon } from '@/components/category-icon'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCurrency } from '@/lib/format'
import { totalsByCategory, type CategoryTotal } from '@/lib/transactions-grouping'
import { cn } from '@/lib/utils'
import type { Transaction } from '@/types'

type TransactionsCategoryViewProps = {
  items: Transaction[] | undefined
  /** Rows matching the filters on the server; above `items.length` the view is partial. */
  total: number
  isLoading: boolean
  currency: string
  locale: string
  mask: (value: string) => string
  /** Narrow the list to one category (null = uncategorized). */
  onSelectCategory: (categoryId: string | null) => void
}

function CategorySection({
  title,
  rows,
  tone,
  currency,
  locale,
  mask,
  onSelectCategory,
}: {
  title: string
  rows: CategoryTotal[]
  tone: 'in' | 'out'
  currency: string
  locale: string
  mask: (value: string) => string
  onSelectCategory: (categoryId: string | null) => void
}) {
  const { t } = useTranslation()
  const sectionTotal = rows.reduce((sum, row) => sum + row.total, 0)
  if (rows.length === 0) return null
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-2 pt-4 text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground md:px-5">
        <span>{title}</span>
        <span
          className={cn(
            'font-semibold normal-case tracking-normal tabular-nums',
            tone === 'in' ? 'text-[#0B7A41] dark:text-emerald-400' : 'text-[#B42323] dark:text-rose-400',
          )}
        >
          {mask(formatCurrency(sectionTotal, currency, locale))}
        </span>
      </div>
      <ul>
        {rows.map((row) => {
          const share = sectionTotal > 0 ? row.total / sectionTotal : 0
          const color = row.color || '#6B7280'
          const name = row.name ?? t('transactions.noCategory')
          return (
            <li key={row.key} className="border-t border-border/60">
              <button
                type="button"
                onClick={() => onSelectCategory(row.categoryId)}
                title={t('transactions.byCategory.showTransactions', { category: name })}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none md:gap-3.5 md:px-5"
              >
                <CategoryIcon icon={row.icon} color={row.color} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm">
                      <span className="font-semibold text-foreground">{name}</span>
                      <span className="text-xs text-muted-foreground">
                        {' · '}{row.count} {t('transactions.summaryCountNoun', { count: row.count })}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                      {mask(formatCurrency(row.total, currency, locale))}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3">
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.max(share * 100, 1.5)}%`, backgroundColor: color }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {Math.round(share * 100)}%
                    </span>
                  </div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * The filtered period summed per category, expenses then income, each bar
 * showing that category's share of its side. Picking a category opens the
 * statement narrowed to it.
 */
export function TransactionsCategoryView({
  items,
  total,
  isLoading,
  currency,
  locale,
  mask,
  onSelectCategory,
}: TransactionsCategoryViewProps) {
  const { t } = useTranslation()
  const groups = useMemo(() => totalsByCategory(items ?? []), [items])
  const partial = !!items && total > items.length

  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-border bg-card">
      {isLoading ? (
        <div className="space-y-3 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : groups.expenses.length === 0 && groups.income.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
          <PieChart className="text-muted-foreground/60" size={28} aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">{t('transactions.byCategory.emptyTitle')}</p>
          <p className="max-w-sm text-xs text-muted-foreground">{t('transactions.byCategory.emptyHint')}</p>
        </div>
      ) : (
        <>
          <CategorySection
            title={t('transactions.summaryOutflows')}
            rows={groups.expenses}
            tone="out"
            currency={currency}
            locale={locale}
            mask={mask}
            onSelectCategory={onSelectCategory}
          />
          <CategorySection
            title={t('transactions.summaryInflows')}
            rows={groups.income}
            tone="in"
            currency={currency}
            locale={locale}
            mask={mask}
            onSelectCategory={onSelectCategory}
          />
          {partial && (
            <div className="flex items-start gap-2 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground md:px-5">
              <Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{t('transactions.byCategory.partial', { shown: items?.length ?? 0, total })}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
