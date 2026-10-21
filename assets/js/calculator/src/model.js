// The cost model. Pure functions, no DOM, no network: inputs and assumptions
// in, numbers out. Everything the page shows is computed here, so this file is
// the one to audit.
//
//   calculate(inputs, assumptions, overrides) → { typical, low, high, ... }
//
// Each scenario evaluates the same six lines with that scenario's assumption
// values. A user override replaces the value in every scenario: it is their
// fact, not our estimate. Every line returns two annual figures, custodial
// and non-custodial, and the parts they add up from, so the page can show
// the applied rates beside the result.
//
// Units: USD per year unless a name says otherwise.

import { INPUTS, normalizeInputs } from './inputs.js'

export const LINES = ['accounts', 'graph', 'storage', 'compliance', 'moderation', 'payments']
export const SCENARIOS = ['low', 'typical', 'high']

// Model constants, not assumptions: conventions rather than estimates.
export const HOURS_PER_YEAR = 2000 // 50 weeks of 40 hours
export const WEEKS_PER_YEAR = 50
export const RETENTION_MONTHS = 12 // how long post metadata is kept in the database term

/** One flat {key: value} for a scenario, with the user's overrides applied. */
export function resolveAssumptions(data, scenario, overrides = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`)
  const out = {}
  for (const [key, a] of Object.entries(data.assumptions)) {
    const o = overrides[key]
    out[key] = o != null && Number.isFinite(Number(o)) ? Number(o) : a[scenario]
  }
  return out
}

/** Keep only overrides that name a real assumption with a finite, non-negative value. */
export function cleanOverrides(data, overrides = {}) {
  const out = {}
  for (const [key, v] of Object.entries(overrides)) {
    if (!(key in data.assumptions)) continue
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) continue
    if (n === data.assumptions[key].typical) continue
    out[key] = n
  }
  return out
}

// ── helpers ─────────────────────────────────────────────────────────────────

const loadedHourly = (v) => (v.eng_base_salary * v.loaded_multiplier * v.overhead_multiplier) / HOURS_PER_YEAR
const loadedYear = (base, v) => base * v.loaded_multiplier * v.overhead_multiplier

/**
 * Engineering hours a year attributed to one area. Per-area hours win; then a
 * total split by the three shares; then headcount times the area's share.
 */
function engHoursYear(area, inputs, v) {
  const own = inputs[`hrs_${area}`]
  if (own != null) return own * WEEKS_PER_YEAR
  const shares = { accounts: v.share_eng_accounts, graph: v.share_eng_graph, storage: v.share_eng_storage }
  if (inputs.hrs != null) {
    const total = shares.accounts + shares.graph + shares.storage
    return inputs.hrs * WEEKS_PER_YEAR * (total > 0 ? shares[area] / total : 1 / 3)
  }
  return inputs.eng * HOURS_PER_YEAR * shares[area]
}

const part = (id, custodial, noncustodial, extra = {}) => ({ id, custodial, noncustodial, ...extra })
const sum = (parts, side) => parts.reduce((acc, p) => acc + p[side], 0)
const has = (inputs, j) => inputs.jur.includes(j)

// ── the six lines ───────────────────────────────────────────────────────────

function accounts(inputs, v) {
  const { mau } = inputs
  const verifyShare = Math.max(
    has(inputs, 'uk') ? v.verify_share_uk : 0,
    has(inputs, 'us') ? v.verify_share_us : 0,
    has(inputs, 'eu') ? v.verify_share_eu : 0,
    has(inputs, 'other') ? v.verify_share_other : 0,
  )
  const verify = mau * verifyShare * v.verify_price
  const eng = engHoursYear('accounts', inputs, v) * loadedHourly(v)
  const parts = [
    part('auth', mau * v.auth_per_mau_month * 12, 0),
    part('resets', mau * v.reset_rate_per_mau_year * v.reset_cost, 0),
    part('verify', verify, verify, { rate: verifyShare }),
    part('engineering', eng, 0),
    part('key_support', 0, mau * v.key_support_per_mau_year),
  ]
  return { parts }
}

function graph(inputs, v) {
  const { mau, posts } = inputs
  const dbGb = (mau * v.db_mb_per_mau) / 1024 + (posts * RETENTION_MONTHS * v.db_kb_per_post) / 1024 / 1024
  const eng = engHoursYear('graph', inputs, v) * loadedHourly(v)
  const parts = [
    part('database', dbGb * v.db_gb_month * 12, 0, { gb: dbGb }),
    part('feed_compute', mau * v.compute_per_mau_year * v.feed_compute_share, 0),
    part('engineering', eng, eng * v.graph_eng_remains_share),
    part('ranking', 0, mau * v.ranking_fee_per_mau_year),
  ]
  return { parts }
}

function storage(inputs, v) {
  const { mau, mb } = inputs
  const blob = (mau * mb) / 1024 * v.blob_gb_month * 12
  const egress = mau * v.egress_gb_per_mau_month * v.egress_gb * 12
  const eng = engHoursYear('storage', inputs, v) * loadedHourly(v)
  const parts = [
    part('blob', blob, blob * v.media_sponsor_share),
    part('egress', egress, egress * v.media_sponsor_share),
    part('serving', mau * v.compute_per_mau_year * (1 - v.feed_compute_share), mau * v.cache_per_mau_year),
    part('engineering', eng, 0),
    part('relay', 0, v.relay_cost_year),
  ]
  return { parts }
}

function compliance(inputs, v) {
  const { mau } = inputs
  const eu = has(inputs, 'eu')
  const uk = has(inputs, 'uk')
  const us = has(inputs, 'us')
  const gdpr = eu || uk ? v.gdpr_program_year : 0
  const osa = uk ? v.uk_osa_year : 0
  const dsa = eu ? v.dsa_year : 0
  const usp = us ? (mau >= v.ccpa_consumer_threshold ? v.us_privacy_year_large : v.us_privacy_year_small) : 0
  const dsar = eu || uk || us ? mau * v.dsar_rate_per_mau_year * v.dsar_cost : 0
  const breach = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.breach_cost_per_user)
  const breachRemains = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.retained_data_share * v.breach_cost_per_user)
  const parts = [
    part('privacy_programs', gdpr + usp, (gdpr + usp) * v.privacy_remains_share, { us_tier: us ? (mau >= v.ccpa_consumer_threshold ? 'large' : 'small') : null }),
    part('content_law', osa + dsa, osa + dsa),
    part('dsar', dsar, 0),
    part('insurance', v.cyber_insurance_year, v.cyber_insurance_year * v.insurance_remains_share),
    part('breach', breach, breachRemains),
  ]
  return { parts }
}

function moderation(inputs, v) {
  const { mau, ts, ts_n } = inputs
  let labour
  let implied = false
  if (ts === 'inhouse') labour = ts_n * loadedYear(v.ts_base_salary, v)
  else if (ts === 'outsourced') labour = ts_n * v.moderator_seat_outsourced
  else {
    labour = (mau / 1e6) * v.mods_per_million_mau * loadedYear(v.moderator_base_salary, v)
    implied = true
  }
  const appeals = labour * v.appeals_share
  const tooling = mau * v.ts_tooling_per_mau_year
  const parts = [
    part('labour', labour, labour * v.moderation_remains_share, { implied, people: ts === 'none' ? (mau / 1e6) * v.mods_per_million_mau : ts_n }),
    part('appeals', appeals, appeals * v.moderation_remains_share),
    part('tooling', tooling, tooling),
  ]
  return { parts, implied }
}

function payments(inputs, v) {
  if (inputs.pay !== 'yes') return { parts: [], none: true }
  const annual = inputs.rev * 12
  const stores = inputs.stores.length ? inputs.stores : ['web']
  const share = 1 / stores.length
  const small = annual < v.store_small_threshold
  const parts = []
  for (const store of stores) {
    const rev = annual * share
    if (store === 'apple' || store === 'google') {
      const rate = store === 'apple' ? (small ? v.apple_rate_small : v.apple_rate_standard) : small ? v.google_rate_small : v.google_rate_standard
      parts.push(part(`store_${store}`, rev * rate, rev * rate, { rate, tier: small ? 'small' : 'standard', revenue: rev }))
    } else {
      const processor = rev * v.processor_rate + (rev / v.avg_ticket) * v.processor_fixed
      parts.push(part('processor', processor, rev * v.lightning_rate, { rate: v.processor_rate, fixed: v.processor_fixed, revenue: rev }))
    }
  }
  parts.push(part('money_transmitter', v.mt_avoidance_year, v.mt_avoidance_year * v.mt_remains_share))
  return { parts, tier: small ? 'small' : 'standard' }
}

const LINE_FN = { accounts, graph, storage, compliance, moderation, payments }

// Which "already on Nostr" ticks make a line already non-custodial. Compliance
// follows accounts and storage together: the data has to be gone for the
// obligations on it to go.
function alreadyOn(line, inputs) {
  const on = inputs.nostr
  if (line === 'compliance') return on.includes('accounts') && on.includes('storage')
  return on.includes(line)
}

/** Evaluate every line for one set of assumption values. */
export function evaluate(inputs, v) {
  const lines = {}
  let custodial = 0
  let noncustodial = 0
  for (const name of LINES) {
    const r = LINE_FN[name](inputs, v)
    const already = alreadyOn(name, inputs)
    const nc = sum(r.parts, 'noncustodial')
    const c = already ? nc : sum(r.parts, 'custodial')
    lines[name] = { ...r, custodial: c, noncustodial: nc, already }
    custodial += c
    noncustodial += nc
  }
  const { mau } = inputs
  return {
    lines,
    totals: {
      custodial,
      noncustodial,
      saving: custodial - noncustodial,
      per_mau_custodial: custodial / mau,
      per_mau_noncustodial: noncustodial / mau,
    },
  }
}

/**
 * The whole result: the typical scenario plus the low and high bounds, the
 * clean inputs the page should echo back, and the overrides that applied.
 */
export function calculate(rawInputs, data, rawOverrides = {}) {
  const inputs = normalizeInputs(rawInputs)
  const overrides = cleanOverrides(data, rawOverrides)
  const out = { version: data.version, inputs, overrides }
  for (const s of SCENARIOS) out[s] = evaluate(inputs, resolveAssumptions(data, s, overrides))
  return out
}

export { INPUTS, normalizeInputs }
