// The view. Every panel and every word is already in the page, rendered by
// Jekyll from _data/pages/calculator.yml; this module fills the slots that
// are only known once there are numbers: the figures, the six rows, the bars,
// the parts, the link, the status.

import { $, $$, clear, el, show } from '../../shared/src/dom.js'
import { fmt, t } from '../../shared/src/config.js'
import { approx, compact, date, money, number, percent, perMau } from './format.js'
import { LINES, YEARS, isDate, sourcingCounts } from './model.js'
import { drawCharts, yearLabel } from './chart.js'
import { explain } from './explain.js'

// The two bounds in reading order, whichever scenario gave which: low is the
// smaller saving, so on the Nostr side it is the larger cost.
const ordered = (a, b) => (a <= b ? [a, b] : [b, a])
const range = (a, b, f = approx) => {
  const [low, high] = ordered(a, b)
  return fmt(t('range_short'), { low: f(low), high: f(high) })
}
const rangeFull = (a, b, f = compact) => {
  const [low, high] = ordered(a, b)
  return Math.abs(high - low) < 1e-9 ? '' : fmt(t('range'), { low: f(low), high: f(high) })
}

export function renderResults(result, { own = false, data = null } = {}) {
  const { typical, low, high, inputs } = result
  const T = typical.totals

  // Whose estimate this is, and the app it describes, one piece per section.
  renderWhose(result, own)
  renderCustom(result)
  const link = $('#r-whose-link')
  if (link) link.textContent = t('whose.link')

  // The three facts beside the chart, all at the instant the headline is
  // read: the custodial cost per user then (that side does not vary, so it
  // has no range), the Nostr cost per user then, and the Nostr cost a year then.
  text('#r-permau-c', perMau(T.estimated_custodial / T.estimated_users))
  text('#r-permau-c-range', rangeFull(low.totals.estimated_custodial / low.totals.estimated_users, high.totals.estimated_custodial / high.totals.estimated_users, perMau))
  text('#r-permau-nc', perMau(T.estimated_nostr / T.estimated_users))
  text('#r-permau-nc-range', rangeFull(low.totals.estimated_nostr / low.totals.estimated_users, high.totals.estimated_nostr / high.totals.estimated_users, perMau))
  text('#r-scale-nostr', approx(T.estimated_nostr))
  text('#r-scale-nostr-range', rangeFull(low.totals.estimated_nostr, high.totals.estimated_nostr, approx))
  text('#r-version', fmt(t('version'), { version: result.version, date: date(result.today) }))
  // The sourcing line: three counts from what the rows carry, which add up to the file.
  if (data) text('#r-sourcing', fmt(t('sourcing'), sourcingCounts(data)))

  renderChart(result)
  renderYears(typical.projection)

  // Where the saving comes from: each line's saving a year at the instant the
  // headline is read, and the bar as the share of that line's own cost that
  // goes away. The six add up to the headline.
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
    saving.textContent = line.none ? '' : approx(line.estimated)
    rangeNode.textContent = line.none ? '' : range(low.lines[name].estimated, high.lines[name].estimated)
    show(saving, !line.none)
    const share = line.none ? 0 : cut(line.custodial, line.noncustodial)
    $('.share', row).style.setProperty('--w', `${100 * share}%`)
    text(`.lt-row[data-line="${name}"] .share__pct`, line.none ? '' : percent(share))

    renderParts(name, line, inputs)
  }
}

/**
 * The custom-assumptions banner: shown whenever any override applied, so a
 * crafted link cannot pass as Nostr4's number; it names what was clamped.
 */
function renderCustom(result) {
  const banner = $('#r-custom')
  if (!banner) return
  const keys = Object.keys(result.overrides || {})
  const clamped = result.clamped || []
  show(banner, keys.length > 0 || clamped.length > 0)
  const detail = $('#r-custom-detail')
  if (detail) detail.textContent = clamped.length ? fmt(t('custom.clamped'), { list: clamped.map((c) => `${c.key} ${c.from} → ${c.to}`).join(', ') }) : ''
}

/**
 * A span of months in the caption's words: whole years as words ("two-year",
 * "year three", "one year"), anything else as months, so an overridden
 * assumption still reads right.
 */
function span(months, kind) {
  const whole = months > 0 && months % 12 === 0 ? months / 12 : null
  const words = t('chart.spans.words') || []
  if (whole != null && words[whole]) {
    if (kind === 'after') return fmt(t(whole === 1 ? 'chart.spans.after_years' : 'chart.spans.after_years_plural'), { n: words[whole] })
    return fmt(t(`chart.spans.${kind}_years`), { n: words[whole] })
  }
  return fmt(t(`chart.spans.${kind}_months`), { n: number(months) })
}

/**
 * The end of the chart's caption: the breach exposure, calculated apart
 * from the saving, in bold, with the button to its dialog. A zero
 * reduction (an app already on Nostr for keys and storage) leaves the
 * sentence out; "$0 of exposure" is never said.
 */
function renderNote(reduction) {
  const host = $('#r-note-text')
  const how = $('#r-breach-how')
  if (!host) return
  clear(host)
  const amount = approx(reduction)
  if (!(reduction >= 0.5) || amount === '$0') {
    show(how, false)
    return
  }
  for (const token of t('headline.note').split(/(\{breach\})/)) host.append(token === '{breach}' ? el('b', { text: amount }) : document.createTextNode(token))
  show(how, true)
}

/**
 * The picture and its caption. The chart gets the typical scenario's six
 * points and two markers; the gold figure is the headline, rounded as it
 * is everywhere. The caption names the window and the instant the headline
 * is read, in derived words, then the breach line.
 */
function renderChart(result) {
  const { typical } = result
  const T = typical.totals
  const M = typical.markers
  const spans = { window: span(M.payback.months, 'window'), at: span(T.estimated_months, 'at'), after: span(T.estimated_after_payback, 'after') }
  const caption = $(`#caption-text-${'chart-custodial-cost-vs-nostr'}`)
  if (caption) caption.textContent = [caption.dataset.template, fmt(t('chart.caption_window'), spans), fmt(t('chart.caption_estimated'), spans)].filter(Boolean).join(' ')
  renderNote(T.breach_reduction)
  const first = typical.projection[0]
  const end = typical.projection[YEARS]
  const title = fmt(t('chart.versus.aria'), {
    custodial: approx(first.custodial),
    nostr: approx(first.nostr),
    end_custodial: approx(end.custodial),
    end_nostr: approx(end.nostr),
    saving: approx(T.estimated),
    ...spans,
  })
  drawCharts({ projection: typical.projection, markers: M, headline: { text: approx(T.estimated), sub: t('chart.versus.band_sub') }, title })
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
    // The growth bands are "0", "0.25", "0.5" and "1": looked up on the block, not by path.
    growth: piece(t('whose.growth')?.[eff.growth] ?? '', inputs.growth != null),
    team: piece(t(`whose.team.${eff.team}`), inputs.team != null),
    moderation: piece(t(`whose.moderation.${inputs.mod_who || 'benchmark'}`), inputs.mod_who != null),
    payments: piece(inputs.p2p_volume > 0 ? fmt(t('whose.payments.some'), { volume: compact(inputs.p2p_volume) }) : t('whose.payments.none'), inputs.p2p_volume > 0),
    reach: piece(fmt(t('whose.reach.in'), { list: regions.join(t('whose.reach.join')) }), true),
    // The Nostr bands are "0", "0.5" and "1": a key with a dot in it is looked up on the block, not by path.
    nostr: piece(t('whose.nostr')?.[eff.nostr_now] ?? '', inputs.nostr_now != null),
  }
  clear(host)
  for (const token of t('whose.frame').split(/(\{\w+\})/)) {
    const m = token.match(/^\{(\w+)\}$/)
    host.append(m ? pieces[m[1]] || document.createTextNode(token) : document.createTextNode(token))
  }
}

/** The year-by-year table under the chart: the picture as numbers, measures down and years across, from today. Every cell is a run-rate at that instant. */
function renderYears(projection) {
  const head = $('#r-years-head')
  if (!head) return
  for (const extra of $$('th[data-year]', head)) extra.remove()
  for (let year = 0; year <= YEARS; year++) head.append(el('th', { scope: 'col', class: 'years-num', 'data-year': year, text: yearLabel(year) }))
  const cell = { users: (p) => number(Math.round(p.users)), custodial: (p) => money(p.custodial), nostr: (p) => money(p.nostr), realised: (p) => money(p.realised) }
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
  // The line's two totals foot the table: the instant the headline is read, under custody and on Nostr.
  text(`.lt-parts[data-line="${name}"] .parts__total-c`, money(line.estimated_custodial))
  text(`.lt-parts[data-line="${name}"] .parts__total-nc`, money(line.estimated_noncustodial))
  clear(host)
  // One row per part: the item (a link-styled button that explains how the
  // figure was made), its custodial cost and its Nostr cost.
  const item = (p) => {
    const meta = partMeta(p, inputs)
    return el('tr', {}, [
      el('th', { scope: 'row' }, [
        el('button', { type: 'button', class: 'part', 'data-line': name, 'data-part': p.id, 'aria-haspopup': 'dialog' }, [
          el('span', { class: 'part__label', text: t(`parts.${p.id}`, p.id) }),
          meta ? el('span', { class: 'part__meta', text: meta }) : null,
        ]),
      ]),
      el('td', { class: 'parts-num', text: money(p.estimated_custodial) }),
      el('td', { class: 'parts-num' }, [el('b', { text: money(p.estimated_noncustodial) })]),
    ])
  }
  const subtotal = (label, parts) =>
    el('tr', { class: 'parts__subtotal' }, [
      el('th', { scope: 'row', text: label }),
      el('td', { class: 'parts-num', text: money(parts.reduce((a, p) => a + p.estimated_custodial, 0)) }),
      el('td', { class: 'parts-num' }, [el('b', { text: money(parts.reduce((a, p) => a + p.estimated_noncustodial, 0)) })]),
    ])
  // Fees on payments between users are not operating bills: where a line
  // carries both kinds, each group is listed with its own sub-total, cash
  // costs first. The expected breach loss is not in the table at all: it is
  // an exposure, noted under the headline with its own dialog.
  const groups = [
    ['cash', line.parts.filter((p) => !p.kind)],
    ['fees', line.parts.filter((p) => p.kind === 'fees')],
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
  const T = result.typical.totals
  const info = explain(line, part, { inputs: result.typical.effective, values: result.typical.values, overrides: result.overrides, data, estimated: { months: T.estimated_months, users: T.estimated_users, date: T.estimated_date, breach: T.breach_reduction } })
  fillHow({
    label: info.label,
    line: $(`.lt-row[data-line="${line}"] .lt-title`)?.textContent.trim() || line,
    heads: [t('details.today'), t('details.on_nostr')],
    rows: [info.today, info.nostr],
    foot: info.estimated,
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
  // Engineering says where its hours came from: a default for the team size, or the founder's own band.
  if (p.id === 'engineering' || p.id === 'legal_labour') {
    if (p.defaulted) return fmt(t(p.from === 'team' ? 'details.defaulted_team' : 'details.defaulted'), { team: t(`whose.team.${inputs.team}`) })
    return fmt(t('details.hours_given'), { hours: number(p.hours) })
  }
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

const isDateInput = (input) => input.dataset.unit === 'date' || input.type === 'date'

/** Current overrides from the inputs: anything that is not its typical value. A date row gives its ISO string, every other row a number. */
export function readOverrides() {
  const out = {}
  for (const input of $$('.assume-input')) {
    const v = input.value.trim()
    if (v === '') continue
    if (isDateInput(input)) {
      if (isDate(v) && v !== input.dataset.typical) out[input.dataset.key] = v
      continue
    }
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0 || n === Number(input.dataset.typical)) continue
    out[input.dataset.key] = n
  }
  return out
}

export function writeOverrides(overrides = {}) {
  for (const input of $$('.assume-input')) {
    const key = input.dataset.key
    input.value = Object.hasOwn(overrides, key) ? String(overrides[key]) : input.dataset.typical
  }
  markChanged()
}

export function markChanged() {
  for (const input of $$('.assume-input')) {
    const v = input.value.trim()
    const changed = v !== '' && (isDateInput(input) ? v !== input.dataset.typical : Number(v) !== Number(input.dataset.typical))
    input.closest('tr')?.classList.toggle('is-changed', changed)
  }
}

function text(sel, value) {
  const node = $(sel)
  if (node) node.textContent = value
}
