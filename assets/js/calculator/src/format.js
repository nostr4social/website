// Numbers as the page shows them. Money in USD: `approx` for every headline
// figure (two significant figures, so "$290k" and never "$292,469"), compact
// where a figure stands alone, and in full where figures sit in a column.
// A figure that is not a number is a dash, never "$NaN"; a tiny negative,
// the residue of a fully Nostr line, is zero, never "-$0".

const full = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export const DASH = '—'

/** A number, or NaN for anything that is not one; a value within half a dollar of zero is zero. */
function clean(n) {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x)) return NaN
  return Math.abs(x) < 0.5 ? 0 : x
}

export function money(n) {
  const x = clean(n)
  return Number.isNaN(x) ? DASH : full.format(Math.round(x))
}

/** $968k, $1.2M, $4.99M; under a thousand, the full figure. */
export function compact(n) {
  const x = clean(n)
  if (Number.isNaN(x)) return DASH
  const abs = Math.abs(x)
  const sign = x < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}B`
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`
  if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}k`
  return full.format(Math.round(x))
}

/** Two significant figures, then compact: the one rounding the headline, the lines, the chart and the lead message share. */
export function approx(n) {
  const x = clean(n)
  if (Number.isNaN(x)) return DASH
  if (x === 0) return compact(0)
  const magnitude = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 1)
  return compact(Math.round(x / magnitude) * magnitude)
}

/** Up to three significant figures, with any trailing decimal zeros dropped. Whole numbers stay whole: 210 is 210, not 21. */
function trim(x) {
  const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/** 62.5k, 1.2M; under a thousand, the whole number. The sign stays. */
export function compactNumber(n) {
  const x = clean(n)
  if (Number.isNaN(x)) return DASH
  const abs = Math.abs(x)
  const sign = x < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}${trim(abs / 1e9)}B`
  if (abs >= 1e6) return `${sign}${trim(abs / 1e6)}M`
  if (abs >= 1e3) return `${sign}${trim(abs / 1e3)}k`
  return `${sign}${Math.round(abs)}`
}

export function perMau(n) {
  const x = clean(n)
  return Number.isNaN(x) ? DASH : cents.format(x)
}

export function percent(r) {
  const x = typeof r === 'number' ? r : Number(r)
  return Number.isFinite(x) ? `${plain.format(x * 100)}%` : DASH
}

export function number(n) {
  const x = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(x) ? plain.format(x) : DASH
}

/** A date as the page shows it: the ISO string, which every reader can parse. */
export function date(iso) {
  return iso ? String(iso) : DASH
}
