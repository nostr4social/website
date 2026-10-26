// The view. Every panel and every word is already in the page, rendered by
// Jekyll from _data/pages/calculator.yml; this module fills the slots that
// are only known once there are numbers: the figures, the six rows, the bars,
// the parts, the link, the status.

import { $, $$, clear, el, show } from '../../shared/src/dom.js'
import { fmt, t } from '../../shared/src/config.js'
import { compact, money, number, percent, perMau } from './format.js'
import { LINES, MARKER_YEAR, YEARS, calendarYear } from './model.js'
import { drawCharts, yearLabel } from './chart.js'
import { explain } from './explain.js'

// The two bounds in reading order, whichever scenario gave which: low is the
// smaller saving, so on the Nostr side it is the larger cost.
const ordered = (a, b) => (a <= b ? [a, b] : [b, a])
const range = (a, b) => {
  const [low, high] = ordered(a, b)
  return fmt(t('range_short'), { low: compact(low), high: compact(high) })
}
const rangeFull = (a, b, f = compact) => {
  const [low, high] = ordered(a, b)
  return Math.abs(high - low) < 1e-9 ? '' : fmt(t('range'), { low: f(low), high: f(high) })
}

export function renderResults(result, { own = false } = {}) {
  const { typical, low, high, inputs } = result
  const T = typical.totals
  const year = calendarYear(result.start_year, MARKER_YEAR)

  // Whose estimate this is, and the app it describes, one piece per section.
  renderWhose(result, own)
  const link = $('#r-whose-link')
  if (link) link.textContent = t('whose.link')

  // The headline: the cash saving a year at scale as a range with typical
  // inside it, for the marker year at that year's users; the fees and the
  // risk savings apart on smaller lines.
  const [headLow, headHigh] = ordered(low.totals.at_scale_cash, high.totals.at_scale_cash)
  text('#r-head-figure', fmt(t('headline'), { low: compact(headLow), high: compact(headHigh), typical: compact(T.at_scale_cash) }))
  text('#r-head-sub', fmt(t('headline_sub'), { year, users: number(T.scale_users) }))
  text('#r-head-fees', fmt(t('headline_fees'), { amount: compact(T.at_scale_fees) }))
  show($('#r-head-fees'), T.at_scale_fees >= 1)
  text('#r-head-risk', fmt(t('headline_risk'), { risk: compact(T.at_scale_risk) }))
  show($('#r-head-risk'), T.at_scale_risk >= 1)

  // The three facts under the chart, all for the year Nostr is at scale,
  // each label naming it: the custodial cost per user that year (that side
  // does not vary, so it has no range), the Nostr cost per user that year,
  // and the Nostr cost that year, the lower gold dot, each with its range.
  for (const id of ['r-permau-c-label', 'r-permau-nc-label', 'r-scale-nostr-label']) {
    const node = $(`#${id}`)
    if (node?.dataset.template) node.textContent = fmt(node.dataset.template, { year })
  }
  text('#r-permau-c', perMau(T.scale_per_mau_custodial))
  text('#r-permau-c-range', rangeFull(low.totals.scale_per_mau_custodial, high.totals.scale_per_mau_custodial, perMau))
  text('#r-permau-nc', perMau(T.scale_per_mau_nostr))
  text('#r-permau-nc-range', rangeFull(low.totals.scale_per_mau_nostr, high.totals.scale_per_mau_nostr, perMau))
  text('#r-scale-nostr', compact(T.scale_nostr))
  text('#r-scale-nostr-range', rangeFull(low.totals.scale_nostr, high.totals.scale_nostr))
  // The five years of saving added up sit on the year-by-year summary, where their table is.
  text('#r-cumulative', fmt(t('cumulative_note'), { amount: compact(T.five_year) }))
  text('#r-version', fmt(t('version'), { version: result.version }))

  // The chart's caption names the marker year.
  const caption = $('#caption-chart-custodial-cost-vs-nostr')
  if (caption?.dataset.template) caption.textContent = fmt(caption.dataset.template, { year })
  drawCharts({ typical: typical.projection, low: low.projection, start_year: result.start_year, marker: compact(T.at_scale_cash) })
  renderYears(typical.projection, result.start_year)

  // Where the saving comes from: each line's saving a year at scale, and the
  // bar as the share of that line's own cost that goes away. The six add up
  // to the figure in the chart.
  const cut = (c, nc) => (c > 0 ? Math.min(1, Math.max(0, 1 - nc / c)) : 0)

  for (const name of LINES) {
    const line = typical.lines[name]
    const row = $(`.lt-row[data-line="${name}"]`)
    if (!row) continue
    row.classList.toggle('is-already', Boolean(line.already))
    row.classList.toggle('is-none', Boolean(line.none))
    show($('.lt-flag--already', row), Boolean(line.already))
    show($('.lt-flag--partly', row), Boolean(line.partly))
    show($('.lt-flag--none', row), Boolean(line.none))

    // A line nobody moderates shows zero to zero and says what the benchmark would have been; no saving is claimed.
    const nobody = Boolean(line.nobody)
    row.classList.toggle('is-nobody', nobody)
    const nobodyNote = $('.lt-flag--nobody', row)
    if (nobodyNote) {
      const benchmark = line.parts.find((p) => p.id === 'labour')?.benchmark
      nobodyNote.textContent = nobody && benchmark ? fmt(t('moderation_nobody'), { people: number(benchmark.people), cost: compact(benchmark.cost) }) : ''
      show(nobodyNote, nobody && Boolean(benchmark))
    }

    const saving = $('.lt-saving', row)
    const rangeNode = $('.lt-saving-range', row)
    saving.textContent = line.none ? '' : money(line.at_scale)
    rangeNode.textContent = line.none ? '' : range(low.lines[name].at_scale, high.lines[name].at_scale)
    show(saving, !line.none)
    const share = line.none ? 0 : cut(line.custodial, line.noncustodial)
    $('.share', row).style.setProperty('--w', `${100 * share}%`)
    text(`.lt-row[data-line="${name}"] .share__pct`, line.none ? '' : percent(share))

    renderParts(name, line, inputs)
  }
}

/**
 * "Your estimate for a media feed that has 50,000 active users, a team of up
 * to 10, …": each piece from an opener, bright where the visitor answered it
 * and quiet where the openers' defaults stand in.
 */
function renderWhose(result, own) {
  const host = $('#r-whose-text')
  if (!host) return
  const { inputs, typical } = result
  const eff = typical.effective
  const piece = (text, answered) => el('span', { class: answered ? 'whose__fact' : 'whose__fact whose__fact--assumed', text })
  const regions = (inputs.jur || []).map((j) => t(`whose.reach.${j}`, j))
  const pieces = {
    lead: document.createTextNode(t(own ? 'whose.yours' : 'whose.illustrative')),
    kind: piece(t(`whose.kind.${inputs.kind || 'none'}`), inputs.kind != null),
    mau: piece(number(inputs.mau), true),
    team: piece(t(`whose.team.${eff.team}`), inputs.team != null),
    moderation: piece(t(`whose.moderation.${inputs.mod_who || 'benchmark'}`), inputs.mod_who != null),
    payments: piece(inputs.rev > 0 ? fmt(t('whose.payments.some'), { rev: compact(inputs.rev) }) : t('whose.payments.none'), inputs.rev > 0),
    reach: piece(fmt(t('whose.reach.in'), { list: regions.join(t('whose.reach.join')) }), true),
    nostr: piece(t(`whose.nostr.${eff.nostr_now}`), inputs.nostr_now != null),
  }
  clear(host)
  for (const token of t('whose.frame').split(/(\{\w+\})/)) {
    const m = token.match(/^\{(\w+)\}$/)
    host.append(m ? pieces[m[1]] || document.createTextNode(token) : document.createTextNode(token))
  }
}

/** The year-by-year table under the chart: the picture as numbers, measures down and calendar years across, from today. */
function renderYears(projection, startYear) {
  const head = $('#r-years-head')
  if (!head) return
  for (const extra of $$('th[data-year]', head)) extra.remove()
  for (let year = 0; year <= YEARS; year++) head.append(el('th', { scope: 'col', class: 'years-num', 'data-year': year, text: yearLabel(startYear, year) }))
  const cell = { users: (p) => number(p.users), custodial: (p) => money(p.custodial), nostr: (p) => money(p.nostr), realised: (p) => money(p.realised), cumulative: (p) => money(p.cumulative) }
  for (const row of $$('#r-years tbody tr[data-row]')) {
    const value = cell[row.dataset.row]
    if (!value) continue
    for (const old of $$('td', row)) old.remove()
    for (let year = 0; year <= YEARS; year++) row.append(el('td', { class: 'years-num', text: value(projection[year]) }))
  }
}

function renderParts(name, line, inputs) {
  const host = $(`.lt-parts[data-line="${name}"] .parts`)
  if (!host) return
  // The line's two totals head the list: the year the network is at scale, under custody and on Nostr.
  text(`.lt-parts[data-line="${name}"] .parts__total-c`, money(line.scale_custodial))
  text(`.lt-parts[data-line="${name}"] .parts__total-nc`, money(line.scale_noncustodial))
  clear(host)
  const item = (p) => {
    const meta = partMeta(p, inputs)
    return el('li', {}, [
      // A link-styled button: pressing it explains how the figure was made.
      el('button', { type: 'button', class: 'part', 'data-line': name, 'data-part': p.id, 'aria-haspopup': 'dialog' }, [
        el('span', { class: 'part__label' }, [
          t(`parts.${p.id}`, p.id),
          meta ? el('span', { class: 'part__meta', text: meta }) : null,
        ]),
        el('span', { class: 'part__nums' }, [
          money(p.scale_custodial),
          ' → ',
          el('b', { text: money(p.scale_noncustodial) }),
        ]),
      ]),
    ])
  }
  const subtotal = (label, parts) =>
    el('li', { class: 'parts__subtotal' }, [
      el('span', { class: 'parts__subtotal-label', text: label }),
      el('span', { class: 'part__nums' }, [money(parts.reduce((a, p) => a + p.scale_custodial, 0)), ' → ', el('b', { text: money(parts.reduce((a, p) => a + p.scale_noncustodial, 0)) })]),
    ])
  // Fees on in-app payments and an expected loss are not operating bills:
  // where a line carries either kind, each group is listed with its own
  // sub-total, cash costs first.
  const groups = [
    ['cash', line.parts.filter((p) => !p.kind)],
    ['fees', line.parts.filter((p) => p.kind === 'fees')],
    ['risk', line.parts.filter((p) => p.kind === 'risk')],
  ].filter(([, parts]) => parts.length)
  const labelled = groups.some(([kind]) => kind !== 'cash')
  for (const [kind, parts] of groups) {
    for (const p of parts) host.append(item(p))
    if (labelled) host.append(subtotal(t(`details.${kind}`), parts))
  }
}

// ── how this is calculated ───────────────────────────────────────────────────

let howKeys = [] // the assumptions behind the part last explained
let howLabel = ''

/** Fill and open the dialog for one part of one line. */
export function openHow(line, partId, result, data) {
  const part = result.typical.lines[line]?.parts.find((p) => p.id === partId)
  if (!part) return
  const info = explain(line, part, { inputs: result.typical.effective, values: result.typical.values, overrides: result.overrides, data, scale: { year: MARKER_YEAR, users: result.typical.totals.scale_users } })
  fillHow({
    label: info.label,
    line: $(`.lt-row[data-line="${line}"] .lt-title`)?.textContent.trim() || line,
    heads: [t('details.today'), t('details.on_nostr')],
    rows: [info.today, info.nostr],
    foot: info.at_scale,
    assumptions: info.assumptions,
  })
}

function fillHow({ label, line, heads, rows, foot, assumptions }) {
  const dialog = $('#how-modal')
  if (!dialog) return
  howKeys = assumptions.map((a) => a.key)
  howLabel = label
  text('#how-part', label)
  text('#how-line', line)
  text('#how-dt-today', heads[0])
  text('#how-dt-nostr', heads[1])
  text('#how-today', rows[0])
  text('#how-nostr', rows[1])
  text('#how-scale', foot)
  const list = $('#how-list')
  clear(list)
  for (const a of assumptions) {
    list.append(
      el('li', { class: 'how__item' }, [
        el('span', { class: 'how__label' }, [a.label, a.changed ? el('span', { class: 'how__changed', text: t('how.changed') }) : null]),
        el('span', { class: 'how__value' }, [
          el('b', { text: a.value }),
          el('span', { class: 'how__meta', text: fmt(t('how.meta'), { low: a.low, high: a.high, confidence: t(`how.confidence.${a.confidence}`, a.confidence) }) }),
        ]),
      ]),
    )
  }
  show($('#how-adjust'), assumptions.length > 0)
  if (!dialog.open) dialog.showModal()
}

export function closeHow() {
  const dialog = $('#how-modal')
  if (dialog?.open) dialog.close()
}

/** Light up the rows behind the part last explained, and say so above the table. */
export function focusAssumptions() {
  const panel = $('#calc-assume')
  if (!panel) return
  let first = null
  for (const row of $$('.assume-table tr[data-key]')) {
    const on = howKeys.includes(row.dataset.key)
    row.classList.toggle('is-focus', on)
    if (on && !first) first = row
  }
  panel.classList.toggle('is-filtered', howKeys.length > 0)
  text('#a-filter-text', fmt(t('how.showing'), { n: howKeys.length, part: howLabel }))
  show($('#a-filter'), howKeys.length > 0)
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

export function clearFocus() {
  const panel = $('#calc-assume')
  if (!panel) return
  for (const row of $$('.assume-table tr.is-focus')) row.classList.remove('is-focus')
  panel.classList.remove('is-filtered')
  show($('#a-filter'), false)
}

/** The applied rate or tier beside a part, where there is one worth seeing. */
function partMeta(p, inputs) {
  if (p.id.startsWith('store_')) return `${fmt(t('details.rate'), { rate: percent(p.rate) })} · ${t(`details.tier_${p.tier}`)}`
  if (p.id === 'processor') return fmt(t('details.rate'), { rate: percent(p.rate) })
  if (p.id === 'verify' && p.rate != null) return fmt(t('details.checked'), { rate: percent(p.rate) })
  if (p.id === 'privacy_programs') return p.reported ? t('details.reported') : p.us_tier ? t(`details.us_${p.us_tier}`) : ''
  if (p.id === 'labour' && p.nobody) return ''
  if (p.id === 'labour' && p.people != null) {
    if (p.implied) return fmt(t('details.people_implied'), { n: number(p.people) })
    const which = p.who === 'vendor' ? 'seats' : 'people'
    return fmt(t(p.heads_from ? `details.${which}_default` : `details.${which}`), { n: number(p.people) })
  }
  if (p.id === 'money_transmitter' && p.holds) return t('details.holds')
  if ((p.id === 'engineering' || p.id === 'legal_labour') && p.defaulted) return t(p.from === 'team' ? 'details.defaulted_team' : 'details.defaulted')
  if ((p.id === 'reseller' || p.id === 'p2p') && p.rate != null) return fmt(t('details.rate'), { rate: percent(p.rate) })
  if (p.id === 'database' && p.gb != null) return fmt(t('details.gb'), { gb: number(p.gb) })
  if (p.id === 'breach') return t('details.expected_loss')
  if (p.id === 'relay' && p.minimum) return t('details.relay_minimum')
  if (p.id === 'dsar' && p.users != null && p.custodial > 0 && p.users < inputs.mau - 0.5) return fmt(t('details.dsar_users'), { n: number(Math.round(p.users)) })
  return ''
}

export function wireToggles() {
  for (const button of $$('.lt-toggle')) {
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true'
      button.setAttribute('aria-expanded', String(open))
      button.textContent = open ? button.dataset.hide : button.dataset.show
      const row = document.getElementById(button.getAttribute('aria-controls'))
      if (row) row.hidden = !open
      button.closest('tr')?.classList.toggle('is-open', open)
    })
  }
}

// ── the tabs ─────────────────────────────────────────────────────────────────

export const TABS = ['cost', 'app', 'assumptions']

/** The anchors a link may name a tab by: /calculator/#results, #app, #assumptions. */
export const TAB_ANCHORS = { results: 'cost', app: 'app', assumptions: 'assumptions' }

/**
 * Show one tab. A press on a tab (or on the tab already open) brings the bar
 * to the top of the view; the page's own calls on load pass `scroll: false`
 * so a fresh page stays where the browser put it, unless a link named a tab.
 */
export function activateTab(name, { focus = false, scroll = true, behavior = 'smooth' } = {}) {
  for (const tab of TABS) {
    const button = $(`#tab-${tab}`)
    const panel = $(`#panel-${tab}`)
    const on = tab === name
    if (button) {
      button.setAttribute('aria-selected', String(on))
      button.tabIndex = on ? 0 : -1
    }
    if (panel) panel.hidden = !on
  }
  // The phone row shows the active tab's icon and name, and the dropped track folds back up.
  const current = $('#tabs-current .tabs__current-tab')
  const active = $(`#tab-${name}`)
  if (current && active) {
    clear(current)
    for (const child of active.childNodes) current.append(child.cloneNode(true))
    $('#tabs-current').dataset.tab = name
  }
  openTabMenu(false)
  if (scroll) $('#calc')?.scrollIntoView({ behavior, block: 'start' })
  if (focus) $(`#tab-${name}`)?.focus({ preventScroll: true })
}

/** The dropped track on a phone: open, closed, or toggled. */
export function openTabMenu(open) {
  const bar = $('#tabbar')
  const button = $('#tabs-current')
  if (!bar || !button) return
  const next = open ?? !bar.classList.contains('is-open')
  bar.classList.toggle('is-open', next)
  button.setAttribute('aria-expanded', String(next))
}

export function wireTabs(onSelect) {
  $('#tabs-current')?.addEventListener('click', () => openTabMenu())
  const buttons = TABS.map((t) => $(`#tab-${t}`)).filter(Boolean)
  for (const button of buttons) {
    const name = button.id.replace('tab-', '')
    button.addEventListener('click', () => onSelect(name))
    // Arrow keys move between tabs, as a tablist should.
    button.addEventListener('keydown', (e) => {
      const at = TABS.indexOf(name)
      if (e.key === 'ArrowRight') onSelect(TABS[(at + 1) % TABS.length], { focus: true })
      else if (e.key === 'ArrowLeft') onSelect(TABS[(at + TABS.length - 1) % TABS.length], { focus: true })
    })
  }
}

export function showResults(visible, { focus = false, scroll = true } = {}) {
  const panel = $('#calc-results')
  if (!panel) return
  panel.hidden = !visible
  const empty = $('#r-empty')
  if (empty) empty.hidden = visible
  if (visible) {
    activateTab('cost', { scroll })
    if (focus) {
      $('.tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      $('#results-title')?.focus({ preventScroll: true })
    }
  }
}

export function setStatus(message) {
  const node = $('#r-status')
  if (node) node.textContent = message || ''
}

export function setError(code, fieldLabel) {
  const node = $('#calc-error')
  if (!node) return
  const message = code ? fmt(t(`errors.${code}`) || t('errors.unknown'), { field: fieldLabel || '' }) : ''
  node.textContent = message
  show(node, Boolean(message))
}

// ── the assumptions panel ────────────────────────────────────────────────────

/** Current overrides from the inputs: anything that is not its typical value. */
export function readOverrides() {
  const out = {}
  for (const input of $$('.assume-input')) {
    const typical = Number(input.dataset.typical)
    const v = input.value.trim()
    if (v === '') continue
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0 || n === typical) continue
    out[input.dataset.key] = n
  }
  return out
}

export function writeOverrides(overrides = {}) {
  for (const input of $$('.assume-input')) {
    const key = input.dataset.key
    input.value = key in overrides ? String(overrides[key]) : input.dataset.typical
  }
  markChanged()
}

export function markChanged() {
  for (const input of $$('.assume-input')) {
    const changed = input.value.trim() !== '' && Number(input.value) !== Number(input.dataset.typical)
    input.closest('tr')?.classList.toggle('is-changed', changed)
  }
}

function text(sel, value) {
  const node = $(sel)
  if (node) node.textContent = value
}
