import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { formatRelative, formatTimeAgo } from '@/lib/relative-time'

const NOW = new Date('2026-06-15T12:00:00.000Z')

/** ISO string for `minutes` before the frozen now. */
function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses anything under a minute to "now"', () => {
    expect(formatRelative(ago(0))).toBe('now')
    expect(formatRelative(ago(0.5))).toBe('now')
  })

  it('counts whole minutes up to an hour', () => {
    expect(formatRelative(ago(1))).toBe('1m ago')
    expect(formatRelative(ago(59))).toBe('59m ago')
  })

  it('switches to hours at sixty minutes', () => {
    expect(formatRelative(ago(60))).toBe('1h ago')
    expect(formatRelative(ago(60 * 23))).toBe('23h ago')
  })

  it('says yesterday for the first full day', () => {
    expect(formatRelative(ago(60 * 24))).toBe('yesterday')
    expect(formatRelative(ago(60 * 47))).toBe('yesterday')
  })

  it('counts days up to a week', () => {
    expect(formatRelative(ago(60 * 48))).toBe('2d ago')
    expect(formatRelative(ago(60 * 24 * 6))).toBe('6d ago')
  })

  it('falls back to a calendar date past a week', () => {
    const result = formatRelative(ago(60 * 24 * 30))
    expect(result).not.toMatch(/ago|now|yesterday/)
    expect(result).toMatch(/May/)
  })

  it('returns an empty string for an unparseable timestamp', () => {
    // Never render "NaNm ago" into the UI.
    expect(formatRelative('not a date')).toBe('')
    expect(formatRelative('')).toBe('')
  })
})

describe('formatTimeAgo', () => {
  const now = NOW.getTime()

  it('picks minutes, hours, then days in the given locale', () => {
    expect(formatTimeAgo(ago(5), 'en', now)).toBe('5 minutes ago')
    expect(formatTimeAgo(ago(60), 'en', now)).toBe('1 hour ago')
    expect(formatTimeAgo(ago(60 * 24 * 3), 'en', now)).toBe('3 days ago')
    expect(formatTimeAgo(ago(60), 'pt-BR', now)).toBe('há 1 hora')
  })

  it('returns an empty string for an unparseable timestamp', () => {
    expect(formatTimeAgo('nope', 'en', now)).toBe('')
  })
})
