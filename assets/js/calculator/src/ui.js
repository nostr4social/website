// The view. Every panel and every word is already in the page, rendered by
// Jekyll from _data/pages/calculator.yml; this module fills the slots that
// are only known once there are numbers: the figures, the six rows, the bars,
// the parts, the link, the status.

import { $, $$, clear, el, show } from '../../shared/src/dom.js'
import { fmt, t } from '../../shared/src/config.js'
import { compact, money, number, percent, perMau } from './format.js'
import { LINES, YEARS } from './model.js'
import { drawCharts } from './chart.js'
import { explain } from './explain.js'

const range = (low, high) => fmt(t('range_short'), { low: compact(low), high: compact(high) })

export function renderResults(result, { own = false } = {}) {
  const { typical, low, high, inputs } = result
  const T = typical.totals

  // Whose estimate this is: the illustrative app, or the visitor's own.
  const whose = $('#r-whose-text')
  if (whose) whose.textContent = fmt(t(own ? 'whose.yours' : 'whose.illustrative'), { mau: number(inputs.mau) })
  const link = $('#r-whose-link')
  if (link) link.textContent = t('whose.link')

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

  // Where the saving comes from: each line's average year of saving, and the
  // bar as the share of that line's own cost that goes away. The foot row and
  // the matching fact chip name the same whole.
  text('#r-total', compact(T.average))
  const cut = (c, nc) => (c > 0 ? Math.min(1, Math.max(0, 1 - nc / c)) : 0)
  const total = cut(T.custodial, T.noncustodial)
  $('.lt-total .share')?.style.setProperty('--w', `${100 * total}%`)
  text('.lt-total .share__pct', percent(total))

  for (const name of LINES) {
    const line = typical.lines[name]
    const row = $(`.lt-row[data-line="${name}"]`)
    if (!row) continue
    const nudged = Boolean(line.nudge) && line.average < 1
    row.classList.toggle('is-already', Boolean(line.already))
    row.classList.toggle('is-none', Boolean(line.none))
    row.classList.toggle('is-nudged', nudged)
    show($('.lt-flag--already', row), Boolean(line.already))
    show($('.lt-flag--partly', row), Boolean(line.partly))
    show($('.lt-flag--none', row), Boolean(line.none))

    const saving = $('.lt-saving', row)
    const rangeNode = $('.lt-saving-range', row)
    const nudgeNode = $('.lt-nudge', row)
    saving.textContent = line.none ? '' : money(line.average)
    rangeNode.textContent = line.none || nudged ? '' : range(low.lines[name].average, high.lines[name].average)
    nudgeNode.textContent = nudged ? fmt(t(`nudges.${line.nudge.id}`), { amount: compact(line.nudge.amount) }) : ''
    show(saving, !nudged && !line.none)
    show(nudgeNode, nudged)
    const share = line.none ? 0 : cut(line.custodial, line.noncustodial)
    $('.share', row).style.setProperty('--w', `${100 * share}%`)
    text(`.lt-row[data-line="${name}"] .share__pct`, line.none ? '' : percent(share))

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
  // The line's two totals head the list: the average projected year, under custody and on Nostr.
  text(`.lt-parts[data-line="${name}"] .parts__total-c`, money(line.avg_custodial))
  text(`.lt-parts[data-line="${name}"] .parts__total-nc`, money(line.avg_noncustodial))
  clear(host)
  for (const p of line.parts) {
    const meta = partMeta(p, inputs)
    host.append(
      el('li', {}, [
        // A link-styled button: pressing it explains how the figure was made.
        el('button', { type: 'button', class: 'part', 'data-line': name, 'data-part': p.id, 'aria-haspopup': 'dialog' }, [
          el('span', { class: 'part__label' }, [
            t(`parts.${p.id}`, p.id),
            meta ? el('span', { class: 'part__meta', text: meta }) : null,
          ]),
          el('span', { class: 'part__nums' }, [
            money(p.avg_custodial),
            ' → ',
            el('b', { text: money(p.avg_noncustodial) }),
          ]),
        ]),
      ]),
    )
  }
}

// ── how this is calculated ───────────────────────────────────────────────────

let howKeys = [] // the assumptions behind the part last explained
let howLabel = ''

/** Fill and open the dialog for one part of one line. */
export function openHow(line, partId, result, data) {
  const dialog = $('#how-modal')
  const part = result.typical.lines[line]?.parts.find((p) => p.id === partId)
  if (!dialog || !part) return
  const values = Object.fromEntries(Object.entries(data.assumptions).map(([k, a]) => [k, k in result.overrides ? result.overrides[k] : a.typical]))
  const info = explain(line, part, { inputs: result.inputs, values, overrides: result.overrides, data })
  howKeys = info.assumptions.map((a) => a.key)
  howLabel = info.label
  text('#how-part', info.label)
  text('#how-line', $(`.lt-row[data-line="${line}"] .lt-title`)?.textContent.trim() || line)
  text('#how-today', info.today)
  text('#how-nostr', info.nostr)
  text('#how-averaged', info.averaged)
  const list = $('#how-list')
  clear(list)
  for (const a of info.assumptions) {
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
  show($('#how-adjust'), info.assumptions.length > 0)
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
  if (p.id === 'labour' && p.people != null) return fmt(t(p.implied ? 'details.people_implied' : 'details.people'), { n: number(p.people) })
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
      button.closest('tr')?.classList.toggle('is-open', open)
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
