// "How this is calculated": the arithmetic behind one part of one line, with
// the visitor's numbers in it, and the assumptions it rests on. The words are
// templates in the page's copy (strings.how.formulas); the numbers come from
// the result, the inputs and the assumption values in use. Pure: no DOM.

import { t } from '../../shared/src/config.js'
import { approx, compact, date, money, number, percent, perMau } from './format.js'
import { PART_ASSUMPTIONS, RETENTION_MONTHS, TEAMS, WEEKS_PER_YEAR, derivedAssumptions } from './model.js'

/** Fill {a.key}, {i.key}, {p.key} and {d.key} from a flat map; anything unknown stays visible. */
export function fill(template, vars) {
  return String(template).replace(/\{([a-z]\.[a-z_0-9]+)\}/g, (m, key) => (vars[key] == null ? m : String(vars[key])))
}

/** An assumption's value in the words of its unit. */
export function formatValue(v, unit = '') {
  if (unit === 'date') return date(v)
  if (/^ratio/.test(unit)) return percent(v)
  if (unit === 'multiplier') return `${number(v)}×`
  if (/^USD/.test(unit)) return v < 100 ? perMau(v) : money(v)
  if (unit === 'months') return `${number(v)} ${v === 1 ? t('how.units.month') : t('how.units.months')}`
  return number(v)
}

/** Which template a part uses: most have one, a few branch on what applied. */
function variant(line, part) {
  if (part.id === 'engineering') return `engineering_${line}`
  if (part.id === 'labour') return part.nobody ? 'labour_nobody' : part.implied ? 'labour_implied' : `labour_${part.who}`
  if (part.id === 'privacy_programs') return part.reported ? 'privacy_programs_reported' : 'privacy_programs'
  if (part.id === 'money_transmitter') return part.holds ? 'money_transmitter_holds' : 'money_transmitter'
  return part.id
}

const MONEY = new Set(['custodial', 'noncustodial', 'revenue', 'loaded', 'gdpr', 'osa', 'dsa', 'usp', 'content_law', 'loss', 'policy'])
const PERCENT = new Set(['rate', 'share', 'us_share', 'sponsored', 'factor', 'conversion'])
const CENTS = new Set(['hourly', 'fixed', 'contact'])

/** The part's own numbers, formatted by what they are. */
function partVars(part) {
  const out = {}
  for (const [k, v] of Object.entries(part)) {
    if (typeof v !== 'number') continue
    out[`p.${k}`] = MONEY.has(k) ? money(v) : PERCENT.has(k) ? percent(v) : CENTS.has(k) ? perMau(v) : number(v)
  }
  // The benchmark a line nobody moderates carries: what it would have billed.
  if (part.benchmark) {
    out['p.benchmark_people'] = number(part.benchmark.people)
    out['p.benchmark_loaded'] = money(part.benchmark.loaded)
    out['p.benchmark_cost'] = money(part.benchmark.cost)
  }
  return out
}

/** Only the assumptions that applied: a jurisdiction's share, a store's tier, a default band, the team's tier. */
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
  const team = TEAMS.includes(inputs.team) ? inputs.team : 'more'
  return keys.filter((key) => {
    const m = key.match(/^verify_share_(\w+)$/)
    if (m) return jur.includes(m[1])
    // A region's weight matters only when there is more than one region to weigh.
    const w = key.match(/^jur_weight_(\w+)$/)
    if (w) return jur.length > 1 && jur.includes(w[1])
    if (key === 'ca_share_of_us_users' || key === 'annual_users_per_mau') return jur.includes('us')
    if (key === 'retained_data_share' && part.id === 'dsar') return part.custodial > 0
    if (key === 'gdpr_program_year') return jur.includes('eu') || jur.includes('uk')
    if (key === 'uk_osa_year') return jur.includes('uk')
    if (key === 'dsa_year') return jur.includes('eu')
    // The team's own tier; the DSA token below the top tier reads the one-person factor too.
    const tier = key.match(/^compliance_tier_factor_(\w+)$/)
    if (tier) return !part.reported && (tier[1] === team || (tier[1] === 'one' && team !== 'more' && jur.includes('eu')))
    const loss = key.match(/^breach_loss_(\w+)$/)
    if (loss) return loss[1] === team
    if (key === 'us_privacy_year_small') return part.us_tier === 'small'
    if (key === 'us_privacy_year_large') return part.us_tier === 'large'
    if (key === 'ccpa_consumer_threshold') return jur.includes('us')
    if (/^default_hours_/.test(key)) return Boolean(part.defaulted)
    if (/^team_factor_/.test(key)) return Boolean(part.defaulted)
    if (/_rate_small$/.test(key)) return part.tier === 'small'
    if (/_rate_standard$/.test(key)) return part.tier === 'standard'
    if (key === 'ts_base_salary') return part.who === 'team'
    if (key === 'moderator_seat_outsourced') return part.who === 'vendor'
    // A line nobody moderates rests on the benchmark it names, and on nothing else.
    if (part.nobody) return key === 'moderator_base_salary' || key === 'mods_per_million_mau' || key === 'loaded_multiplier' || key === 'overhead_multiplier'
    if (key === 'moderator_base_salary' || key === 'mods_per_million_mau') return Boolean(part.implied)
    if (part.id === 'labour' && (key === 'loaded_multiplier' || key === 'overhead_multiplier')) return part.who !== 'vendor'
    if (key === 'mt_avoidance_year' || key === 'mt_remains_share') return Boolean(part.holds)
    if (key === 'p2p_conversion_share') return part.id !== 'money_transmitter' && part.id !== 'p2p'
    return true
  })
}

/** The assumptions behind a figure, with their values, ranges and whether one was changed. */
function describe(keys, { values, overrides = {}, data }) {
  return keys.map((key) => {
    const a = data.assumptions[key]
    return {
      key,
      label: a.label,
      unit: a.unit,
      value: formatValue(values[key], a.unit),
      low: formatValue(a.low, a.unit),
      high: formatValue(a.high, a.unit),
      confidence: a.confidence,
      changed: Object.hasOwn(overrides, key),
    }
  })
}

/**
 * The explanation for one part: its words, the two arithmetic lines, and the
 * assumptions in use with their values, ranges and whether one was changed.
 */
export function explain(line, part, { inputs, values, overrides = {}, data, estimated = {} }) {
  const v = values
  const vars = {
    ...partVars(part),
    'i.mau': number(inputs.mau),
    'i.mb': number(inputs.mb),
    'i.posts_per_user': number(inputs.posts_per_user),
    'i.p2p_volume': money(inputs.p2p_volume || 0),
    'i.legal_usd': money(inputs.legal_usd || 0),
    'd.weeks': number(WEEKS_PER_YEAR),
    'd.retention': number(RETENTION_MONTHS),
    'd.volume_year': money((inputs.p2p_volume || 0) * 12),
    'd.estimated_months': estimated.months != null ? number(estimated.months) : '',
    'd.estimated_users': estimated.users != null ? number(Math.round(estimated.users)) : '',
    'd.estimated_date': estimated.date ? date(estimated.date) : '',
    'd.breach_reduction': estimated.breach != null ? approx(estimated.breach) : '',
    'p.users': part.users != null ? number(Math.round(part.users)) : '',
    'd.tier': part.tier ? t(`details.tier_${part.tier}`) : '',
    'd.team': part.team ? t(`whose.team.${part.team}`) : '',
    'd.programs': programsList(part),
  }
  for (const [key, a] of Object.entries(data.assumptions)) vars[`a.${key}`] = formatValue(v[key], a.unit)
  // The CCPA test, where the app has US users: shown with the programs and the access requests.
  vars['d.ccpa'] = (inputs.jur || []).includes('us') && part.ca_consumers != null ? fill(t('how.ccpa'), vars) : ''

  const which = variant(line, part)
  const f = t(`how.formulas.${which}`) || t(`how.formulas.${part.id}`) || {}
  return {
    label: t(`parts.${part.id}`, part.id),
    today: fill(f.today || '', vars),
    nostr: fill(f.nostr || '', vars),
    // What the savings list shows: the same part at the instant the headline is read, at that instant's users.
    estimated: part.estimated_custodial != null ? fill(t(part.kind === 'risk' ? 'how.estimated_risk' : 'how.estimated'), { ...vars, 'p.custodial': money(part.estimated_custodial), 'p.noncustodial': money(part.estimated_noncustodial) }) : '',
    assumptions: describe(relevantKeys(line, part, inputs), { values, overrides, data }),
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
