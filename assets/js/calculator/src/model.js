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
// "Our app already uses Nostr" gives each line a share between 0 and 1; the
// custodial figure then moves that far toward the non-custodial one.
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
const num = (x) => (x == null || x === '' ? null : Number(x))

/** Engineering hours a year on one area: the band given, else the default for that area. */
function engHoursYear(area, inputs, v) {
  const given = num(inputs[`eng_${area}`])
  const defaults = {
    accounts: v.default_hours_accounts,
    content: v.default_hours_content,
    infra: v.default_hours_infra,
    legal: v.default_hours_legal,
  }
  const weekly = given != null ? given : defaults[area]
  return weekly * WEEKS_PER_YEAR
}

/** 0 to 1: how far a line is already non-custodial, from the Nostr grid. */
export function nostrShares(inputs) {
  const g = (k) => num(inputs[k]) ?? 0
  const avg = (...xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  const accounts = g('n_keys') * (1 - g('n_raw_keys'))
  const storage = avg(g('n_event_storage'), g('n_media_storage'))
  return {
    accounts,
    graph: avg(g('n_signed_events'), g('n_feeds')),
    storage,
    compliance: avg(accounts, storage),
    moderation: avg(g('n_labels'), g('n_algos')),
    payments: g('n_p2p'),
  }
}

const part = (id, custodial, noncustodial, extra = {}) => ({ id, custodial, noncustodial, ...extra })
const sum = (parts, side) => parts.reduce((acc, p) => acc + p[side], 0)
const has = (inputs, j) => inputs.jur.includes(j)
const posts = (inputs) => inputs.mau * inputs.posts_per_user

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
    part('engineering', eng, 0, { defaulted: num(inputs.eng_accounts) == null }),
    part('key_support', 0, mau * v.key_support_per_mau_year),
  ]
  return { parts }
}

function graph(inputs, v) {
  const { mau } = inputs
  const dbGb = (mau * v.db_mb_per_mau) / 1024 + (posts(inputs) * RETENTION_MONTHS * v.db_kb_per_post) / 1024 / 1024
  const eng = engHoursYear('content', inputs, v) * loadedHourly(v)
  const parts = [
    part('database', dbGb * v.db_gb_month * 12, 0, { gb: dbGb }),
    part('feed_compute', mau * v.compute_per_mau_year * v.feed_compute_share, 0),
    part('engineering', eng, eng * v.graph_eng_remains_share, { defaulted: num(inputs.eng_content) == null }),
    part('ranking', 0, mau * v.ranking_fee_per_mau_year),
  ]
  return { parts }
}

function storage(inputs, v) {
  const { mau, mb } = inputs
  const blob = (mau * mb) / 1024 * v.blob_gb_month * 12
  const egress = mau * v.egress_gb_per_mau_month * v.egress_gb * 12
  const eng = engHoursYear('infra', inputs, v) * loadedHourly(v)
  const parts = [
    part('blob', blob, blob * v.media_sponsor_share),
    part('egress', egress, egress * v.media_sponsor_share),
    part('serving', mau * v.compute_per_mau_year * (1 - v.feed_compute_share), mau * v.cache_per_mau_year),
    part('engineering', eng, 0, { defaulted: num(inputs.eng_infra) == null }),
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
  const usTier = us ? (mau >= v.ccpa_consumer_threshold ? 'large' : 'small') : null
  const usp = us ? (usTier === 'large' ? v.us_privacy_year_large : v.us_privacy_year_small) : 0
  const contentLaw = osa + dsa

  // Reported legal spend replaces the program estimates; the content-law
  // floor still applies to what remains.
  const reported = num(inputs.legal_usd) || null // 0 means not given
  let programs
  let programsRemain
  if (reported != null && reported > 0) {
    programs = reported
    programsRemain = Math.min(reported, contentLaw) + Math.max(0, reported - contentLaw) * v.privacy_remains_share
  } else {
    programs = gdpr + usp + contentLaw
    programsRemain = contentLaw + (gdpr + usp) * v.privacy_remains_share
  }
  const legal = engHoursYear('legal', inputs, v) * loadedHourly(v)
  const dsar = eu || uk || us ? mau * v.dsar_rate_per_mau_year * v.dsar_cost : 0
  const breach = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.breach_cost_per_user)
  const breachRemains = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.retained_data_share * v.breach_cost_per_user)
  const parts = [
    part('privacy_programs', programs, programsRemain, { us_tier: usTier, reported: reported != null && reported > 0 }),
    part('legal_labour', legal, legal * v.privacy_remains_share, { defaulted: num(inputs.eng_legal) == null }),
    part('dsar', dsar, 0),
    part('insurance', v.cyber_insurance_year, v.cyber_insurance_year * v.insurance_remains_share),
    part('breach', breach, breachRemains),
  ]
  return { parts }
}

function moderation(inputs, v) {
  const { mau } = inputs
  const inhouse = num(inputs.mod_inhouse) ?? 0
  const vendor = num(inputs.mod_vendor) ?? 0
  let labour
  let people
  let implied = false
  if (inhouse > 0 || vendor > 0) {
    labour = inhouse * loadedYear(v.ts_base_salary, v) + vendor * v.moderator_seat_outsourced
    people = inhouse + vendor
  } else {
    people = (mau / 1e6) * v.mods_per_million_mau
    labour = people * loadedYear(v.moderator_base_salary, v)
    implied = true
  }
  const appeals = labour * v.appeals_share
  const tooling = mau * v.ts_tooling_per_mau_year
  const parts = [
    part('labour', labour, labour * v.moderation_remains_share, { implied, people }),
    part('appeals', appeals, appeals * v.moderation_remains_share),
    part('tooling', tooling, tooling),
  ]
  return { parts, implied }
}

function payments(inputs, v) {
  const rails = inputs.rails
  if (!rails.length || !(inputs.rev > 0)) return { parts: [], none: true }
  const annual = inputs.rev * 12
  const share = 1 / rails.length
  const small = annual < v.store_small_threshold
  const parts = []
  for (const rail of rails) {
    const rev = annual * share
    if (rail === 'apple' || rail === 'google') {
      const rate = rail === 'apple' ? (small ? v.apple_rate_small : v.apple_rate_standard) : small ? v.google_rate_small : v.google_rate_standard
      parts.push(part(`store_${rail}`, rev * rate, rev * rate, { rate, tier: small ? 'small' : 'standard', revenue: rev }))
    } else if (rail === 'processor') {
      const fee = rev * v.processor_rate + (rev / v.avg_ticket) * v.processor_fixed
      parts.push(part('processor', fee, rev * v.lightning_rate, { rate: v.processor_rate, fixed: v.processor_fixed, revenue: rev }))
    } else if (rail === 'reseller') {
      const fee = rev * v.reseller_rate + (rev / v.avg_ticket) * v.reseller_fixed
      parts.push(part('reseller', fee, rev * v.lightning_rate, { rate: v.reseller_rate, fixed: v.reseller_fixed, revenue: rev }))
    } else {
      const fee = rev * v.lightning_rate
      parts.push(part('p2p', fee, fee, { rate: v.lightning_rate, revenue: rev }))
    }
  }
  const holds = inputs.balances.includes('yes')
  parts.push(part('money_transmitter', holds ? v.mt_avoidance_year : 0, holds ? v.mt_avoidance_year * v.mt_remains_share : 0, { holds }))
  return { parts, tier: small ? 'small' : 'standard' }
}

const LINE_FN = { accounts, graph, storage, compliance, moderation, payments }

/** Evaluate every line for one set of assumption values. */
export function evaluate(inputs, v) {
  const shares = nostrShares(inputs)
  const lines = {}
  let custodial = 0
  let noncustodial = 0
  for (const name of LINES) {
    const r = LINE_FN[name](inputs, v)
    const nc = sum(r.parts, 'noncustodial')
    const full = sum(r.parts, 'custodial')
    const share = Math.min(1, Math.max(0, shares[name]))
    const c = full - share * (full - nc)
    lines[name] = { ...r, custodial: c, noncustodial: nc, full, share, already: share >= 0.999, partly: share > 0 && share < 0.999 }
    custodial += c
    noncustodial += nc
  }
  const { mau } = inputs
  return {
    lines,
    shares,
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
