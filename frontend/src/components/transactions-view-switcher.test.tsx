import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TransactionsViewSwitcher } from '@/components/transactions-view-switcher'

describe('TransactionsViewSwitcher', () => {
  it('offers list and calendar only when no category label is given', () => {
    render(<TransactionsViewSwitcher value="list" onChange={() => {}} listLabel="List" calendarLabel="Calendar" />)
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('adds the category view between list and calendar', async () => {
    const onChange = vi.fn()
    render(
      <TransactionsViewSwitcher
        value="calendar"
        onChange={onChange}
        listLabel="Statement"
        categoryLabel="By category"
        calendarLabel="Calendar"
      />,
    )
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Statement', 'By category', 'Calendar'])
    await userEvent.click(screen.getByRole('button', { name: 'By category' }))
    expect(onChange).toHaveBeenCalledWith('category')
  })
})
