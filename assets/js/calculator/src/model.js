// The cost model. Pure functions, no DOM, no network, no clock: inputs, the
// assumptions and the date of the calculation in, numbers out. Everything
// the page shows is computed here, so this file is the one to audit.
//
//   calculate(inputs, assumptions, overrides, { today }) → { typical, low, high, ... }
//
// Each scenario evaluates the same six lines. Only the assumptions marked
// `scenario_varies` in the file (Nostr4's thesis: what remains once the
// network is mature, the Nostr-native fees) take their low or high value;
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
// The saving splits two ways: cash, from the parts that are bills, and
// fees, from the payments line, the fee stack custody puts on payments
// between users. The expected breach loss is not a saving: it is an
// exposure, kept apart from the lines and the headline, and shown as a note.
//
// Time. The app's timeline is relative: today is the day of the calculation
// (`today`, an ISO date the caller passes; this file never reads the clock),
// and the chart's six points are today and today plus one to five years,
// each the annualized run-rate at that instant. The network's timeline is
// absolute: its progress toward supporting non-custodial apps runs from 0 at
// `network_mature_start` to 1 at `network_mature_end`, front-loaded, and
// only the cost-of-Nostr line reads the calendar. The headline is read at
// one instant, `integration_payback_months` plus `estimated_savings_months`
// after today. An app's own integration cost is never estimated here.
//
// Units: USD per year unless a name says otherwise.

import { INPUTS, normalizeInputs } from './inputs.js'

export const LINES = ['accounts', 'graph', 'storage', 'compliance', 'moderation', 'payments']
// Low is the smaller saving: the thesis holding less well, not the cheaper cloud bill.
export const SCENARIOS = ['low', 'typical', 'high']
export const JURISDICTIONS = ['eu', 'uk', 'us', 'other']
export const TEAMS = ['one', 'ten', 'fifty', 'more']

// Model constants, not assumptions: conventions rather than estimates.
export const HOURS_PER_YEAR = 2000 // 50 weeks of 40 hours
export const WEEKS_PER_YEAR = 50
export const RETENTION_MONTHS = 12 // how long post metadata is kept in the database term
export const YEARS = 5 // the chart: today, then today plus one to five years
const DAYS_PER_MONTH = 30.4375

// ── dates ───────────────────────────────────────────────────────────────────
//
// ISO dates as strings, YYYY-MM-DD, and nothing else: no Date objects leave
// this section, and nothing in it reads the clock.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** { y, m, d } for a well-formed, real calendar date; null otherwise. */
export function parseDate(iso) {
  const m = ISO_DATE.exec(String(iso ?? ''))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null
  return { y, m: mo, d }
}

export const isDate = (iso) => parseDate(iso) != null

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const pad = (n) => String(n).padStart(2, '0')
export const formatDate = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`

/** Months from one date to another, fractional by days. */
export function monthsBetween(from, to) {
  const a = parseDate(from)
  const b = parseDate(to)
  if (!a || !b) return NaN
  return (b.y - a.y) * 12 + (b.m - a.m) + (b.d - a.d) / DAYS_PER_MONTH
}

/** A date some months on: whole months by the calendar, the fraction as days, the day clamped to the month. */
export function addMonths(iso, months) {
  const a = parseDate(iso)
  if (!a || !Number.isFinite(months)) return null
  const whole = Math.floor(months)
  const days = Math.round((months - whole) * DAYS_PER_MONTH)
  const index = a.m - 1 + whole
  const y = a.y + Math.floor(index / 12)
  const m = ((index % 12) + 12) % 12 + 1
  const base = new Date(Date.UTC(y, m - 1, Math.min(a.d, daysInMonth(y, m))))
  base.setUTCDate(base.getUTCDate() + days)
  return formatDate({ y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() })
}

// ── assumptions ─────────────────────────────────────────────────────────────

/** A row's kind, which decides how an override is read and clamped. */
export function rowType(a) {
  if (a.unit === 'date') return 'date'
  if (/^ratio/.test(a.unit || '')) return 'share'
  return 'number'
}

/**
 * One flat {key: value} for a scenario, with the user's overrides applied.
 * An assumption without `scenario_varies` is the same in every scenario.
 * Overrides arrive already cleaned (cleanOverrides); a date row's value is
 * its ISO string, every other row's a number.
 */
export function resolveAssumptions(data, scenario, overrides = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario: ${scenario}`)
  const out = {}
  for (const [key, a] of Object.entries(data.assumptions)) {
    const o = Object.hasOwn(overrides, key) ? overrides[key] : null
    const base = a[a.scenario_varies ? scenario : 'typical']
    if (rowType(a) === 'date') out[key] = isDate(o) ? o : base
    else out[key] = o != null && Number.isFinite(Number(o)) ? Number(o) : base
  }
  return out
}

/** The assumptions whose low and high values move the band: Nostr4's thesis. */
export function varyingKeys(data) {
  return Object.keys(data.assumptions).filter((key) => data.assumptions[key].scenario_varies)
}

/** Keep only overrides that name a real assumption with a usable value: a real date for a date row, a finite non-negative number otherwise. */
export function cleanOverrides(data, overrides = {}) {
  const out = {}
  for (const [key, v] of Object.entries(overrides)) {
    if (!Object.hasOwn(data.assumptions, key)) continue
    const a = data.assumptions[key]
    if (rowType(a) === 'date') {
      if (!isDate(v) || v === a.typical) continue
      out[key] = String(v)
      continue
    }
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) continue
    if (n === a.typical) continue
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

/** The compliance programmes' share for a team size: the rows are the top tier's figures, scaled down by firm size. */
export function complianceFactor(team, v) {
  if (team === 'one') return v.compliance_tier_factor_one
  if (team === 'ten') return v.compliance_tier_factor_ten
  if (team === 'fifty') return v.compliance_tier_factor_fifty
  return v.compliance_tier_factor_more
}

/** The median loss from a breach for a team size: a firm's figure, not a per-user one. */
export function breachLoss(team, v) {
  if (team === 'one') return v.breach_loss_one
  if (team === 'ten') return v.breach_loss_ten
  if (team === 'fifty') return v.breach_loss_fifty
  return v.breach_loss_more
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
  if (egress != null && !Object.hasOwn(overrides, 'egress_gb_per_mau_month')) {
    out.egress_gb_per_mau_month = egress
    set.egress_gb_per_mau_month = 'kind'
  }
  const compute = kindCompute(kind, v)
  if (compute != null && !Object.hasOwn(overrides, 'compute_per_mau_year')) {
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

/** The app's California consumers a year: monthly actives times the annual multiple, the US share of them, the Californian share of those. */
export function caConsumers(inputs, v, shares = jurShares(inputs, v)) {
  return inputs.mau * v.annual_users_per_mau * shares.us * v.ca_share_of_us_users
}

/** Whether the app's California consumers reach the CCPA's threshold, which counts consumers a year, not monthly actives. */
export function ccpaApplies(inputs, v, shares = jurShares(inputs, v)) {
  return inputs.jur.includes('us') && caConsumers(inputs, v, shares) >= v.ccpa_consumer_threshold
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
  // Keys cannot be reset, so the reset line goes to nothing. The account-access
  // events behind it stay, at the same rate, and become a hand-off to the
  // user's own or a recommended key-management service: a self-service contact
  // each, and a live one for the share that reaches a person.
  const handoff = v.support_self_service_contact + v.key_handoff_live_share * v.support_live_contact
  const parts = [
    part('auth', mau * v.auth_per_mau_month * 12, 0),
    part('resets', mau * v.reset_rate_per_mau_year * v.reset_cost, 0),
    // Age assurance becomes a layer the app reads (store, wallet) rather than buys; a share remains.
    part('verify', verify, verify * v.verify_remains_share, { rate: verifyShare }),
    // Signer login, the recovery hand-off and sessions still need building and keeping.
    part('engineering', eng.cost, eng.cost * v.accounts_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly, from: eng.from }),
    part('key_handoff', 0, mau * v.reset_rate_per_mau_year * handoff, { rate: v.reset_rate_per_mau_year, contact: handoff }),
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
    part('engineering', eng.cost, eng.cost * v.graph_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly, from: eng.from }),
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
  const sponsored = mau * v.relay_sponsored_share * v.relay_per_mau_year
  const parts = [
    part('blob', blob, blob * v.media_sponsor_share, { gb: blobGb }),
    part('egress', egress, egress * v.media_sponsor_share, { gb: egressGb }),
    part('serving', mau * v.compute_per_mau_year * (1 - v.feed_compute_share), mau * v.cache_per_mau_year, { share: 1 - v.feed_compute_share }),
    // Relay connections, caching and media handling still need engineering time.
    part('engineering', eng.cost, eng.cost * v.infra_eng_remains_share, { defaulted: eng.defaulted, hours: eng.hours, hourly: eng.hourly, from: eng.from }),
    // Relay capacity for the users who don't bring their own, rented from a
    // provider who carries the hosting duties; never below one managed relay.
    part('relay', 0, Math.max(v.relay_floor_year, sponsored), { sponsored: v.relay_sponsored_share, minimum: sponsored < v.relay_floor_year }),
  ]
  return { parts }
}

function compliance(inputs, v) {
  const { mau } = inputs
  const eu = has(inputs, 'eu')
  const uk = has(inputs, 'uk')
  const us = has(inputs, 'us')
  // The programme rows are the top tier's figures; a smaller team carries its
  // tier's share. The DSA is a token amount below the top tier: micro and
  // small enterprises are exempt from the online-platform duties (Art. 19)
  // and from transparency reporting (Art. 15), and keep a point of contact.
  const factor = complianceFactor(inputs.team, v)
  const gdpr = eu || uk ? v.gdpr_program_year * factor : 0
  const osa = uk ? v.uk_osa_year * factor : 0
  const dsa = eu ? v.dsa_year * (inputs.team === 'more' ? factor : v.compliance_tier_factor_one) : 0
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
  // An expected loss, not a bill, sized by the firm: the chance of a breach
  // in a year times the median loss for a firm this size. On Nostr the same
  // chance falls on the little personal data still held. Kept apart from
  // the cash parts: it is an exposure the page notes, never a saving it claims.
  const loss = breachLoss(inputs.team, v)
  const breach = v.breach_prob_year * loss
  const breachRemains = breach * v.retained_data_share
  const parts = [
    part('privacy_programs', programs, programsRemain, { us_tier: usTier, reported: reported != null && reported > 0, gdpr, osa, dsa, usp, content_law: contentLaw, us_share: shares.us, ca_consumers: caConsumers(inputs, v, shares), factor, team: inputs.team }),
    part('legal_labour', legal.cost, legal.cost * v.privacy_remains_share, { defaulted: legal.defaulted, hours: legal.hours, hourly: legal.hourly, from: legal.from }),
    part('dsar', dsar, dsar * v.retained_data_share, { users: dsarUsers }),
    part('insurance', v.cyber_insurance_year, v.cyber_insurance_year * v.insurance_remains_share),
    part('breach', breach, breachRemains, { kind: 'risk', loss, team: inputs.team, policy: v.cyber_insurance_year }),
  ]
  return { parts }
}

function moderation(inputs, v) {
  const { mau } = inputs
  // Three states. Unanswered (null) bills the benchmark: so many reviewers per
  // million users, as the DSA transparency reports put it. A team or a vendor
  // is priced by head. An explicit "nobody" bills nothing on either side: no
  // saving is claimed where nothing is spent, and the benchmark travels with
  // the part so the page can say what the line would have been.
  const who = inputs.mod_who === 'team' || inputs.mod_who === 'vendor' || inputs.mod_who === 'nobody' ? inputs.mod_who : 'benchmark'
  const benchmark = { people: (mau / 1e6) * v.mods_per_million_mau, loaded: loadedYear(v.moderator_base_salary, v) }
  benchmark.cost = benchmark.people * benchmark.loaded
  const nobody = who === 'nobody'
  const implied = who === 'benchmark'
  let labour
  let people
  let loaded
  if (who === 'team') {
    people = num(inputs.mod_heads) ?? 0
    loaded = loadedYear(v.ts_base_salary, v)
    labour = people * loaded
  } else if (who === 'vendor') {
    people = num(inputs.mod_heads) ?? 0
    loaded = v.moderator_seat_outsourced
    labour = people * loaded
  } else if (nobody) {
    people = 0
    loaded = 0
    labour = 0
  } else {
    people = benchmark.people
    loaded = benchmark.loaded
    labour = benchmark.cost
  }
  const appeals = labour * v.appeals_share
  const tooling = nobody ? 0 : mau * v.ts_tooling_per_mau_year
  const labels = nobody ? 0 : mau * v.label_provider_per_mau_year
  // Review and ranking move to the network; what remains is for anything the
  // app itself hosts, plus a label or web-of-trust provider as the Nostr-native cost.
  const parts = [
    part('labour', labour, labour * v.moderation_remains_share, { implied, nobody, who, people, loaded, heads_from: inputs.derived?.mod_heads, ...(nobody ? { benchmark } : {}) }),
    part('appeals', appeals, appeals * v.moderation_remains_share),
    part('tooling', tooling, tooling * v.tooling_remains_share),
    part('labels', 0, labels),
  ]
  return { parts, implied, nobody }
}

// The payments line is the fee stack custody puts on payments between users:
// `rev` is the gross monthly volume of tips, creator payments and sales
// between users (the app's own sales are not a custody cost and are not
// counted, on any rail), split evenly across the rails given, each at its
// sourced rate, a store's tier by the proceeds through that store. Once the
// network is mature the converted share (p2p_conversion_share) settles on
// the user's own rail: on a store rail it still carries the commission the
// precedent leaves (p2p_store_fee_remains_share) plus the rail's own rate;
// on a processor or reseller rail only the rail's rate. The unconverted
// share stays where it is at the full rate. Every part is `kind: 'fees'`,
// so the page keeps the line apart from operating cost.
function payments(inputs, v) {
  const rails = inputs.rails
  if (!rails.length || !(inputs.rev > 0)) return { parts: [], none: true }
  // (rails_from marks rails the openers derived from distribution)
  const annual = inputs.rev * 12
  const share = 1 / rails.length
  const proceeds = annual * share
  const small = proceeds < v.store_small_threshold
  const conv = Math.min(1, Math.max(0, v.p2p_conversion_share))
  const fee = (id, custodial, noncustodial, extra = {}) => part(id, custodial, noncustodial, { kind: 'fees', conversion: conv, ...extra })
  const parts = []
  for (const rail of rails) {
    const rev = proceeds
    if (rail === 'apple' || rail === 'google') {
      const rate = rail === 'apple' ? (small ? v.apple_rate_small : v.apple_rate_standard) : small ? v.google_rate_small : v.google_rate_standard
      const custodial = rev * rate
      const converted = rev * conv * (rate * v.p2p_store_fee_remains_share + v.lightning_rate)
      parts.push(fee(`store_${rail}`, custodial, converted + rev * (1 - conv) * rate, { rate, tier: small ? 'small' : 'standard', revenue: rev }))
    } else if (rail === 'processor') {
      const cost = rev * v.processor_rate + (rev / v.avg_ticket) * v.processor_fixed
      parts.push(fee('processor', cost, rev * conv * v.lightning_rate + (1 - conv) * cost, { rate: v.processor_rate, fixed: v.processor_fixed, revenue: rev, tickets: rev / v.avg_ticket }))
    } else if (rail === 'reseller') {
      const cost = rev * v.reseller_rate + (rev / v.avg_ticket) * v.reseller_fixed
      parts.push(fee('reseller', cost, rev * conv * v.lightning_rate + (1 - conv) * cost, { rate: v.reseller_rate, fixed: v.reseller_fixed, revenue: rev, tickets: rev / v.avg_ticket }))
    } else {
      const cost = rev * v.lightning_rate
      parts.push(fee('p2p', cost, cost, { rate: v.lightning_rate, revenue: rev }))
    }
  }
  const holds = inputs.balances.includes('yes')
  parts.push(fee('money_transmitter', holds ? v.mt_avoidance_year : 0, holds ? v.mt_avoidance_year * v.mt_remains_share : 0, { holds }))
  return { parts, tier: small ? 'small' : 'standard', rails_from: inputs.derived?.rails }
}

const LINE_FN = { accounts, graph, storage, compliance, moderation, payments }
export const LINE_FUNCTIONS = LINE_FN

// Which assumptions each part reads, by line and part. The page's "How this
// is calculated" dialog lists them and lights them up in the assumptions
// table; a test runs every line with a recording proxy and fails if this map
// and the code disagree. Conditional keys (a jurisdiction's share, a store's
// tier, a default hours band, a team tier) are listed in full and narrowed on the page.
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
const TIERS = TEAMS.map((t) => `compliance_tier_factor_${t}`)
const LOSSES = TEAMS.map((t) => `breach_loss_${t}`)
export const PART_ASSUMPTIONS = {
  'accounts.auth': ['auth_per_mau_month'],
  'accounts.resets': ['reset_rate_per_mau_year', 'reset_cost'],
  'accounts.verify': ['verify_share_uk', 'verify_share_us', 'verify_share_eu', 'verify_share_other', 'verify_price', 'verify_remains_share', ...WEIGHTS],
  'accounts.engineering': [...PEOPLE, 'default_hours_accounts', 'accounts_eng_remains_share'],
  'accounts.key_handoff': ['reset_rate_per_mau_year', 'support_self_service_contact', 'support_live_contact', 'key_handoff_live_share'],
  'graph.database': ['db_mb_per_mau', 'db_kb_per_post', 'db_gb_month'],
  'graph.feed_compute': ['compute_per_mau_year', 'feed_compute_share'],
  'graph.engineering': [...PEOPLE, 'default_hours_content', 'graph_eng_remains_share'],
  'graph.ranking': ['ranking_fee_per_mau_year'],
  'storage.blob': ['blob_gb_month', 'media_sponsor_share'],
  'storage.egress': ['egress_gb_per_mau_month', 'egress_gb', 'media_sponsor_share'],
  'storage.serving': ['compute_per_mau_year', 'feed_compute_share', 'cache_per_mau_year'],
  'storage.engineering': [...PEOPLE, 'default_hours_infra', 'infra_eng_remains_share'],
  'storage.relay': ['relay_per_mau_year', 'relay_sponsored_share', 'relay_floor_year'],
  'compliance.privacy_programs': ['gdpr_program_year', 'uk_osa_year', 'dsa_year', ...TIERS, 'us_privacy_year_small', 'us_privacy_year_large', 'ccpa_consumer_threshold', 'annual_users_per_mau', 'ca_share_of_us_users', ...WEIGHTS, 'content_law_remains_share', 'privacy_remains_share'],
  'compliance.legal_labour': [...PEOPLE, 'default_hours_legal', 'privacy_remains_share'],
  'compliance.dsar': ['dsar_rate_per_mau_year', 'dsar_cost', 'retained_data_share', 'ccpa_consumer_threshold', 'annual_users_per_mau', 'ca_share_of_us_users', ...WEIGHTS],
  'compliance.insurance': ['cyber_insurance_year', 'insurance_remains_share'],
  'compliance.breach': ['breach_prob_year', ...LOSSES, 'retained_data_share', 'cyber_insurance_year'],
  'moderation.labour': ['ts_base_salary', 'moderator_base_salary', 'moderator_seat_outsourced', 'mods_per_million_mau', 'loaded_multiplier', 'overhead_multiplier', 'moderation_remains_share'],
  'moderation.appeals': ['appeals_share', 'moderation_remains_share'],
  'moderation.tooling': ['ts_tooling_per_mau_year', 'tooling_remains_share'],
  'moderation.labels': ['label_provider_per_mau_year'],
  'payments.store_apple': ['apple_rate_standard', 'apple_rate_small', 'store_small_threshold', 'p2p_store_fee_remains_share', 'p2p_conversion_share', 'lightning_rate'],
  'payments.store_google': ['google_rate_standard', 'google_rate_small', 'store_small_threshold', 'p2p_store_fee_remains_share', 'p2p_conversion_share', 'lightning_rate'],
  'payments.processor': ['processor_rate', 'processor_fixed', 'avg_ticket', 'p2p_conversion_share', 'lightning_rate'],
  'payments.reseller': ['reseller_rate', 'reseller_fixed', 'avg_ticket', 'p2p_conversion_share', 'lightning_rate'],
  'payments.p2p': ['lightning_rate', 'p2p_conversion_share'],
  'payments.money_transmitter': ['mt_avoidance_year', 'mt_remains_share', 'p2p_conversion_share'],
}

/** Evaluate every line for one set of assumption values: the annualized run-rate at one instant. */
export function evaluate(inputs, v) {
  const shares = nostrShares(inputs)
  const lines = {}
  let custodial = 0
  let noncustodial = 0
  let fees = 0
  const breach = { custodial: 0, noncustodial: 0 }
  for (const name of LINES) {
    const r = LINE_FN[name](inputs, v)
    const share = Math.min(1, Math.max(0, shares[name]))
    // The line is its bills and fees; an expected loss (the breach) rides
    // beside it, moved by the same share, and is kept apart from every total.
    const cash = r.parts.filter((p) => p.kind !== 'risk')
    const nc = sum(cash, 'noncustodial')
    const full = sum(cash, 'custodial')
    const c = full - share * (full - nc)
    const kindSaving = (kind) => {
      const parts = r.parts.filter((p) => p.kind === kind)
      const kindFull = sum(parts, 'custodial')
      const kindNc = sum(parts, 'noncustodial')
      return kindFull - share * (kindFull - kindNc) - kindNc
    }
    const feesSaving = kindSaving('fees')
    for (const p of r.parts.filter((q) => q.kind === 'risk')) {
      breach.custodial += p.custodial - share * (p.custodial - p.noncustodial)
      breach.noncustodial += p.noncustodial
    }
    lines[name] = { ...r, custodial: c, noncustodial: nc, full, share, already: share >= 0.999, partly: share > 0 && share < 0.999, saving: c - nc, saving_cash: c - nc - feesSaving, saving_fees: feesSaving }
    custodial += c
    noncustodial += nc
    fees += feesSaving
  }
  const { mau } = inputs
  return {
    lines,
    shares,
    totals: {
      custodial,
      noncustodial,
      saving: custodial - noncustodial,
      saving_cash: custodial - noncustodial - fees,
      saving_fees: fees,
      breach_custodial: breach.custodial,
      breach_noncustodial: breach.noncustodial,
      breach_saving: breach.custodial - breach.noncustodial,
      per_mau_custodial: custodial / mau,
      per_mau_noncustodial: noncustodial / mau,
    },
  }
}

// ── the timeline ────────────────────────────────────────────────────────────
//
// The network's progress toward supporting non-custodial apps, 0 at
// network_mature_start and 1 at network_mature_end, front-loaded,
// 1 − (1 − t/T)², because the standards adopted first (keys, signed events,
// relays, follows) carry the bulk of custodial cost and deliver early, while
// the pieces still maturing (user-paid providers, a media market, label and
// ranking providers, payment conversion) are the tail. Every point samples
// this curve at its own date; after network_mature_end the share is 1.

/** The share of the full saving the network delivers on a date. */
export function networkShare(date, v) {
  const T = monthsBetween(v.network_mature_start, v.network_mature_end)
  if (!(T > 0)) return 1
  const t = monthsBetween(v.network_mature_start, date)
  const u = Math.min(1, Math.max(0, t / T))
  return 1 - (1 - u) ** 2
}

/**
 * Users some months from today: whole years compound at the growth given,
 * or the default (flat), each year's rate a fraction of the previous
 * (growth_decay), and a point between two years is set between them in
 * proportion, so a marker between the dots sits on the line.
 */
export function usersAt(months, inputs, v) {
  const given = num(inputs.growth)
  let rate = given != null ? given : v.growth_default
  const years = [inputs.mau]
  const last = Math.ceil(months / 12)
  for (let year = 1; year <= last; year++) {
    if (year > 1) rate *= v.growth_decay
    years.push(Math.max(1, Math.round(years[year - 1] * (1 + rate))))
  }
  const whole = Math.floor(months / 12)
  const frac = months / 12 - whole
  if (frac === 0) return years[whole]
  return years[whole] * (years[whole + 1] / years[whole]) ** frac
}

/** Each line and part at one instant, with its gap (the saving the network delivers there), so the parts always add up to the line. */
function perLine(r, share) {
  return Object.fromEntries(
    LINES.map((name) => {
      const l = r.lines[name]
      const parts = l.parts.map((q) => {
        const custodial = q.custodial - l.share * (q.custodial - q.noncustodial)
        return { id: q.id, kind: q.kind, custodial, noncustodial: q.noncustodial, gap: (custodial - q.noncustodial) * share }
      })
      return [name, { custodial: l.custodial, noncustodial: l.noncustodial, gap: (l.custodial - l.noncustodial) * share, parts }]
    }),
  )
}

/**
 * The app at one instant, `months` after today: the annualized run-rate of
 * custody as it runs today, carried forward to that instant's users (with
 * payment volume held per user; hours, head counts and reported legal spend
 * stay as given, which errs conservative), and the cost of the same app if
 * it were Nostr-integrated at that instant: custody less the saving the
 * network delivers on that date. The gap between the two is `realised`.
 */
export function pointAt(months, inputs, v, today, base = null, date = addMonths(today, months)) {
  const users = usersAt(months, inputs, v)
  const r = months === 0 && base ? base : evaluate(months === 0 ? inputs : { ...inputs, mau: users, rev: (inputs.rev * users) / inputs.mau }, v)
  const share = networkShare(date, v)
  const T = r.totals
  return {
    months,
    year: months / 12,
    date,
    users,
    share,
    custodial: T.custodial,
    noncustodial: T.noncustodial,
    nostr: T.custodial - T.saving * share,
    saving: T.saving,
    saving_cash: T.saving_cash,
    saving_fees: T.saving_fees,
    realised: T.saving * share,
    breach: { custodial: T.breach_custodial, noncustodial: T.breach_noncustodial, reduction: T.breach_saving * share },
    lines: perLine(r, share),
  }
}

/** The six points of the chart: today, then today plus one to five years. */
export function project(inputs, v, today, base = evaluate(inputs, v)) {
  const points = []
  for (let year = 0; year <= YEARS; year++) points.push(pointAt(year * 12, inputs, v, today, base))
  return points
}

/**
 * The whole result: the typical scenario plus the low and high bounds, each
 * with its six points, its three markers and its headline; the clean inputs
 * the page should echo back; the overrides that applied; and the date it
 * was all calculated as of. The headline, `totals.estimated`, is the gap
 * between the two lines at the estimated-savings instant, cash and fees
 * only; every line and part carries its figures for that instant, and the
 * lines add up to the headline. The breach reduction at the same instant
 * sits beside it, never in it.
 */
export function calculate(rawInputs, data, rawOverrides = {}, { today } = {}) {
  if (!isDate(today)) throw new Error('calculate: today must be an ISO date (YYYY-MM-DD)')
  const inputs = normalizeInputs(rawInputs)
  const overrides = cleanOverrides(data, rawOverrides)
  const out = { version: data.version, today, inputs, overrides }
  for (const s of SCENARIOS) {
    const resolved = resolveAssumptions(data, s, overrides)
    const { values: v, set } = applyKind(resolved, inputs.kind, overrides)
    const eff = deriveInputs(inputs, v)
    Object.assign(eff.derived, set)
    const r = evaluate(eff, v)
    r.effective = eff
    r.derived = eff.derived
    r.values = v
    r.projection = project(eff, v, today, r)
    const payback = Math.max(0, v.integration_payback_months)
    const estimatedAt = payback + Math.max(0, v.estimated_savings_months)
    const matureIn = monthsBetween(today, v.network_mature_end)
    r.markers = {
      // The integration wedge ends here: nothing in it is summed or estimated.
      payback: { months: payback, point: pointAt(payback, eff, v, today, r) },
      // The headline instant.
      estimated: { months: estimatedAt, point: pointAt(estimatedAt, eff, v, today, r) },
      // The network's date, on the app's timeline: before today it is "since".
      mature: { date: v.network_mature_end, months: matureIn, since: !(matureIn > 0), point: matureIn > 0 ? pointAt(matureIn, eff, v, today, r, v.network_mature_end) : null },
    }
    const E = r.markers.estimated.point
    r.totals.estimated = E.realised
    r.totals.estimated_cash = E.saving_cash * E.share
    r.totals.estimated_fees = E.saving_fees * E.share
    r.totals.estimated_custodial = E.custodial
    r.totals.estimated_nostr = E.nostr
    r.totals.estimated_users = E.users
    r.totals.estimated_months = E.months
    r.totals.estimated_after_payback = estimatedAt - payback
    r.totals.estimated_date = E.date
    r.totals.breach_reduction = E.breach.reduction
    r.totals.today_nostr = r.projection[0].nostr
    for (const name of LINES) {
      const line = r.lines[name]
      const at = E.lines[name]
      line.estimated = at.gap
      line.estimated_custodial = at.custodial
      line.estimated_noncustodial = at.custodial - at.gap
      for (const p of line.parts) {
        const q = at.parts.find((x) => x.id === p.id)
        p.estimated_custodial = q ? q.custodial : 0
        p.estimated_noncustodial = q ? q.custodial - q.gap : 0
      }
    }
    out[s] = r
  }
  return out
}

export { INPUTS, normalizeInputs }
