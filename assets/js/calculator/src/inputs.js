// What the founder tells us. One spec drives the form, the permalink and the
// model, so a field cannot exist in one and not the others.
//
//   key       the input's name everywhere: form field, URL parameter, model
//   type      integer | number | option | multi
//   required  the model refuses to run without it; `default` is then only
//             the form's starting value, never a fallback
//   default   what an empty optional input means
//   options   for option and multi: the allowed values, in display order
//   min, max  bounds; anything outside is a validation error, not a clamp

export const INPUTS = {
  mau: { type: 'integer', required: true, default: 50000, min: 1, max: 2e9 },
  posts: { type: 'integer', required: false, default: null, min: 0, max: 1e12 }, // blank → 20 × mau, see defaultsFor
  mb: { type: 'number', required: false, default: 50, min: 0, max: 1e6 },
  eng: { type: 'integer', required: true, default: 3, min: 0, max: 100000 },
  hrs: { type: 'number', required: false, default: null, min: 0, max: 1e6 },
  hrs_accounts: { type: 'number', required: false, default: null, min: 0, max: 1e6 },
  hrs_graph: { type: 'number', required: false, default: null, min: 0, max: 1e6 },
  hrs_storage: { type: 'number', required: false, default: null, min: 0, max: 1e6 },
  ts: { type: 'option', required: true, default: 'none', options: ['none', 'inhouse', 'outsourced'] },
  ts_n: { type: 'integer', required: false, default: 0, min: 0, max: 100000 },
  pay: { type: 'option', required: true, default: 'no', options: ['no', 'yes'] },
  rev: { type: 'number', required: false, default: 0, min: 0, max: 1e12 },
  stores: { type: 'multi', required: false, default: ['apple', 'google'], options: ['apple', 'google', 'web'] },
  jur: { type: 'multi', required: true, default: ['us'], options: ['eu', 'uk', 'us', 'other'] },
  nostr: { type: 'multi', required: false, default: [], options: ['accounts', 'graph', 'storage', 'moderation', 'payments'] },
}

/** Defaults that depend on another input. */
export function defaultsFor(partial) {
  const out = {}
  for (const [key, spec] of Object.entries(INPUTS)) out[key] = Array.isArray(spec.default) ? [...spec.default] : spec.default
  const mau = toNumber(partial?.mau)
  out.posts = mau > 0 ? mau * 20 : 1000000
  return out
}

export class InputError extends Error {
  constructor(key, code) {
    super(`${key}: ${code}`)
    this.key = key
    this.code = code
  }
}

function toNumber(v) {
  if (v === '' || v == null) return NaN
  if (typeof v === 'number') return v
  return Number(String(v).replace(/[,\s_]/g, ''))
}

/**
 * Validate and complete a set of raw inputs (strings from a form or a URL are
 * fine). Returns a clean object with every key present, or throws InputError
 * naming the first offending key. Optional numeric inputs left blank become
 * their default, or null where the model treats "not given" differently.
 */
export function normalizeInputs(raw = {}) {
  const defaults = defaultsFor(raw)
  const out = {}
  for (const [key, spec] of Object.entries(INPUTS)) {
    let v = raw[key]
    const blank = v == null || v === '' || (Array.isArray(v) && v.length === 0)
    if (blank) {
      if (spec.required) throw new InputError(key, 'required')
      out[key] = defaults[key]
      continue
    }
    if (spec.type === 'option') {
      v = String(v)
      if (!spec.options.includes(v)) throw new InputError(key, 'invalid')
      out[key] = v
    } else if (spec.type === 'multi') {
      const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean)
      for (const item of list) if (!spec.options.includes(item)) throw new InputError(key, 'invalid')
      out[key] = spec.options.filter((o) => list.includes(o)) // canonical order, deduped
      if (spec.required && out[key].length === 0) throw new InputError(key, 'required')
    } else {
      const n = toNumber(v)
      if (!Number.isFinite(n)) throw new InputError(key, 'not_a_number')
      if (spec.type === 'integer' && !Number.isInteger(n)) throw new InputError(key, 'not_an_integer')
      if (n < spec.min) throw new InputError(key, 'too_small')
      if (n > spec.max) throw new InputError(key, 'too_large')
      out[key] = n
    }
  }
  // Dependent requirements.
  if (out.ts !== 'none' && !(out.ts_n > 0)) throw new InputError('ts_n', 'required')
  if (out.pay === 'yes' && !(out.rev > 0)) throw new InputError('rev', 'required')
  return out
}
