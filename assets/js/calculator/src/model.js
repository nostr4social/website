// The cost model. Pure functions, no DOM, no network: inputs and assumptions
// in, numbers out. Everything the page shows is computed here, so this file is
// the one to audit.
//
//   calculate(inputs, assumptions, overrides) → { typical, low, high, ... }
//
// Each scenario evaluates the same six lines. Only the assumptions marked
// `scenario_varies` in the file (Nostr4's thesis: the time to scale, what
// remains at scale, the Nostr-native fees) take their low or high value;
// everything on the custodial side stays at its typical value in all three,
// because that half is the prospect's to override. A user override replaces
// the value in every scenario: it is their fact, not our estimate. Every line
// returns two annual figures, custodial and non-custodial, and the parts they
// add up from, so the page can show the applied rates beside the result.
//
// "Your app uses Nostr for the following" gives each line a share between 0
// and 1; the custodial figure then moves that far toward the non-custodial
// one. deriveInputs() fills what the form's opening questions imply.
//
// Units: USD per year unless a name says otherwise.

import { INPUTS, normalizeInputs } from './inputs.js'

export const LINES = ['accounts', 'graph', 'storage', 'compliance', 'moderation', 'payments']
// `project` below carries the saving forward five years. Low is the smaller
// saving: the thesis holding less well, not the cheaper cloud bill.
export const SCENARIOS = ['low', 'typical', 'high']
export const JURISDICTIONS = ['eu', 'uk', 'us', 'other']

// Model constants, not assumptions: conventions rather than estimates.
export const HOURS_PER_YEAR = 2000 // 50 weeks of 40 hours
export const WEEKS_PER_YEAR = 50
export const RETENTION_MONTHS = 12 // how long post metadata is kept in the database term

/**
 * One flat {key: value} for a scenario, with the user's overrides applied.
 * An assumption without `scenario_varies` is the same in every scenario.
 */
export function resolveAssumptions(data, scenario, overrides = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`)
  const out = {}
  for (const [key, a] of Object.entries(data.assumptions)) {
    const o = overrides[key]
    out[key] = o != null && Number.isFinite(Number(o)) ? Number(o) : a[a.scenario_varies ? scenario : 'typical']
  }
  return out
}

/** The assumptions whose low and high values move the band: Nostr4's thesis. */
export function varyingKeys(data) {
  return Object.keys(data.assumptions).filter((key) => data.assumptions[key].scenario_varies)
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

/** The default engineering hours a week on one area. */
function defaultHours(area, v) {
  if (area === 'accounts') return v.default_hours_accounts
  if (area === 'content') return v.default_hours_content
  if (area === 'infra') return v.default_hours_infra
  return v.default_hours_legal
}

/** Engineering hours a week on one area: the band given (or derived), else the default for that area. */
function engHoursWeek(area, inputs, v) {
  const given = num(inputs[`eng_${area}`])
  return given != null ? given : defaultHours(area, v)
}

/** The engineering part of a line: hours a week × weeks × the loaded hour. */
function engineering(area, inputs, v) {
  const hours = engHoursWeek(area, inputs, v)
  const hourly = loadedHourly(v)
  const from = inputs.derived?.[`eng_${area}`]
  return { cost: hours * WEEKS_PER_YEAR * hourly, hours, hourly, defaulted: num(inputs[`eng_${area}`]) == null || Boolean(from), from }
}

// ── the openers' defaults ───────────────────────────────────────────────────
//
// Each section of the form opens with one question; answering it sets the
// section's defaults here. The hidden questions stay unanswered until the
// founder touches them, so a response and a link carry only what was said.
// What was derived is listed in `derived`, key → where it came from, and the
// page shows those values as suggestions.

function kindPosts(kind, v) {
  if (kind === 'messaging') return v.kind_messaging_posts
  if (kind === 'feed') return v.kind_feed_posts
  if (kind === 'community') return v.kind_community_posts
  if (kind === 'marketplace') return v.kind_marketplace_posts
  return v.posts_default
}

function kindMb(kind, v) {
  if (kind === 'messaging') return v.kind_messaging_mb
  if (kind === 'feed') return v.kind_feed_mb
  if (kind === 'community') return v.kind_community_mb
  if (kind === 'marketplace') return v.kind_marketplace_mb
  return v.mb_default
}

function teamFactor(team, v) {
  if (team === 'one') return v.team_factor_one
  if (team === 'ten') return v.team_factor_ten
  if (team === 'fifty') return v.team_factor_fifty
  if (team === 'more') return v.team_factor_more
  return null
}

/** The kind of app sets how many bytes and how much compute a user costs; an override in Other Info still wins. */
function kindEgress(kind, v) {
  if (kind === 'messaging') return v.kind_messaging_egress_gb
  if (kind === 'feed') return v.kind_feed_egress_gb
  if (kind === 'community') return v.kind_community_egress_gb
  if (kind === 'marketplace') return v.kind_marketplace_egress_gb
  return null
}

function kindCompute(kind, v) {
  if (kind === 'messaging') return v.kind_messaging_compute
  if (kind === 'feed') return v.kind_feed_compute
  if (kind === 'community') return v.kind_community_compute
  if (kind === 'marketplace') return v.kind_marketplace_compute
  return null
}

/**
 * Assumption values with the kind of app applied: egress and compute per
 * user follow the kind unless the visitor overrode them. Returns the values
 * and which keys the kind set.
 */
export function applyKind(v, kind, overrides = {}) {
  const out = { ...v }
  const set = {}
  const egress = kindEgress(kind, v)
  if (egress != null && !('egress_gb_per_mau_month' in overrides)) {
    out.egress_gb_per_mau_month = egress
    set.egress_gb_per_mau_month = 'kind'
  }
  const compute = kindCompute(kind, v)
  if (compute != null && !('compute_per_mau_year' in overrides)) {
    out.compute_per_mau_year = compute
    set.compute_per_mau_year = 'kind'
  }
  return { values: out, set }
}

const NOSTR_ROWS = ['n_keys', 'n_raw_keys', 'n_signed_events', 'n_event_storage', 'n_media_storage', 'n_labels', 'n_feeds', 'n_algos', 'n_p2p', 'n_nips']
const RAIL_FOR = { apple: 'apple', google: 'google', web: 'processor' }

/** Clean inputs → the inputs the model runs on, with the openers' defaults filled in and listed. */
export function deriveInputs(inputs, v) {
  const eff = { ...inputs }
  const derived = {}
  // Openers left blank stand on the model's own default, so the page can show it.
  if (eff.growth == null) {
    eff.growth = String(v.growth_default)
    derived.growth = 'default'
  }
  if (eff.nostr_now == null) {
    eff.nostr_now = '0'
    derived.nostr_now = 'default'
  }
  // Content: per-user numbers from the kind of app.
  if (eff.posts_per_user == null) {
    eff.posts_per_user = kindPosts(inputs.kind, v)
    derived.posts_per_user = inputs.kind ? 'kind' : 'default'
  }
  if (eff.mb == null) {
    eff.mb = kindMb(inputs.kind, v)
    derived.mb = inputs.kind ? 'kind' : 'default'
  }
  // Team (a required opener): default hours scaled by the team size, for every area left blank.
  const factor = teamFactor(eff.team, v)
  for (const area of ['accounts', 'content', 'infra', 'legal']) {
    const key = `eng_${area}`
    if (num(inputs[key]) != null) continue
    eff[key] = defaultHours(area, v) * factor
    derived[key] = 'team'
  }
  // Moderation: a team or a vendor without a head count gets the default count.
  if ((inputs.mod_who === 'team' || inputs.mod_who === 'vendor') && num(inputs.mod_heads) == null) {
    eff.mod_heads = v.mod_heads_default
    derived.mod_heads = 'default'
  }
  // Payments: rails follow where the app is distributed (everywhere, if unsaid).
  if (eff.rev > 0 && !inputs.rails.length) {
    const places = inputs.distribution.length ? inputs.distribution : ['apple', 'google', 'web']
    eff.rails = [...new Set(places.map((d) => RAIL_FOR[d]))]
    derived.rails = 'distribution'
  }
  // Nostr: the grid follows the opener, except that a Nostr app is assumed not to handle raw keys.
  for (const key of NOSTR_ROWS) {
    if (num(inputs[key]) != null) continue
    eff[key] = key === 'n_raw_keys' ? '0' : eff.nostr_now
    derived[key] = 'nostr_now'
  }
  eff.derived = derived
  return eff
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

/**
 * How the app's users are spread over the regions it named, as shares that
 * add up to one. The form asks which regions, not how many in each, so each
 * chosen region is weighted by its social media users (the jur_weight_*
 * assumptions); a region not chosen has no share.
 */
export function jurShares(inputs, v) {
  const weights = { eu: v.jur_weight_eu, uk: v.jur_weight_uk, us: v.jur_weight_us, other: v.jur_weight_other }
  const chosen = JURISDICTIONS.filter((j) => inputs.jur.includes(j))
  const total = chosen.reduce((acc, j) => acc + weights[j], 0)
  const out = { eu: 0, uk: 0, us: 0, other: 0 }
  for (const j of chosen) out[j] = total > 0 ? weights[j] / total : 1 / chosen.length
  return out
}

/** Whether the app's California users reach the CCPA's consumer threshold. */
export function ccpaApplies(inputs, v, shares = jurShares(inputs, v)) {
  return inputs.jur.includes('us') && inputs.mau * shares.us * v.ca_share_of_us_users >= v.ccpa_consumer_threshold
}

const part = (id, custodial, noncustodial, extra = {}) => ({ id, custodial, noncustodial, ...extra })
const sum = (parts, side) => parts.reduce((acc, p) => acc + p[side], 0)
const has = (inputs, j) => inputs.jur.includes(j)
const posts = (inputs) => inputs.mau * inputs.posts_per_user

// ── the six lines ───────────────────────────────────────────────────────────

function accounts(inputs, v) {
  const { mau } = inputs
  // Each region's share of users needs that region's checks: a weighted mean, not the strictest.
  const shares = jurShares(inputs, v)
  const verifyShare = shares.uk * v.verify_share_uk + shares.us * v.verify_share_us + shares.eu * v.verify_share_eu + shares.other * v.verify_share_other
  const verify = mau * verifyShare * v.verify_price
  const eng = engineering('accounts', inputs, v)
  const parts = [
    part('auth', mau * v.auth_per_mau_month * 12, 0),
    part('resets', mau * v.reset_rate_per_mau_year * v.reset_cost, 0),
    // Age assurance becomes a layer the app reads (store, wallet) rather than buys; a share remains.
    part('verify', verify, verify * v.verify_remains_share, { rate: verifyShare }),
    // Signer and passkey login, recovery flows and sessions still need building and keeping.
    part('engineering', eng.cost, eng.cost * v.accounts_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly }),
    part('key_support', 0, mau * v.key_support_per_mau_year),
  ]
  return { parts }
}

function graph(inputs, v) {
  const { mau } = inputs
  const dbGb = (mau * v.db_mb_per_mau) / 1024 + (posts(inputs) * RETENTION_MONTHS * v.db_kb_per_post) / 1024 / 1024
  const eng = engineering('content', inputs, v)
  const parts = [
    part('database', dbGb * v.db_gb_month * 12, 0, { gb: dbGb, posts: posts(inputs) }),
    part('feed_compute', mau * v.compute_per_mau_year * v.feed_compute_share, 0),
    part('engineering', eng.cost, eng.cost * v.graph_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly }),
    part('ranking', 0, mau * v.ranking_fee_per_mau_year),
  ]
  return { parts }
}

function storage(inputs, v) {
  const { mau, mb } = inputs
  const blobGb = (mau * mb) / 1024
  const blob = blobGb * v.blob_gb_month * 12
  const egressGb = mau * v.egress_gb_per_mau_month * 12
  const egress = egressGb * v.egress_gb
  const eng = engineering('infra', inputs, v)
  const parts = [
    part('blob', blob, blob * v.media_sponsor_share, { gb: blobGb }),
    part('egress', egress, egress * v.media_sponsor_share, { gb: egressGb }),
    part('serving', mau * v.compute_per_mau_year * (1 - v.feed_compute_share), mau * v.cache_per_mau_year, { share: 1 - v.feed_compute_share }),
    // Relay connections, caching and media handling still need engineering time.
    part('engineering', eng.cost, eng.cost * v.infra_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly }),
    // Relays of the app's own scale with its users, never below one managed relay.
    part('relay', 0, Math.max(v.relay_floor_year, mau * v.relay_per_mau_year), { floor: mau * v.relay_per_mau_year < v.relay_floor_year }),
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
  // The CCPA counts California consumers: the app's US users times the Californian share, not total MAU.
  const shares = jurShares(inputs, v)
  const usTier = us ? (ccpaApplies(inputs, v, shares) ? 'large' : 'small') : null
  const usp = us ? (usTier === 'large' ? v.us_privacy_year_large : v.us_privacy_year_small) : 0
  const contentLaw = osa + dsa

  // Reported legal spend replaces the program estimates. The content-law
  // programs remain in part (a client that hosts nothing is a weaker target
  // than a platform), the privacy programs for whatever is still retained.
  const reported = num(inputs.legal_usd) || null // 0 means not given
  let programs
  let programsRemain
  if (reported != null && reported > 0) {
    programs = reported
    programsRemain = Math.min(reported, contentLaw) * v.content_law_remains_share + Math.max(0, reported - contentLaw) * v.privacy_remains_share
  } else {
    programs = gdpr + usp + contentLaw
    programsRemain = contentLaw * v.content_law_remains_share + (gdpr + usp) * v.privacy_remains_share
  }
  const legal = engineering('legal', inputs, v)
  // Access requests come from EU and UK users always, and from US users only once the CCPA applies.
  // On Nostr they fall with the data still retained, not to zero.
  const dsarUsers = mau * (shares.eu + shares.uk + (usTier === 'large' ? shares.us : 0))
  const dsar = dsarUsers * v.dsar_rate_per_mau_year * v.dsar_cost
  const breach = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.breach_cost_per_user)
  const breachRemains = v.breach_prob_year * Math.min(v.breach_cost_cap, mau * v.retained_data_share * v.breach_cost_per_user)
  const parts = [
    part('privacy_programs', programs, programsRemain, { us_tier: usTier, reported: reported != null && reported > 0, gdpr, osa, dsa, usp, content_law: contentLaw }),
    part('legal_labour', legal.cost, legal.cost * v.privacy_remains_share, { defaulted: legal.defaulted, hours: legal.hours, hourly: legal.hourly }),
    part('dsar', dsar, dsar * v.retained_data_share, { users: dsarUsers }),
    part('insurance', v.cyber_insurance_year, v.cyber_insurance_year * v.insurance_remains_share),
    // An expected loss, not a bill: probability times severity. The page shows it apart from the cash costs.
    part('breach', breach, breachRemains, { kind: 'risk' }),
  ]
  return { parts }
}

function moderation(inputs, v) {
  const { mau } = inputs
  const who = inputs.mod_who === 'team' || inputs.mod_who === 'vendor' ? inputs.mod_who : 'nobody'
  let labour
  let people
  let loaded
  let implied = false
  if (who === 'team') {
    people = num(inputs.mod_heads) ?? 0
    loaded = loadedYear(v.ts_base_salary, v)
    labour = people * loaded
  } else if (who === 'vendor') {
    people = num(inputs.mod_heads) ?? 0
    loaded = v.moderator_seat_outsourced
    labour = people * loaded
  } else {
    people = (mau / 1e6) * v.mods_per_million_mau
    loaded = loadedYear(v.moderator_base_salary, v)
    labour = people * loaded
    implied = true
  }
  const appeals = labour * v.appeals_share
  const tooling = mau * v.ts_tooling_per_mau_year
  // Review and ranking move to the network; what remains is for anything the
  // app itself hosts, plus a label or web-of-trust provider as the Nostr-native cost.
  const parts = [
    part('labour', labour, labour * v.moderation_remains_share, { implied, who, people, loaded, heads_from: inputs.derived?.mod_heads }),
    part('appeals', appeals, appeals * v.moderation_remains_share),
    part('tooling', tooling, tooling * v.tooling_remains_share),
    part('labels', 0, mau * v.label_provider_per_mau_year),
  ]
  return { parts, implied }
}

function payments(inputs, v) {
  const rails = inputs.rails
  if (!rails.length || !(inputs.rev > 0)) return { parts: [], none: true }
  // (rails_from marks rails the openers derived from distribution)
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
      parts.push(part('processor', fee, rev * v.lightning_rate, { rate: v.processor_rate, fixed: v.processor_fixed, revenue: rev, tickets: rev / v.avg_ticket }))
    } else if (rail === 'reseller') {
      const fee = rev * v.reseller_rate + (rev / v.avg_ticket) * v.reseller_fixed
      parts.push(part('reseller', fee, rev * v.lightning_rate, { rate: v.reseller_rate, fixed: v.reseller_fixed, revenue: rev, tickets: rev / v.avg_ticket }))
    } else {
      const fee = rev * v.lightning_rate
      parts.push(part('p2p', fee, fee, { rate: v.lightning_rate, revenue: rev }))
    }
  }
  const holds = inputs.balances.includes('yes')
  parts.push(part('money_transmitter', holds ? v.mt_avoidance_year : 0, holds ? v.mt_avoidance_year * v.mt_remains_share : 0, { holds }))
  return { parts, tier: small ? 'small' : 'standard', rails_from: inputs.derived?.rails }
}

const LINE_FN = { accounts, graph, storage, compliance, moderation, payments }
export const LINE_FUNCTIONS = LINE_FN

// Which assumptions each part reads, by line and part. The page's "How this
// is calculated" dialog lists them and lights them up in the assumptions
// table; a test runs every line with a recording proxy and fails if this map
// and the code disagree. Conditional keys (a jurisdiction's share, a store's
// tier, a default hours band) are listed in full and narrowed on the page.
/** The assumptions an opener's default rests on, by what was derived and from what. */
export function derivedAssumptions(key, from, inputs) {
  if (/^eng_/.test(key)) return [`team_factor_${inputs.team}`]
  if (key === 'posts_per_user') return [from === 'kind' ? `kind_${inputs.kind}_posts` : 'posts_default']
  if (key === 'mb') return [from === 'kind' ? `kind_${inputs.kind}_mb` : 'mb_default']
  if (key === 'mod_heads') return ['mod_heads_default']
  if (key === 'egress_gb_per_mau_month') return [`kind_${inputs.kind}_egress_gb`]
  if (key === 'compute_per_mau_year') return [`kind_${inputs.kind}_compute`]
  return []
}

const PEOPLE = ['eng_base_salary', 'loaded_multiplier', 'overhead_multiplier']
const WEIGHTS = ['jur_weight_eu', 'jur_weight_uk', 'jur_weight_us', 'jur_weight_other']
export const PART_ASSUMPTIONS = {
  'accounts.auth': ['auth_per_mau_month'],
  'accounts.resets': ['reset_rate_per_mau_year', 'reset_cost'],
  'accounts.verify': ['verify_share_uk', 'verify_share_us', 'verify_share_eu', 'verify_share_other', 'verify_price', 'verify_remains_share', ...WEIGHTS],
  'accounts.engineering': [...PEOPLE, 'default_hours_accounts', 'accounts_eng_remains_share'],
  'accounts.key_support': ['key_support_per_mau_year'],
  'graph.database': ['db_mb_per_mau', 'db_kb_per_post', 'db_gb_month'],
  'graph.feed_compute': ['compute_per_mau_year', 'feed_compute_share'],
  'graph.engineering': [...PEOPLE, 'default_hours_content', 'graph_eng_remains_share'],
  'graph.ranking': ['ranking_fee_per_mau_year'],
  'storage.blob': ['blob_gb_month', 'media_sponsor_share'],
  'storage.egress': ['egress_gb_per_mau_month', 'egress_gb', 'media_sponsor_share'],
  'storage.serving': ['compute_per_mau_year', 'feed_compute_share', 'cache_per_mau_year'],
  'storage.engineering': [...PEOPLE, 'default_hours_infra', 'infra_eng_remains_share'],
  'storage.relay': ['relay_per_mau_year', 'relay_floor_year'],
  'compliance.privacy_programs': ['gdpr_program_year', 'uk_osa_year', 'dsa_year', 'us_privacy_year_small', 'us_privacy_year_large', 'ccpa_consumer_threshold', 'ca_share_of_us_users', ...WEIGHTS, 'content_law_remains_share', 'privacy_remains_share'],
  'compliance.legal_labour': [...PEOPLE, 'default_hours_legal', 'privacy_remains_share'],
  'compliance.dsar': ['dsar_rate_per_mau_year', 'dsar_cost', 'retained_data_share', 'ccpa_consumer_threshold', 'ca_share_of_us_users', ...WEIGHTS],
  'compliance.insurance': ['cyber_insurance_year', 'insurance_remains_share'],
  'compliance.breach': ['breach_prob_year', 'breach_cost_cap', 'breach_cost_per_user', 'retained_data_share'],
  'moderation.labour': ['ts_base_salary', 'moderator_base_salary', 'moderator_seat_outsourced', 'mods_per_million_mau', 'loaded_multiplier', 'overhead_multiplier', 'moderation_remains_share'],
  'moderation.appeals': ['appeals_share', 'moderation_remains_share'],
  'moderation.tooling': ['ts_tooling_per_mau_year', 'tooling_remains_share'],
  'moderation.labels': ['label_provider_per_mau_year'],
  'payments.store_apple': ['apple_rate_standard', 'apple_rate_small', 'store_small_threshold'],
  'payments.store_google': ['google_rate_standard', 'google_rate_small', 'store_small_threshold'],
  'payments.processor': ['processor_rate', 'processor_fixed', 'avg_ticket', 'lightning_rate'],
  'payments.reseller': ['reseller_rate', 'reseller_fixed', 'avg_ticket', 'lightning_rate'],
  'payments.p2p': ['lightning_rate'],
  'payments.money_transmitter': ['mt_avoidance_year', 'mt_remains_share'],
}

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

// ── the projection ──────────────────────────────────────────────────────────
//
// Saving over the years, cumulative. Each year re-runs the six lines at that
// year's user count, with revenue held per user (posts and storage already
// are), so fixed program fees and tiers behave as they would; hours, head
// counts and reported legal spend stay as given, which errs conservative.
// Users compound at the growth given, or the default (flat), with each year's
// rate a fraction of the previous (growth_decay). The ramp is the network's,
// not the app's: scale_months is Nostr4's estimate of the time for Nostr to
// establish the standards and infrastructure that support Nostr at scale,
// and the app is assumed to integrate promptly. It is front-loaded, 1 - (1 -
// m/M)^2 by month m, because the standards already adopted (keys, signed
// events, relays, follows) carry the bulk of custodial cost and deliver
// early, while the pieces still maturing (user-paid providers, a media
// market, label and ranking providers, payment conversion) are the tail.
// A calendar, not a stopwatch: year 0 is the same date for every app
// (data.start_year), and MARKER_YEAR is the year the network is at scale.
// Each point also carries `path`: what the app pays that year on the way to
// Nostr, which is the custodial figure less the saving realised, so the two
// start together today and the gap between them is that year's saving.
// No one-time integration cost or time is modelled: that is a conversation,
// not an estimate.

export const YEARS = 5
export const MARKER_YEAR = 3 // Nostr at scale

/** The calendar year a projection year stands for, from the assumptions' start year. */
export function calendarYear(startYear, year) {
  return startYear + year
}

/** The share of year `year`'s saving realised while the network scales over `months`, front-loaded. */
export function rampShare(year, months) {
  if (!(months > 0)) return 1
  let s = 0
  for (let m = (year - 1) * 12 + 1; m <= year * 12; m++) {
    const u = Math.min(1, (m - 0.5) / months)
    s += 1 - (1 - u) ** 2
  }
  return s / 12
}

/** Year 0 (today) through YEARS, for one scenario's assumption values. */
export function project(inputs, v, today = evaluate(inputs, v)) {
  const given = num(inputs.growth)
  let rate = given != null ? given : v.growth_default
  // Each year's lines and their parts; a part's custodial figure is moved
  // toward its Nostr one by the line's "already on Nostr" share, as the line's
  // own is, so the parts always add up to the line.
  const perLine = (r, share) =>
    Object.fromEntries(
      LINES.map((name) => {
        const l = r.lines[name]
        const parts = l.parts.map((q) => {
          const custodial = q.custodial - l.share * (q.custodial - q.noncustodial)
          return { id: q.id, custodial, noncustodial: q.noncustodial, realised: (custodial - q.noncustodial) * share }
        })
        return [name, { custodial: l.custodial, noncustodial: l.noncustodial, realised: (l.custodial - l.noncustodial) * share, parts }]
      }),
    )
  const points = [{ year: 0, users: inputs.mau, rate: 0, custodial: today.totals.custodial, noncustodial: today.totals.noncustodial, path: today.totals.custodial, saving: today.totals.saving, share: 0, realised: 0, cumulative: 0, lines: perLine(today, 0) }]
  let users = inputs.mau
  let cumulative = 0
  for (let year = 1; year <= YEARS; year++) {
    if (year > 1) rate *= v.growth_decay
    users = Math.max(1, Math.round(users * (1 + rate)))
    const scaled = { ...inputs, mau: users, rev: (inputs.rev * users) / inputs.mau }
    const r = evaluate(scaled, v)
    const share = rampShare(year, v.scale_months)
    const realised = r.totals.saving * share
    cumulative += realised
    points.push({ year, users, rate, custodial: r.totals.custodial, noncustodial: r.totals.noncustodial, path: r.totals.custodial - realised, saving: r.totals.saving, share, realised, cumulative, lines: perLine(r, share) })
  }
  return points
}

/**
 * Where a line saves nothing but could: a payments line on store rails alone
 * is re-run with a peer-to-peer rail added, and what it costs today less
 * what it would cost on Nostr with that rail is what the rail would release.
 * Returned as { id, amount } or null; the page shows it in place of a zero.
 */
export function nudge(name, inputs, v, line) {
  if (name !== 'payments' || line.none || inputs.rails.includes('p2p')) return null
  if (line.custodial - line.noncustodial >= 1) return null
  const withP2p = evaluate({ ...inputs, rails: [...inputs.rails, 'p2p'] }, v).lines.payments
  const amount = line.custodial - withP2p.noncustodial
  return amount >= 1 ? { id: 'p2p', amount } : null
}

/**
 * The whole result: the typical scenario plus the low and high bounds, each
 * with its projection, the clean inputs the page should echo back, and the
 * overrides that applied. "At scale" is the marker year's column of the
 * projection: what the app pays under custody that year, what it pays on the
 * way to Nostr (the path, almost all the way down by then), and the saving
 * between the two. Every line and part carries its figures for that year,
 * and the lines add up to the total's own, so the chart, the savings list
 * and the facts all show one set of numbers. The five-year cumulative is
 * kept as the secondary figure.
 */
export function calculate(rawInputs, data, rawOverrides = {}) {
  const inputs = normalizeInputs(rawInputs)
  const overrides = cleanOverrides(data, rawOverrides)
  const out = { version: data.version, start_year: data.start_year, inputs, overrides }
  for (const s of SCENARIOS) {
    const resolved = resolveAssumptions(data, s, overrides)
    const { values: v, set } = applyKind(resolved, inputs.kind, overrides)
    const eff = deriveInputs(inputs, v)
    Object.assign(eff.derived, set)
    const r = evaluate(eff, v)
    r.effective = eff
    r.derived = eff.derived
    r.values = v
    r.projection = project(eff, v, r)
    const scale = r.projection[MARKER_YEAR]
    r.totals.five_year = r.projection[YEARS].cumulative
    r.totals.marker_year = scale.cumulative
    r.totals.at_scale = scale.realised
    r.totals.scale_custodial = scale.custodial
    r.totals.scale_nostr = scale.path
    r.totals.scale_users = scale.users
    r.totals.scale_per_mau_custodial = scale.custodial / scale.users
    r.totals.scale_per_mau_nostr = scale.path / scale.users
    for (const name of LINES) {
      const line = r.lines[name]
      line.five_year = r.projection.slice(1).reduce((acc, p) => acc + p.lines[name].realised, 0)
      // At scale: what the line costs under custody and on the way to Nostr in the marker year, at that year's users.
      const at = scale.lines[name]
      line.scale_custodial = at.custodial
      line.scale_noncustodial = at.custodial - at.realised
      line.at_scale = at.realised
      for (const part of line.parts) {
        const q = at.parts.find((x) => x.id === part.id)
        part.scale_custodial = q ? q.custodial : 0
        part.scale_noncustodial = q ? q.custodial - q.realised : 0
      }
      line.nudge = nudge(name, eff, v, line)
    }
    out[s] = r
  }
  return out
}

export { INPUTS, normalizeInputs }
