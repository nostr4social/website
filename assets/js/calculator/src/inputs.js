// What the founder tells us: the published form's questions, one key per
// answer. One spec drives the page's form, the results link and the model,
// so a field cannot exist in one and not the others. The id map in
// _data/forms/map.yml says which form question each key is sent as.
//
//   key       the input's name everywhere: form field, URL parameter, model
//   type      integer | number | option | multi
//   required  the model refuses to run without it; `default` is then only
//             the form's starting value, never a fallback
//   default   what an empty optional input means; null where the model
//             treats "not given" differently
//   options   for option and multi: the allowed values, in display order.
//             A grid row is an option whose values are the band midpoints
//             the model reads, so "1 to 10 hours" arrives as "5".

const HOURS = ['0', '5', '25', '60'] // 0 · 1 to 10 · 11 to 40 · over 40 hours a week
const HEADS = ['0', '5', '50', '500', '2000'] // 0 · 1 to 10 · 11 to 100 · 101 to 1000 · over 1000 people
const NOSTR = ['0', '0.5', '1'] // never · somewhat · always
const GROWTH = ['0', '0.25', '0.5', '1'] // Flat / Steady / Fast / Doubling

//   omit      a value that means the same as "not given"; the results link
//             leaves it out so a link only carries what was said
const band = (options, omit) => ({ type: 'option', required: false, default: null, options, omit })

export const INPUTS = {
  // Non Custody: "Our app already uses Nostr"
  n_keys: band(NOSTR, '0'), // user accounts are private keys
  n_raw_keys: band(NOSTR, '0'), // app handles raw private keys (the inverse)
  n_signed_events: band(NOSTR, '0'), // user data stored as signed events
  n_event_storage: band(NOSTR, '0'), // user choice for event storage
  n_media_storage: band(NOSTR, '0'), // user choice for media storage
  n_labels: band(NOSTR, '0'), // content tags and labels as signed events
  n_feeds: band(NOSTR, '0'), // user configurable feeds and algos
  n_algos: band(NOSTR, '0'), // user choice for algo processing
  n_p2p: band(NOSTR, '0'), // peer to peer in-app payments
  n_nips: band(NOSTR, '0'), // NIP standards published publicly (read, not priced)

  // Accounts & Storage
  mau: { type: 'integer', required: true, default: 50000, min: 1, max: 2e9 },
  posts_per_user: { type: 'number', required: false, default: 20, min: 0, max: 1e6 },
  mb: { type: 'number', required: false, default: 50, min: 0, max: 1e6 },

  // Staffing Costs
  eng_accounts: band(HOURS), // engineering hours a week: managing user accounts
  eng_content: band(HOURS), // managing user content
  eng_infra: band(HOURS), // managing infrastructure
  eng_legal: band(HOURS), // legal and compliance
  mod_inhouse: band(HEADS, '0'), // content review and moderation: in-house employees
  mod_vendor: band(HEADS, '0'), // outside vendor seats
  legal_usd: { type: 'number', required: false, default: null, min: 0, max: 1e12, omit: '0' }, // 0 means not given

  // Payment Gateway
  rails: { type: 'multi', required: false, default: [], options: ['p2p', 'apple', 'google', 'processor', 'reseller'] },
  rev: { type: 'number', required: false, default: 0, min: 0, max: 1e12 },
  balances: { type: 'multi', required: false, default: [], options: ['yes'] },

  // Availability & Growth
  distribution: { type: 'multi', required: false, default: [], options: ['apple', 'google', 'web'] },
  jur: { type: 'multi', required: true, default: ['us'], options: ['eu', 'uk', 'us', 'other'] },
  growth: band(GROWTH), // users a year from now, as a share of today's; blank means the assumptions' default
}

/** The keys that are grid rows, by grid, for the submission and the form. */
export const GRIDS = {
  nostr: ['n_keys', 'n_raw_keys', 'n_signed_events', 'n_event_storage', 'n_media_storage', 'n_labels', 'n_feeds', 'n_algos', 'n_p2p', 'n_nips'],
  engineering: ['eng_accounts', 'eng_content', 'eng_infra', 'eng_legal'],
  moderation: ['mod_inhouse', 'mod_vendor'],
}

export function defaultsFor() {
  const out = {}
  for (const [key, spec] of Object.entries(INPUTS)) out[key] = Array.isArray(spec.default) ? [...spec.default] : spec.default
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
 * naming the first offending key.
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
  if (out.rails.length && !(out.rev > 0)) throw new InputError('rev', 'required')
  return out
}
