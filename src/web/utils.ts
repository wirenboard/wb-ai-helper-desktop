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

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`
  return `${(n / 1024 / 1024).toFixed(1)} МБ`
}

export function plural(n: number, forms: [string, string, string]): string {
  const n10 = n % 10, n100 = n % 100
  if (n10 === 1 && n100 !== 11) return forms[0]
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1]
  return forms[2]
}
