// "How this is calculated": the arithmetic behind one part of one line, with
// the visitor's numbers in it, and the assumptions it rests on. The words are
// templates in the page's copy (strings.how.formulas); the numbers come from
// the result, the inputs and the assumption values in use. Pure: no DOM.

import { t } from '../../shared/src/config.js'
import { compact, money, number, percent, perMau } from './format.js'
import { PART_ASSUMPTIONS, RETENTION_MONTHS, WEEKS_PER_YEAR, derivedAssumptions } from './model.js'

/** Fill {a.key}, {i.key}, {p.key} and {d.key} from a flat map; anything unknown stays visible. */
export function fill(template, vars) {
  return String(template).replace(/\{([a-z]\.[a-z_0-9]+)\}/g, (m, key) => (vars[key] == null ? m : String(vars[key])))
}

/** An assumption's value in the words of its unit. */
export function formatValue(v, unit = '') {
  if (/^ratio/.test(unit)) return percent(v)
  if (unit === 'multiplier') return `${number(v)}×`
  if (/^USD/.test(unit)) return v < 100 ? perMau(v) : money(v)
  if (unit === 'months') return `${number(v)} months`
  return number(v)
}

/** Which template a part uses: most have one, a few branch on what applied. */
function variant(line, part) {
  if (part.id === 'engineering') return `engineering_${line}`
  if (part.id === 'labour') return part.implied ? 'labour_implied' : `labour_${part.who}`
  if (part.id === 'privacy_programs') return part.reported ? 'privacy_programs_reported' : 'privacy_programs'
  if (part.id === 'money_transmitter') return part.holds ? 'money_transmitter_holds' : 'money_transmitter'
  return part.id
}

const MONEY = new Set(['custodial', 'noncustodial', 'revenue', 'loaded', 'gdpr', 'osa', 'dsa', 'usp', 'content_law'])
const PERCENT = new Set(['rate', 'share'])
const CENTS = new Set(['hourly', 'fixed'])

/** The part's own numbers, formatted by what they are. */
function partVars(part) {
  const out = {}
  for (const [k, v] of Object.entries(part)) {
    if (typeof v !== 'number') continue
    out[`p.${k}`] = MONEY.has(k) ? money(v) : PERCENT.has(k) ? percent(v) : CENTS.has(k) ? perMau(v) : number(v)
  }
  return out
}

/** Only the assumptions that applied: a jurisdiction's share, a store's tier, a default band. */
export function relevantKeys(line, part, inputs) {
  const keys = [...(PART_ASSUMPTIONS[`${line}.${part.id}`] || [])]
  // What an opener's default rests on, where this part used one.
  const derived = inputs.derived || {}
  if (part.id === 'engineering' || part.id === 'legal_labour') {
    const area = part.id === 'legal_labour' ? 'legal' : { accounts: 'accounts', graph: 'content', storage: 'infra' }[line]
    if (derived[`eng_${area}`]) keys.push(...derivedAssumptions(`eng_${area}`, derived[`eng_${area}`], inputs))
  }
  if (part.id === 'database' && derived.posts_per_user) keys.push(...derivedAssumptions('posts_per_user', derived.posts_per_user, inputs))
  if (part.id === 'blob' && derived.mb) keys.push(...derivedAssumptions('mb', derived.mb, inputs))
  if (part.id === 'labour' && derived.mod_heads) keys.push(...derivedAssumptions('mod_heads', derived.mod_heads, inputs))
  if (part.id === 'egress' && derived.egress_gb_per_mau_month) keys.push(...derivedAssumptions('egress_gb_per_mau_month', 'kind', inputs))
  if ((part.id === 'serving' || part.id === 'feed_compute') && derived.compute_per_mau_year) keys.push(...derivedAssumptions('compute_per_mau_year', 'kind', inputs))
  const jur = inputs.jur || []
  return keys.filter((key) => {
    const m = key.match(/^verify_share_(\w+)$/)
    if (m) return jur.includes(m[1])
    if (key === 'gdpr_program_year') return jur.includes('eu') || jur.includes('uk')
    if (key === 'uk_osa_year') return jur.includes('uk')
    if (key === 'dsa_year') return jur.includes('eu')
    if (key === 'us_privacy_year_small') return part.us_tier === 'small'
    if (key === 'us_privacy_year_large') return part.us_tier === 'large'
    if (key === 'ccpa_consumer_threshold') return jur.includes('us')
    if (/^default_hours_/.test(key)) return Boolean(part.defaulted)
    if (/^team_factor_/.test(key)) return Boolean(part.defaulted)
    if (/_rate_small$/.test(key)) return part.tier === 'small'
    if (/_rate_standard$/.test(key)) return part.tier === 'standard'
    if (key === 'ts_base_salary') return part.who === 'team'
    if (key === 'moderator_seat_outsourced') return part.who === 'vendor'
    if (key === 'moderator_base_salary' || key === 'mods_per_million_mau') return Boolean(part.implied)
    if (part.id === 'labour' && (key === 'loaded_multiplier' || key === 'overhead_multiplier')) return part.who !== 'vendor'
    if (key === 'mt_avoidance_year' || key === 'mt_remains_share') return Boolean(part.holds)
    return true
  })
}

/**
 * The explanation for one part: its words, the two arithmetic lines, and the
 * assumptions in use with their values, ranges and whether one was changed.
 */
export function explain(line, part, { inputs, values, overrides = {}, data }) {
  const v = values
  const vars = {
    ...partVars(part),
    'i.mau': number(inputs.mau),
    'i.mb': number(inputs.mb),
    'i.posts_per_user': number(inputs.posts_per_user),
    'i.rev': money(inputs.rev || 0),
    'i.legal_usd': money(inputs.legal_usd || 0),
    'd.weeks': number(WEEKS_PER_YEAR),
    'd.retention': number(RETENTION_MONTHS),
    'd.rev_year': money((inputs.rev || 0) * 12),
    'd.tier': part.tier ? t(`details.tier_${part.tier}`) : '',
    'd.programs': programsList(part),
  }
  for (const [key, a] of Object.entries(data.assumptions)) vars[`a.${key}`] = formatValue(v[key], a.unit)

  const which = variant(line, part)
  const f = t(`how.formulas.${which}`) || t(`how.formulas.${part.id}`) || {}
  const assumptions = relevantKeys(line, part, inputs).map((key) => {
    const a = data.assumptions[key]
    return {
      key,
      label: a.label,
      unit: a.unit,
      value: formatValue(v[key], a.unit),
      low: formatValue(a.low, a.unit),
      high: formatValue(a.high, a.unit),
      confidence: a.confidence,
      changed: key in overrides,
    }
  })
  return {
    label: t(`parts.${part.id}`, part.id),
    today: fill(f.today || '', vars),
    nostr: fill(f.nostr || '', vars),
    // What the savings list shows: the same part averaged over the five projected years.
    averaged: part.avg_custodial != null ? fill(t('how.averaged'), { 'p.custodial': money(part.avg_custodial), 'p.noncustodial': money(part.avg_noncustodial) }) : '',
    assumptions,
  }
}

/** The compliance programs that applied, named and priced, for the template. */
function programsList(part) {
  if (part.id !== 'privacy_programs') return ''
  const items = []
  if (part.gdpr) items.push(`${t('how.programs.gdpr')} ${money(part.gdpr)}`)
  if (part.osa) items.push(`${t('how.programs.osa')} ${money(part.osa)}`)
  if (part.dsa) items.push(`${t('how.programs.dsa')} ${money(part.dsa)}`)
  if (part.usp) items.push(`${t(`how.programs.us_${part.us_tier}`)} ${money(part.usp)}`)
  return items.join(' + ') || t('how.programs.none')
}

export { compact }
