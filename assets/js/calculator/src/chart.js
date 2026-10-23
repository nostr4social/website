// The two savings pictures, drawn as inline SVG by one small line-chart
// routine so they share a grid, a hover layer and a keyboard path:
//
//   chart-custodial-cost-vs-nostr   the cost of custody a year and the cost
//                                   on the way to Nostr, from one point today:
//                                   the second dips as custody leaves, both
//                                   rise with the app, and the filled gap is
//                                   the saving. The area is the five-year
//                                   figure, written inside it. The one the
//                                   page lists.
//   chart-cumulative-savings        cumulative saving by year, typical case
//                                   as the line, low case as the floor; kept
//                                   drawable, listed in the page's copy when
//                                   wanted.
//
// Each is drawn at its figure's own pixel width so text stays readable at
// every size, and redrawn when that width changes. The year-by-year table
// beside them is the reading for anyone the pictures do not serve.

import { $ } from '../../shared/src/dom.js'
import { fmt, t } from '../../shared/src/config.js'
import { compact, compactNumber, number } from './format.js'
import { MARKER_YEAR, YEARS } from './model.js'

const NS = 'http://www.w3.org/2000/svg'
const PAD = { top: 44, right: 20, bottom: 30, left: 64 }
const GUTTER = 84 // the right-hand gutter that names the two horizontal axes
const HEIGHT = { wide: 300, narrow: 240 }

export const CUMULATIVE = 'chart-cumulative-savings'
export const VERSUS = 'chart-custodial-cost-vs-nostr'

const charts = new Map() // id → { spec, layout, active }
let last = null // the projections last drawn, for a redraw

function node(name, attrs = {}, children = []) {
  const n = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v))
  for (const c of children) n.append(c)
  return n
}

/** Draw (or redraw) both charts for these projections: { typical, low }. */
export function drawCharts(projections) {
  last = projections
  if (!projections) return
  const { typical, low } = projections
  draw(CUMULATIVE, {
    series: [
      { key: 'low', cls: 'chart__floor', points: low.map((p) => p.cumulative) },
      { key: 'typical', cls: 'chart__line', points: typical.map((p) => p.cumulative), markers: [MARKER_YEAR, YEARS] },
    ],
    band: ['typical', 'low'],
    labels: [
      ...[MARKER_YEAR, YEARS].map((year) => ({ key: 'typical', year, cls: 'chart__label', dy: -12, text: fmt(t('chart.marker'), { amount: compact(typical[year].cumulative), n: year }) })),
      { key: 'low', year: YEARS, cls: 'chart__floor-label', dy: -8, text: fmt(t('chart.floor'), { amount: compact(low[YEARS].cumulative) }) },
    ],
    title: fmt(t('chart.aria'), { end: compact(typical[YEARS].cumulative), low: compact(low[YEARS].cumulative) }),
    tip: (year) => {
      const p = typical[year]
      return year === 0
        ? [fmt(t('chart.tip.users'), { n: number(p.users) }), fmt(t('chart.tip.custodial'), { amount: compact(p.custodial) })]
        : [
            fmt(t('chart.tip.users'), { n: number(p.users) }),
            fmt(t('chart.tip.custodial'), { amount: compact(p.custodial) }),
            fmt(t('chart.tip.noncustodial'), { amount: compact(p.noncustodial) }),
            fmt(t('chart.tip.realised'), { amount: compact(p.realised) }),
            fmt(t('chart.tip.cumulative'), { amount: compact(p.cumulative) }),
          ]
    },
  })
  const end = typical[YEARS]
  draw(VERSUS, {
    series: [
      { key: 'custodial', cls: 'chart__line chart__line--custodial', marker: 'chart__marker chart__marker--custodial', points: typical.map((p) => p.custodial), markers: [0, 1, 2, 3, 4, 5] },
      { key: 'path', cls: 'chart__line', marker: 'chart__marker', points: typical.map((p) => p.path), markers: [1, 2, 3, 4, 5] },
    ],
    band: ['custodial', 'path'],
    // No labels on the dots: the axes and the tooltip carry the numbers.
    labels: [],
    // The five-year figure, hero-sized, in the gap: the area it names.
    watermark: { year: 3.5, text: compact(end.cumulative), sub: t('chart.versus.band_sub') },
    title: fmt(t('chart.versus.aria'), { custodial: compact(end.custodial), noncustodial: compact(end.path), saving: compact(end.saving), total: compact(end.cumulative) }),
    // Two horizontal axes, named in a right-hand gutter: the runway in years
    // along the top, from the start of integration; projected users along the bottom.
    rows: [
      { at: 'top', name: t('chart.versus.runway'), values: (year) => (year === 0 ? t('chart.versus.start') : fmt(t('chart.year'), { n: year })) },
      { at: 'bottom', name: t('chart.versus.users'), values: (year) => compactNumber(typical[year].users) },
    ],
    tip: (year) => {
      const p = typical[year]
      return [
        fmt(t('chart.versus.tip_custody'), { amount: compact(p.custodial) }),
        fmt(t('chart.versus.tip_nostr'), { amount: compact(p.path) }),
        fmt(t('chart.versus.tip_cumulative'), { amount: compact(p.cumulative) }),
      ]
    },
  })
}

function draw(id, spec) {
  const svg = document.getElementById(id)
  if (!svg) return
  const width = Math.max(280, Math.round(svg.getBoundingClientRect().width || svg.parentElement?.clientWidth || 640))
  const height = width < 520 ? HEIGHT.narrow : HEIGHT.wide
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('height', String(height))
  while (svg.lastChild && svg.lastChild.tagName !== 'title') svg.removeChild(svg.lastChild)

  const top = Math.max(1, ...spec.series.flatMap((s) => s.points))
  const right = spec.rows ? GUTTER : PAD.right
  const plotW = width - PAD.left - right
  const plotH = height - PAD.top - PAD.bottom
  const x = (year) => PAD.left + (plotW * year) / YEARS
  const y = (value) => PAD.top + plotH - (plotH * Math.max(0, value)) / top
  const by = Object.fromEntries(spec.series.map((s) => [s.key, s.points]))
  const at = (key, year) => (key === 'gap' ? (y(by[spec.band[0]][year]) + y(by[spec.band[1]][year])) / 2 : y(by[key][year]))

  // The grid: three quiet lines and the baseline, labelled in compact money.
  const grid = node('g', { class: 'chart__grid' })
  const axis = node('g', { class: 'chart__axis' })
  for (let i = 0; i <= 3; i++) {
    const value = (top * i) / 3
    grid.append(node('line', { x1: PAD.left, x2: width - right, y1: y(value), y2: y(value), class: i === 0 ? 'chart__baseline' : null }))
    if (i > 0) axis.append(node('text', { x: PAD.left - 8, y: y(value) + 4, 'text-anchor': 'end' }, [compact(value)]))
  }
  // Every year at full width; on a phone only the start and the end, plus
  // the marked year where a row is short enough to fit it.
  const narrow = width < 520
  const rows = spec.rows || [{ at: 'bottom', values: (year) => (year === 0 ? t('chart.today') : fmt(t('chart.year'), { n: year })) }]
  for (const row of rows) {
    const g = node('g', { class: `chart__axis chart__axis--${row.at}` })
    const baseline = row.at === 'top' ? PAD.top - 18 : height - 8
    const ticks = narrow ? (spec.rows ? [0, YEARS] : [0, MARKER_YEAR, YEARS]) : [0, 1, 2, 3, 4, 5]
    for (const year of ticks) {
      g.append(node('text', { x: x(year), y: baseline, 'text-anchor': year === 0 ? 'start' : year === YEARS ? 'end' : 'middle' }, [row.values(year)]))
    }
    if (row.name) g.append(node('text', { x: width - right + 14, y: baseline, 'text-anchor': 'start', class: 'chart__axis-name' }, [row.name]))
    axis.append(g)
  }

  const pts = (points) => points.map((v, year) => `${x(year).toFixed(1)},${y(v).toFixed(1)}`)
  // Along the upper edge, then back along the lower one (reversed after placing, so x stays with its year).
  const band = node('path', { class: 'chart__band', d: `M${pts(by[spec.band[0]]).join('L')}L${pts(by[spec.band[1]]).reverse().join('L')}Z` })
  const lines = node('g')
  const marks = node('g', { class: 'chart__marks' })
  for (const s of spec.series) {
    lines.append(node('polyline', { class: s.cls, points: pts(s.points).join(' ') }))
    for (const year of s.markers || []) marks.append(node('circle', { class: s.marker || 'chart__marker', cx: x(year), cy: y(s.points[year]), r: 5 }))
  }
  // Labels sit above-left (or below-left) of their point so they clear the
  // rising lines; one inside the band is left out when the band is too thin.
  for (const l of spec.labels) {
    if (l.minGap && Math.abs(y(by[spec.band[0]][l.year]) - y(by[spec.band[1]][l.year])) < l.minGap) continue
    marks.append(node('text', { class: l.cls, x: x(l.year) + (l.dx ?? -8), y: at(l.key, l.year) + l.dy, 'text-anchor': l.anchor || 'end' }, [l.text]))
  }

  if (spec.watermark) {
    // Centred between the two lines, part-way between two years, so it sits in the open jaw.
    const w = spec.watermark
    const lerp = (key) => {
      const a = Math.floor(w.year)
      const f = w.year - a
      return y(by[key][a]) * (1 - f) + y(by[key][Math.min(YEARS, a + 1)]) * f
    }
    const mid = (lerp(spec.band[0]) + lerp(spec.band[1])) / 2
    marks.append(node('text', { class: 'chart__watermark', x: x(w.year), y: mid + (narrow ? 8 : 10), 'text-anchor': 'middle' }, [w.text]))
    marks.append(node('text', { class: 'chart__watermark-sub', x: x(w.year), y: mid + (narrow ? 26 : 32), 'text-anchor': 'middle' }, [w.sub]))
  }

  // The hover layer: a crosshair per year and a hit area wider than the mark.
  const hover = node('g', { class: 'chart__hover' })
  const cross = node('line', { class: 'chart__cross', y1: PAD.top, y2: PAD.top + plotH, x1: 0, x2: 0, hidden: '' })
  hover.append(cross)
  for (const s of spec.series) hover.append(node('circle', { class: 'chart__dot', 'data-key': s.key, r: 6, hidden: '' }))
  const hits = node('g', { class: 'chart__hits' })
  const step = plotW / YEARS
  for (let year = 0; year <= YEARS; year++) {
    const rect = node('rect', { class: 'chart__hit', x: x(year) - step / 2, y: PAD.top, width: step, height: plotH, 'data-year': year })
    rect.addEventListener('pointerenter', () => focusYear(id, year))
    hits.append(rect)
  }

  svg.append(grid, band, lines, axis, marks, hover, hits)
  const title = svg.querySelector('title')
  if (title) title.textContent = spec.title
  charts.set(id, { spec, layout: { x, y, width, height, by }, active: null })
  hideTip(id)
}

function focusYear(id, year) {
  const chart = charts.get(id)
  const svg = document.getElementById(id)
  const tip = document.getElementById(`tip-${id}`)
  if (!chart || !svg || !tip) return
  chart.active = year
  const { x, y, by, width, height } = chart.layout
  const cross = svg.querySelector('.chart__cross')
  cross.setAttribute('x1', x(year))
  cross.setAttribute('x2', x(year))
  cross.removeAttribute('hidden')
  let anchor = 0
  for (const dot of svg.querySelectorAll('.chart__dot')) {
    const v = by[dot.dataset.key][year]
    dot.setAttribute('cx', x(year))
    dot.setAttribute('cy', y(v))
    dot.removeAttribute('hidden')
    anchor = Math.max(anchor, v)
  }

  tip.replaceChildren()
  const head = document.createElement('b')
  head.textContent = year === 0 ? t('chart.today') : fmt(t('chart.year'), { n: year })
  tip.append(head)
  for (const text of chart.spec.tip(year)) {
    const row = document.createElement('span')
    row.textContent = text
    tip.append(row)
  }
  tip.hidden = false
  // Beside the year at the topmost point, flipped to the left near the right edge.
  const box = svg.getBoundingClientRect()
  tip.style.setProperty('--tip-x', `${(x(year) / width) * box.width}px`)
  tip.style.setProperty('--tip-y', `${(y(anchor) / height) * box.height}px`)
  tip.classList.toggle('is-flipped', x(year) > width * 0.6)
}

function hideTip(id) {
  const chart = charts.get(id)
  const svg = document.getElementById(id)
  const tip = document.getElementById(`tip-${id}`)
  if (chart) chart.active = null
  if (tip) tip.hidden = true
  svg?.querySelector('.chart__cross')?.setAttribute('hidden', '')
  for (const dot of svg?.querySelectorAll('.chart__dot') || []) dot.setAttribute('hidden', '')
}

/** Once: redraw on resize (including the tab becoming visible), and the keyboard path. */
export function wireCharts() {
  let timer = null
  const redraw = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const shown = [CUMULATIVE, VERSUS].map((id) => document.getElementById(id)).find(Boolean)
      if (last && shown && shown.getBoundingClientRect().width > 0) drawCharts(last)
    }, 80)
  }
  let observed = false
  for (const id of [CUMULATIVE, VERSUS]) {
    const svg = document.getElementById(id)
    if (!svg) continue
    svg.addEventListener('pointerleave', () => hideTip(id))
    svg.addEventListener('blur', () => hideTip(id))
    svg.addEventListener('keydown', (e) => {
      const active = charts.get(id)?.active
      if (e.key === 'ArrowRight') focusYear(id, Math.min(YEARS, (active ?? -1) + 1))
      else if (e.key === 'ArrowLeft') focusYear(id, Math.max(0, (active ?? YEARS + 1) - 1))
      else if (e.key === 'Escape') hideTip(id)
      else return
      e.preventDefault()
    })
    if (!observed && 'ResizeObserver' in window) {
      new ResizeObserver(redraw).observe(svg.parentElement)
      observed = true
    }
  }
  if (!observed) window.addEventListener('resize', redraw)
}
