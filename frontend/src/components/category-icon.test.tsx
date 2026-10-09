import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'

import { CategoryIcon } from '@/components/category-icon'
import { renderWithProviders } from '@/test/utils'

describe('CategoryIcon', () => {
  it('renders the icon it was asked for', () => {
    // Asserting only that an svg exists would also pass on the fallback,
    // which is the failure this test is here to catch, so pin the icon the
    // component resolved.
    const { container } = renderWithProviders(
      <CategoryIcon icon="shopping-cart" color="#22c55e" />,
    )

    expect(container.firstElementChild).toHaveAttribute('data-icon', 'shopping-cart')
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('renders an emoji icon as text, for categories saved before the icon set', () => {
    renderWithProviders(<CategoryIcon icon="🍔" color="#f97316" />)

    expect(screen.getByText('🍔')).toBeInTheDocument()
  })

  it('falls back to a placeholder icon for an unknown name', () => {
    // A name the icon set doesn't know must not blank the row.
    const { container } = renderWithProviders(
      <CategoryIcon icon="not-a-real-icon" color="#22c55e" />,
    )

    expect(container.firstElementChild).toHaveAttribute('data-icon', 'circle-help')
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('survives a category with no icon or colour at all', () => {
    const { container } = renderWithProviders(
      <CategoryIcon icon={null} color={null} />,
    )

    expect(container.querySelector('svg')).toHaveAttribute('fill', '#6B7280')
    expect(container.firstElementChild?.getAttribute('style')).toContain('rgb(107, 114, 128)')
  })

  it('paints the glyph in the category colour over a tint of it', () => {
    const { container } = renderWithProviders(
      <CategoryIcon icon="shopping-cart" color="#22c55e" />,
    )

    expect(container.querySelector('svg')).toHaveAttribute('fill', '#22c55e')
    const style = container.firstElementChild?.getAttribute('style') ?? ''
    expect(style).toContain('color-mix')
    expect(style).toContain('rgb(34, 197, 94)')
  })

  it('grows with the requested size', () => {
    const { container: small } = renderWithProviders(
      <CategoryIcon icon="shopping-cart" color="#22c55e" size="xs" />,
    )
    expect(small.firstElementChild).toHaveClass('w-4', 'h-4')

    const { container: large } = renderWithProviders(
      <CategoryIcon icon="shopping-cart" color="#22c55e" size="xl" />,
    )
    expect(large.firstElementChild).toHaveClass('w-11', 'h-11')
  })

  it('never shrinks inside a flex row', () => {
    // Category icons sit next to variable-length names in the transaction
    // list; without shrink-0 a long payee squashes the icon.
    const { container } = renderWithProviders(
      <CategoryIcon icon="shopping-cart" color="#22c55e" />,
    )

    expect(container.firstElementChild).toHaveClass('shrink-0')
  })
})
