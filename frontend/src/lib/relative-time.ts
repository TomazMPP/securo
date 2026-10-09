/** Compact relative-time formatter shared by chat lists and similar
 *  surfaces — "2m ago / 3h ago / yesterday / 4d ago / Mar 14".
 *  Plain Date math, no date library. */
export function formatRelative(iso: string): string {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  if (Number.isNaN(diffMs)) return ''
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD === 1) return 'yesterday'
  if (diffD < 7) return `${diffD}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Localized "1 hour ago" / "há 1 hora" for a past timestamp, at the
 *  coarsest unit that is at least 1 (minutes, hours, then days).
 *  Empty for an unparseable date. */
export function formatTimeAgo(iso: string, locale: string, now = Date.now()): string {
  const diffMs = now - new Date(iso).getTime()
  if (Number.isNaN(diffMs)) return ''
  let rtf: Intl.RelativeTimeFormat
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  }
  const minutes = Math.max(0, Math.floor(diffMs / 60000))
  if (minutes < 60) return rtf.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  return rtf.format(-Math.floor(hours / 24), 'day')
}
