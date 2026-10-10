import { describe, it, expect } from 'vitest'
import { navItems, visibleNavItems, type NavItem } from './nav-items'
import { MODULE_IDS, type ModuleId } from './modules'

const all = () => true
const none = () => false
const allExcept =
  (...off: ModuleId[]) =>
  (id: ModuleId) =>
    !off.includes(id)

// Mirrors the backend's PersonalPolicy result. Spelled out rather than
// derived, so a change that takes a link away from existing users has
// to be a deliberate edit here.
const PERSONAL_MODULES: ModuleId[] = [
  'transactions',
  'accounts',
  'cards',
  'loans',
  'import',
  'reports',
  'assets',
  'budgets',
  'goals',
  'recurring',
  'categories',
  'payees',
  'split_groups',
  'rules',
]

const linkKeys = (items: NavItem[]) =>
  items.filter((i) => i.type === 'link').map((i) => i.key)

describe('nav catalog', () => {
  it('maps every link to a known module', () => {
    for (const item of navItems) {
      if (item.type !== 'link') continue
      expect(MODULE_IDS).toContain(item.module)
    }
  })

  it('has a link for every module in the catalog', () => {
    const covered = navItems.filter((i) => i.type === 'link').map((i) => i.module)
    expect([...new Set(covered)].sort()).toEqual([...MODULE_IDS].sort())
  })

  // Fork: the Breakdown page (/analysis) is a second view of the reports
  // module, so it shares that module rather than adding its own. Cards and
  // Loans have their own modules so a business workspace can drop them.
  const SHARED_MODULE_LINKS = ['analysis']

  it('gives every other link a distinct module', () => {
    const covered = navItems
      .filter((i) => i.type === 'link' && !SHARED_MODULE_LINKS.includes(i.key))
      .map((i) => (i.type === 'link' ? i.module : null))
    expect(new Set(covered).size).toBe(covered.length)
  })
})

describe('visibleNavItems', () => {
  it('renders a personal workspace exactly as before modules existed', () => {
    const personal = visibleNavItems(navItems, (id) => PERSONAL_MODULES.includes(id))
    expect(linkKeys(personal)).toEqual([
      'transactions',
      'recurring',
      'import',
      'accounts',
      'cards',
      'loans',
      'categories',
      'budgets',
      'goals',
      'reports',
      'analysis',
      'assets',
      'payees',
      'splitGroups',
      'rules',
    ])
    // All four section headers survive.
    expect(personal.filter((i) => i.type === 'separator')).toHaveLength(4)
  })

  it('adds invoices for a workspace that has it', () => {
    const business = visibleNavItems(navItems, all)
    expect(linkKeys(business)).toContain('invoices')
    // And it does not disturb the rest of the order.
    expect(linkKeys(business).indexOf('invoices')).toBe(1)
  })

  it('adds the income statement next to the reports for a business workspace', () => {
    const business = linkKeys(visibleNavItems(navItems, all))
    expect(business.indexOf('incomeStatement')).toBe(business.indexOf('analysis') + 1)
    const personal = linkKeys(visibleNavItems(navItems, (id) => PERSONAL_MODULES.includes(id)))
    expect(personal).not.toContain('incomeStatement')
  })

  it('hides a section header once its last link goes', () => {
    const items: NavItem[] = [
      { type: 'separator', labelKey: 'a' },
      { type: 'link', key: 'one', path: '/1', icon: () => null, module: 'reports' },
      { type: 'separator', labelKey: 'b' },
      { type: 'link', key: 'two', path: '/2', icon: () => null, module: 'assets' },
    ]
    const result = visibleNavItems(items, allExcept('reports'))
    expect(result.map((i) => (i.type === 'separator' ? i.labelKey : i.key))).toEqual([
      'b',
      'two',
    ])
  })

  it('keeps a section header while any of its links remain', () => {
    const result = visibleNavItems(navItems, allExcept('transactions', 'invoices'))
    const labels = result.filter((i) => i.type === 'separator').map((i) => i.labelKey)
    expect(labels).toContain('nav.groupControl')
    expect(linkKeys(result)).toContain('accounts')
  })

  it('drops every header when no module is on', () => {
    expect(visibleNavItems(navItems, none)).toEqual([])
  })

  it('leaves a trailing header out rather than dangling', () => {
    const items: NavItem[] = [
      { type: 'link', key: 'one', path: '/1', icon: () => null, module: 'reports' },
      { type: 'separator', labelKey: 'trailing' },
      { type: 'link', key: 'two', path: '/2', icon: () => null, module: 'assets' },
    ]
    const result = visibleNavItems(items, allExcept('assets'))
    expect(result.map((i) => (i.type === 'separator' ? i.labelKey : i.key))).toEqual(['one'])
  })
})
