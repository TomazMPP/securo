// Card statements carry raw acquirer strings ("MP*MERCADOLIVRE",
// "PG *ESTRATEGIACON", "AMAZON BRSAO PAULO"). For display, drop the
// payment-processor prefix and title-case shouting text; the raw string
// stays available as a tooltip.
const PROCESSOR_PREFIX = /^(?:MP|PG|PAG|PAGSEGURO|EBN|EC|IZ|SUMUP|STONE|PP|PAYPAL|DL|HNA|VINDI|ZP|MERCADOPAGO)\s*\*\s*/i

const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o'])

export function merchantName(raw: string): string {
  let s = raw.trim().replace(PROCESSOR_PREFIX, '').replace(/\s*\*\s*/g, ' ').replace(/\s{2,}/g, ' ')
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) {
    s = s
      .toLowerCase()
      .split(' ')
      .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ')
  }
  return s || raw
}
