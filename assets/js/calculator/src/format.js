// Numbers as the page shows them. Money in USD, compact where a figure stands
// alone (hero, tiles, ranges) and in full where figures sit in a column.

const full = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export function money(n) {
  return full.format(Math.round(n))
}

/** $968k, $1.2M, $4.99M; under a thousand, the full figure. */
export function compact(n) {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}B`
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`
  if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}k`
  return full.format(Math.round(n))
}

/** Up to three significant figures, with any trailing decimal zeros dropped. Whole numbers stay whole: 210 is 210, not 21. */
function trim(x) {
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

export function perMau(n) {
  return cents.format(n)
}

export function percent(r) {
  return `${plain.format(r * 100)}%`
}

export function number(n) {
  return plain.format(n)
}
