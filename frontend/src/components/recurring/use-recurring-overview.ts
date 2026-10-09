import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import api, { dashboard, transactions as transactionsApi } from '@/lib/api'
import { monthRange, shiftMonth } from '@/lib/month-utils'
import { todayInTimezone } from '@/lib/date-utils'
import { useEffectiveTimezone } from '@/hooks/use-timezone'
import {
  averageMonthlyIncome,
  buildForecast,
  buildMonthItems,
  findInstallmentRelief,
  normalizeLoans,
  totalsOf,
  type LoanLike,
} from '@/lib/recurring-overview'
import type { Transaction } from '@/types'

const WINDOW_MONTHS = 6
const PAGE_SIZE = 500
const MAX_PAGES = 10

/** Every transaction of one type in a date range, page by page. */
async function fetchAllTransactions(params: { from: string; to: string; type: string }): Promise<Transaction[]> {
  const all: Transaction[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await transactionsApi.list({ ...params, page, limit: PAGE_SIZE, exclude_ignored: true })
    all.push(...res.items)
    if (all.length >= res.total || res.items.length < PAGE_SIZE) break
  }
  return all
}

/**
 * Loans come from a module another screen owns; it may not exist on this
 * server yet. Any failure (404 included) means "no financing", never an error.
 */
async function fetchLoans(): Promise<LoanLike[]> {
  try {
    const { data } = await api.get('/loans')
    return normalizeLoans(data)
  } catch {
    return []
  }
}

export function useRecurringOverview(month: string, kind: 'debit' | 'credit') {
  const timeZone = useEffectiveTimezone()
  const today = todayInTimezone(timeZone)
  const from = monthRange(month).from
  const to = monthRange(shiftMonth(month, WINDOW_MONTHS - 1)).to

  const projectionsQuery = useQuery({
    queryKey: ['dashboard', 'recurring-projections', from, to],
    queryFn: () => dashboard.projectedTransactions({ from, to }),
  })

  const transactionsQuery = useQuery({
    queryKey: ['transactions', 'recurring-overview', from, to, kind],
    queryFn: () => fetchAllTransactions({ from, to, type: kind }),
  })

  const loansQuery = useQuery({
    queryKey: ['loans'],
    queryFn: fetchLoans,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  const trendQuery = useQuery({
    queryKey: ['dashboard', 'monthly-trend', 6],
    queryFn: () => dashboard.monthlyTrend(6),
    staleTime: 5 * 60 * 1000,
  })

  return useMemo(() => {
    const input = {
      today,
      kind,
      transactions: transactionsQuery.data ?? [],
      projections: projectionsQuery.data ?? [],
      loans: loansQuery.data ?? [],
    }
    const items = buildMonthItems({ ...input, month })
    return {
      today,
      isLoading: projectionsQuery.isLoading || transactionsQuery.isLoading,
      items,
      totals: totalsOf(items),
      forecast: buildForecast({ ...input, month, count: WINDOW_MONTHS }),
      relief: findInstallmentRelief({ ...input, month, count: WINDOW_MONTHS }),
      hasLoans: (loansQuery.data ?? []).length > 0,
      averageIncome: kind === 'debit' ? averageMonthlyIncome(trendQuery.data ?? [], month) : null,
    }
  }, [today, kind, month, transactionsQuery.data, projectionsQuery.data, loansQuery.data, trendQuery.data, projectionsQuery.isLoading, transactionsQuery.isLoading])
}
