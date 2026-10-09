import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TransactionsCategoryView } from '@/components/transactions-category-view'
import { renderWithProviders, t } from '@/test/utils'
import type { Transaction } from '@/types'

const food = { id: 'food', name: 'Groceries', icon: 'shopping-cart', color: '#0E6F5C' }

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    date: '2026-10-09',
    type: 'debit',
    amount: 10,
    amount_primary: null,
    is_ignored: false,
    is_shared: false,
    viewer_share: null,
    status: 'posted',
    category_id: null,
    category: null,
    ...overrides,
  } as Transaction
}

describe('TransactionsCategoryView', () => {
  it('lists each category with its total and narrows the statement on click', async () => {
    const onSelectCategory = vi.fn()
    renderWithProviders(
      <TransactionsCategoryView
        items={[
          tx({ category_id: 'food', category: food as Transaction['category'], amount: 75 }),
          tx({ category_id: 'food', category: food as Transaction['category'], amount: 25 }),
          tx({ amount: 50 }),
        ]}
        total={3}
        isLoading={false}
        currency="USD"
        locale="en-US"
        mask={(v) => v}
        onSelectCategory={onSelectCategory}
      />,
    )

    const groceries = screen.getByRole('button', { name: /Groceries/ })
    expect(groceries).toHaveTextContent('$100.00')
    expect(groceries).toHaveTextContent('67%')
    await userEvent.click(groceries)
    expect(onSelectCategory).toHaveBeenCalledWith('food')

    await userEvent.click(screen.getByRole('button', { name: new RegExp(t('transactions.noCategory')) }))
    expect(onSelectCategory).toHaveBeenLastCalledWith(null)
  })

  it('says when the period has more rows than were summed', () => {
    renderWithProviders(
      <TransactionsCategoryView
        items={[tx({ amount: 5 })]}
        total={900}
        isLoading={false}
        currency="USD"
        locale="en-US"
        mask={(v) => v}
        onSelectCategory={() => {}}
      />,
    )
    expect(screen.getByText(t('transactions.byCategory.partial', { shown: 1, total: 900 }))).toBeInTheDocument()
  })

  it('shows an empty state when nothing matches', () => {
    renderWithProviders(
      <TransactionsCategoryView
        items={[]}
        total={0}
        isLoading={false}
        currency="USD"
        locale="en-US"
        mask={(v) => v}
        onSelectCategory={() => {}}
      />,
    )
    expect(screen.getByText(t('transactions.byCategory.emptyTitle'))).toBeInTheDocument()
  })
})
