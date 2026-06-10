import { fmtSize as i18nFmtSize, lang } from './i18n'

type Cost = { value: number; currency: 'USD' | 'RUB' }

export function fmtCost(cost: Cost | number): string {
  // Backwards-compat: numbers default to USD
  const c: Cost = typeof cost === 'number' ? { value: cost, currency: 'USD' } : cost
  const sign = c.currency === 'RUB' ? '₽' : '$'
  const v = c.value
  if (c.currency === 'USD') {
    if (v < 0.001) return `< ${sign}0.001`
    if (v < 0.01) return `${sign}${v.toFixed(3)}`
    return `${sign}${v.toFixed(2)}`
  }
  // RUB: show kopecks until ~1 ₽, then no decimals
  if (v < 0.01) return `< 0.01 ${sign}`
  if (v < 1) return `${v.toFixed(2)} ${sign}`
  if (v < 100) return `${v.toFixed(2)} ${sign}`
  return `${v.toFixed(0)} ${sign}`
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function fmtTime(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const now = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay(d, now)) return `${hh}:${mm}`
  const dd = String(d.getDate()).padStart(2, '0')
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  // EN expects month-first; RU day-first.
  const date = lang.value === 'en' ? `${mo}/${dd}` : `${dd}.${mo}`
  return `${date} ${hh}:${mm}`
}

// Locale-aware byte-size formatter; delegates to the i18n module so units switch with the UI language.
export const fmtSize = i18nFmtSize
