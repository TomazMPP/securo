import type { CommitmentKind } from '@/lib/recurring-overview'

/**
 * Series colors for the three commitment kinds, as CSS variables so recharts
 * and plain HTML read the same value. Each mode has its own validated steps
 * (light: on white cards; dark: on the dark card surface).
 */
export const SERIES_VARS_CLASS =
  '[--series-fixed:#2456E6] [--series-installment:#E08A1E] [--series-financing:#4B3FB0] ' +
  'dark:[--series-fixed:#5B82F5] dark:[--series-installment:#C47820] dark:[--series-financing:#8F6FE0]'

export const SERIES_COLOR: Record<CommitmentKind, string> = {
  fixed: 'var(--series-fixed)',
  installment: 'var(--series-installment)',
  financing: 'var(--series-financing)',
}

export const POSITIVE_TEXT = 'text-[#0B7A41] dark:text-emerald-400'
export const WARNING_TEXT = 'text-[#8A5A0B] dark:text-amber-300'
