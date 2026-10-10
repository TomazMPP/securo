/**
 * The income statement (DRE) lines a category group can feed. Mirror of
 * `DreSection` in the backend's `models/category_group.py`.
 */
export const DRE_SECTIONS = [
  'revenue',
  'deductions',
  'costs',
  'operating_expenses',
  'financial',
  'owners',
] as const

export type DreSection = (typeof DRE_SECTIONS)[number]

/** Every section the statement renders, in order. `unclassified` is not a
 *  group setting: it collects what has no section, and sits just above the
 *  bottom line; `owners` comes after the bottom line. */
export type IncomeStatementSectionKey = DreSection | 'unclassified'
