// The view. Every panel and every word is already in the page, rendered by
// Jekyll from _data/pages/calculator.yml; this module fills the slots that
// are only known once there are numbers: the figures, the six rows, the bars,
// the parts, the link, the status.

import { $, $$, clear, el, show } from '../../shared/src/dom.js'
import { fmt, t } from '../../shared/src/config.js'
import { compact, money, number, percent, perMau } from './format.js'
import { LINES, YEARS } from './model.js'
import { drawCharts } from './chart.js'

const range = (low, high) => fmt(t('range_short'), { low: compact(low), high: compact(high) })

export function renderResults(result, { own = false } = {}) {
  const { typical, low, high, inputs } = result
  const T = typical.totals

  // Whose estimate this is: the illustrative app, or the visitor's own.
  const whose = $('#r-whose-text')
  if (whose) whose.textContent = fmt(t(own ? 'whose.yours' : 'whose.illustrative'), { mau: number(inputs.mau) })
  const link = $('#r-whose-link')
  if (link) link.textContent = t(own ? 'whose.adjust' : 'whose.make_yours')

  // The three facts under the chart: per user today, per user on Nostr, and
  // the average year of the five. The five-year figure itself is in the chart.
  text('#r-permau-c', perMau(T.per_mau_custodial))
  text('#r-permau-c-range', fmt(t('range'), { low: perMau(low.totals.per_mau_custodial), high: perMau(high.totals.per_mau_custodial) }))
  text('#r-permau-nc', perMau(T.per_mau_noncustodial))
  text('#r-permau-nc-range', fmt(t('range'), { low: perMau(low.totals.per_mau_noncustodial), high: perMau(high.totals.per_mau_noncustodial) }))
  text('#r-average', compact(T.five_year / YEARS))
  text('#r-average-range', fmt(t('range'), { low: compact(low.totals.five_year / YEARS), high: compact(high.totals.five_year / YEARS) }))
  text('#r-version', fmt(t('version'), { version: result.version }))

  drawCharts({ typical: typical.projection, low: low.projection })
  renderYears(typical.projection)

  // One scale for every bar: the largest custodial figure in the table.
  const scale = Math.max(...LINES.map((l) => typical.lines[l].custodial), 1)

  for (const name of LINES) {
    const line = typical.lines[name]
    const row = $(`.lt-row[data-line="${name}"]`)
    if (!row) continue
    row.classList.toggle('is-already', Boolean(line.already))
    row.classList.toggle('is-none', Boolean(line.none))
    show($('.lt-flag--already', row), Boolean(line.already))
    show($('.lt-flag--partly', row), Boolean(line.partly))
    show($('.lt-flag--implied', row), Boolean(line.implied))
    show($('.lt-flag--none', row), Boolean(line.none))

    const c = $('.lt-value--c', row)
    const nc = $('.lt-value--nc', row)
    c.textContent = money(line.custodial)
    nc.textContent = money(line.noncustodial)
    c.nextElementSibling.textContent = line.none ? '' : range(low.lines[name].custodial, high.lines[name].custodial)
    nc.nextElementSibling.textContent = line.none ? '' : range(low.lines[name].noncustodial, high.lines[name].noncustodial)

    $('.bar--c', row).style.setProperty('--w', `${(100 * line.custodial) / scale}%`)
    $('.bar--nc', row).style.setProperty('--w', `${(100 * line.noncustodial) / scale}%`)

    renderParts(name, line, inputs)
  }
}

/** The year-by-year table under the chart: the picture as numbers, measures down and years across. */
function renderYears(projection) {
  const head = $('#r-years-head')
  if (!head) return
  for (const extra of $$('th[data-year]', head)) extra.remove()
  for (let year = 1; year <= YEARS; year++) head.append(el('th', { scope: 'col', class: 'years-num', 'data-year': year, text: fmt(t('chart.year'), { n: year }) }))
  const cell = { users: (p) => number(p.users), custodial: (p) => money(p.custodial), path: (p) => money(p.path), realised: (p) => money(p.realised), cumulative: (p) => money(p.cumulative) }
  for (const row of $$('#r-years tbody tr[data-row]')) {
    const value = cell[row.dataset.row]
    if (!value) continue
    for (const old of $$('td', row)) old.remove()
    for (let year = 1; year <= YEARS; year++) row.append(el('td', { class: 'years-num', text: value(projection[year]) }))
  }
}

function renderParts(name, line, inputs) {
  const host = $(`.lt-parts[data-line="${name}"] .parts`)
  if (!host) return
  clear(host)
  for (const p of line.parts) {
    const meta = partMeta(p, inputs)
    host.append(
      el('li', { class: 'part' }, [
        el('span', { class: 'part__label' }, [
          t(`parts.${p.id}`, p.id),
          meta ? el('span', { class: 'part__meta', text: meta }) : null,
        ]),
        el('span', { class: 'part__nums' }, [
          money(p.custodial),
          ' → ',
          el('b', { text: money(p.noncustodial) }),
        ]),
      ]),
    )
  }
}

/** The applied rate or tier beside a part, where there is one worth seeing. */
function partMeta(p, inputs) {
  if (p.id.startsWith('store_')) return `${fmt(t('details.rate'), { rate: percent(p.rate) })} · ${t(`details.tier_${p.tier}`)}`
  if (p.id === 'processor') return fmt(t('details.rate'), { rate: percent(p.rate) })
  if (p.id === 'verify' && p.rate != null) return fmt(t('details.rate'), { rate: percent(p.rate) })
  if (p.id === 'privacy_programs') return p.reported ? t('details.reported') : p.us_tier ? t(`details.us_${p.us_tier}`) : ''
  if (p.id === 'labour' && p.people != null) return fmt(t('details.people'), { n: number(p.people) })
  if (p.id === 'money_transmitter' && p.holds) return t('details.holds')
  if ((p.id === 'engineering' || p.id === 'legal_labour') && p.defaulted) return t('details.defaulted')
  if ((p.id === 'reseller' || p.id === 'p2p') && p.rate != null) return fmt(t('details.rate'), { rate: percent(p.rate) })
  if (p.id === 'database' && p.gb != null) return fmt(t('details.gb'), { gb: number(p.gb) })
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
    })
  }
}

// ── the tabs ─────────────────────────────────────────────────────────────────

export const TABS = ['cost', 'app', 'assumptions']

export function activateTab(name, { focus = false } = {}) {
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
  if (focus) {
    $('.tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    $(`#tab-${name}`)?.focus({ preventScroll: true })
  }
}

export function wireTabs(onSelect) {
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

export function showResults(visible, { focus = false } = {}) {
  const panel = $('#calc-results')
  if (!panel) return
  panel.hidden = !visible
  const empty = $('#r-empty')
  if (empty) empty.hidden = visible
  if (visible) {
    activateTab('cost')
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
