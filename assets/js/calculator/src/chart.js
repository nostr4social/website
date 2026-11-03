// The cost picture, drawn as inline SVG by one small line-chart routine:
//
//   chart-custodial-cost-vs-nostr   the cost of custody a year and the cost
//                                   of the same app if it ran on Nostr, six
//                                   points each: today, then today plus one
//                                   to five years, every one the annualized
//                                   run-rate at that instant. The filled gap
//                                   is the saving the network delivers. A
//                                   dotted edge runs from today's custody
//                                   dot down to the Nostr line at the end of
//                                   the integration and payback window; the
//                                   gap to its left, against the Nostr line,
//                                   is hatched and lighter: the wedge, which
//                                   carries no number. A gold rule between
//                                   the lines, with a gold dot on each, marks
//                                   the instant the headline is read; the
//                                   gold figure beside it is its length.
//                                   Years run along the top as Today and
//                                   Year 1 to 5; users along the bottom,
//                                   first and last.
//
// Each is drawn at its figure's own pixel width so text stays readable at
// every size, and redrawn when that width changes. The year-by-year table
// beside it is the reading for anyone the picture does not serve. Nothing
// here is cumulative: every figure is a run-rate at an instant.

import { $ } from '../../shared/src/dom.js'
import { fmt, t } from '../../shared/src/config.js'
import { approx, compact, compactNumber, number } from './format.js'
import { YEARS } from './model.js'

const NS = 'http://www.w3.org/2000/svg'
const PAD = { top: 44, right: 20, bottom: 30, left: 64 }
const HEIGHT = { wide: 300, narrow: 240 }

export const VERSUS = 'chart-custodial-cost-vs-nostr'

const charts = new Map() // id → { spec, layout, active }
let last = null // what was last drawn, for a redraw

/** "Today", else "Year n". */
export function yearLabel(year) {
  return year === 0 ? t('chart.today') : fmt(t('chart.year'), { n: year })
}

function node(name, attrs = {}, children = []) {
  const n = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v))
  for (const c of children) n.append(c)
  return n
}

/** The y of a piecewise-linear series {x, y}[] at any x. */
function valueAt(points, x) {
  if (x <= points[0].x) return points[0].y
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i].x) {
      const a = points[i - 1]
      const b = points[i]
      return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x)
    }
  }
  return points[points.length - 1].y
}

/** The series between two xs, with its ends interpolated, as {x, y}[]. */
function slice(points, from, to) {
  const inner = points.filter((p) => p.x > from && p.x < to)
  return [{ x: from, y: valueAt(points, from) }, ...inner, { x: to, y: valueAt(points, to) }]
}

/**
 * Draw (or redraw) the picture for one result:
 *   { projection, markers, headline: { text, sub }, title }
 * where projection is the typical scenario's six points and markers its
 * markers (payback, estimated), straight from the model; the network's date
 * is in the caption, not on the picture.
 */
export function drawCharts(input) {
  last = input
  if (!input) return
  const { projection, markers, headline } = input
  // Each line passes through its six year dots and through the marker
  // instants, so a marker sits exactly on the drawn line.
  const instants = [...projection.map((p) => p), markers.payback.point, markers.estimated.point]
    .filter(Boolean)
    .filter((p) => p.year <= YEARS)
    .sort((a, b) => a.year - b.year)
  const dedup = instants.filter((p, i) => i === 0 || p.year !== instants[i - 1].year)
  const series = (key) => dedup.map((p) => ({ x: p.year, y: p[key] }))
  const estimatedX = Math.min(YEARS, markers.estimated.months / 12)
  const paybackX = Math.min(YEARS, markers.payback.months / 12)
  draw(VERSUS, {
    series: [
      { key: 'custodial', cls: 'chart__line chart__line--custodial', marker: 'chart__marker chart__marker--custodial', points: series('custodial') },
      { key: 'nostr', cls: 'chart__line', marker: 'chart__marker', points: series('nostr') },
    ],
    band: ['custodial', 'nostr'],
    // The integration wedge: from today's custody dot to the Nostr line at
    // the end of the payback window. No figure on it, nothing summed into it.
    wedge: paybackX > 0 ? { to: paybackX, label: t('chart.wedge') } : null,
    // The estimated-savings instant: a gold rule from line to line, a gold
    // dot on each, and beside it, hero-sized and gold, its length.
    rule: { x: estimatedX, text: headline.text, sub: headline.sub },
    title: input.title,
    rows: [
      { at: 'top', values: (year) => yearLabel(year) },
      { at: 'bottom', ends: true, middle: t('chart.versus.users'), values: (year) => compactNumber(projection[year].users) },
    ],
    tip: (year) => {
      const p = projection[year]
      return [
        fmt(t('chart.tip.users'), { n: number(p.users) }),
        fmt(t('chart.versus.tip_custody'), { amount: compact(p.custodial) }),
        fmt(t(year === 0 ? 'chart.versus.tip_nostr_today' : 'chart.versus.tip_nostr'), { amount: compact(p.nostr) }),
        fmt(t('chart.versus.tip_saving'), { amount: compact(p.realised) }),
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

  const all = spec.series.flatMap((s) => s.points.map((p) => p.y))
  const top = Math.max(1, ...all)
  const bottom = Math.min(0, ...all)
  const right = PAD.right
  const plotW = width - PAD.left - right
  const plotH = height - PAD.top - PAD.bottom
  const x = (year) => PAD.left + (plotW * year) / YEARS
  const y = (value) => PAD.top + plotH - (plotH * (value - bottom)) / (top - bottom)
  const by = Object.fromEntries(spec.series.map((s) => [s.key, s.points]))
  const at = (key, year) => valueAt(by[key], year)
  const px = (p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`

  // The grid: three quiet lines and the baseline, labelled in compact money.
  const grid = node('g', { class: 'chart__grid' })
  const axis = node('g', { class: 'chart__axis' })
  for (let i = 0; i <= 3; i++) {
    const value = bottom + ((top - bottom) * i) / 3
    grid.append(node('line', { x1: PAD.left, x2: width - right, y1: y(value), y2: y(value), class: i === 0 ? 'chart__baseline' : null }))
    if (i > 0) axis.append(node('text', { x: PAD.left - 8, y: y(value) + 4, 'text-anchor': 'end' }, [compact(value)]))
  }
  // Every year at full width; on a phone today, the middle and the end. A
  // row marked `ends` shows only its first and last value, with the axis
  // named between them.
  const narrow = width < 520
  for (const row of spec.rows) {
    const g = node('g', { class: `chart__axis chart__axis--${row.at}` })
    const baseline = row.at === 'top' ? PAD.top - 18 : height - 8
    const ticks = row.ends ? [0, YEARS] : narrow ? [0, Math.round(YEARS / 2), YEARS] : [0, 1, 2, 3, 4, 5]
    for (const year of ticks) {
      g.append(node('text', { x: x(year), y: baseline, 'text-anchor': year === 0 ? 'start' : year === YEARS ? 'end' : 'middle' }, [row.values(year)]))
    }
    if (row.middle) g.append(node('text', { x: x(YEARS / 2), y: baseline, 'text-anchor': 'middle', class: 'chart__axis-name' }, [row.middle]))
    axis.append(g)
  }

  const [upperKey, lowerKey] = spec.band
  const upper = by[upperKey]
  const lower = by[lowerKey]
  const fills = node('g', { class: 'chart__fills' })
  const lines = node('g')
  const marks = node('g', { class: 'chart__marks' })
  const polygon = (cls, pts) => node('path', { class: cls, d: `M${pts.map(px).join('L')}Z` })
  if (spec.wedge) {
    const to = spec.wedge.to
    const start = { x: 0, y: upper[0].y }
    const end = { x: to, y: valueAt(lower, to) }
    // The dotted edge runs from today's custody dot down to the Nostr line
    // at the window's end. The wedge is the gap to its left: from today's
    // dot straight down the edge to the Nostr line, and back along the
    // Nostr line to today. Hatched, so it reads as a different thing from
    // the saving, and lighter.
    const hatch = `wedge-hatch-${id}`
    const defs = node('defs', {}, [
      node('pattern', { id: hatch, patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' }, [
        node('rect', { class: 'chart__hatch-bg', width: 6, height: 6 }),
        node('line', { class: 'chart__hatch-line', x1: 0, y1: 0, x2: 0, y2: 6 }),
      ]),
    ])
    fills.append(defs)
    const wedge = polygon('chart__wedge', [start, end, ...slice(lower, 0, to).reverse().slice(1)])
    wedge.setAttribute('fill', `url(#${hatch})`)
    fills.append(wedge)
    // The saving: the gap above the dotted edge up to the window's end, then
    // the whole gap after it.
    fills.append(polygon('chart__band', [...slice(upper, 0, to), end]))
    if (to < YEARS) fills.append(polygon('chart__band', [...slice(upper, to, YEARS), ...slice(lower, to, YEARS).reverse()]))
    lines.append(node('line', { class: 'chart__ramp', x1: x(0), y1: y(start.y), x2: x(to), y2: y(end.y) }))
    // Its name inside the hatched area, set like the headline's name but in
    // the Nostr line's colour, laid along the dotted edge just inside it:
    // rotated to the edge's slope, starting a little way along it, offset
    // into the area by a little more than the text's height.
    const ex1 = x(0)
    const ey1 = y(start.y)
    const ex2 = x(to)
    const ey2 = y(end.y)
    const len = Math.hypot(ex2 - ex1, ey2 - ey1) || 1
    const ux = (ex2 - ex1) / len
    const uy = (ey2 - ey1) / len
    const along = narrow ? 0.04 : 0.06
    const inward = narrow ? 15 : 18
    const lx = ex1 + ux * len * along - uy * inward
    const ly = ey1 + uy * len * along + ux * inward
    const angle = (Math.atan2(ey2 - ey1, ex2 - ex1) * 180) / Math.PI
    const label = node('text', { class: 'chart__wedge-label', x: lx, y: ly, 'text-anchor': 'start', transform: `rotate(${angle.toFixed(2)} ${lx.toFixed(1)} ${ly.toFixed(1)})` })
    // On a phone the words stack, still along the slope.
    const words = spec.wedge.label.split(' ')
    const rows = narrow && words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [spec.wedge.label]
    rows.forEach((row, i) => label.append(node('tspan', { x: lx, dy: i === 0 ? (rows.length > 1 ? -5 : 0) : 12 }, [row])))
    marks.append(label)
  } else {
    fills.append(polygon('chart__band', [...upper, ...[...lower].reverse()]))
  }
  for (const s of spec.series) {
    lines.append(node('polyline', { class: s.cls, points: s.points.map(px).join(' ') }))
    for (let year = 0; year <= YEARS; year++) marks.append(node('circle', { class: s.marker, cx: x(year), cy: y(at(s.key, year)), r: 5 }))
  }

  let watermarkFit = null // measured once the picture is in the page
  if (spec.rule) {
    const rx = spec.rule.x
    const ry1 = y(at(upperKey, rx))
    const ry2 = y(at(lowerKey, rx))
    const mid = (ry1 + ry2) / 2
    lines.append(node('line', { class: 'chart__scale-rule', x1: x(rx), x2: x(rx), y1: Math.min(ry1, ry2), y2: Math.max(ry1, ry2) }))
    marks.append(node('circle', { class: 'chart__marker chart__marker--scale', cx: x(rx), cy: ry1, r: 7 }))
    marks.append(node('circle', { class: 'chart__marker chart__marker--scale', cx: x(rx), cy: ry2, r: 7 }))
    // The figure to the right of the rule, centred on its middle; flipped to
    // the left when the rule stands near the right edge. On a phone the
    // figure is smaller and its name wraps onto two lines.
    const gap = narrow ? 12 : 16
    const flip = x(rx) > width * 0.72
    const left = flip ? x(rx) - gap : x(rx) + gap
    const anchor = flip ? 'end' : 'start'
    const figure = node('text', { class: 'chart__watermark', x: left, y: mid + (narrow ? 4 : 10), 'text-anchor': anchor }, [spec.rule.text])
    marks.append(figure)
    const words = spec.rule.sub.split(' ')
    const subLines = narrow && spec.rule.sub.length > 12 ? [words.slice(0, Math.ceil(words.length / 2)).join(' ') + ' ', words.slice(Math.ceil(words.length / 2)).join(' ')] : [spec.rule.sub]
    const sub = node('text', { class: 'chart__watermark-sub', x: left, y: mid + (narrow ? 20 : 32), 'text-anchor': anchor })
    subLines.forEach((line, i) => sub.append(node('tspan', { x: left, dy: i === 0 ? 0 : 14 }, [line])))
    marks.append(sub)
    watermarkFit = () => {
      let wide = 0
      try {
        wide = figure.getBBox().width
      } catch {
        wide = 0
      }
      const room = flip ? left - PAD.left - 4 : width - 4 - left
      if (!wide || wide <= room) return
      const size = parseFloat(getComputedStyle(figure).fontSize) || 36
      figure.style.fontSize = `${Math.max(20, Math.floor((size * room) / wide))}px`
    }
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

  svg.append(grid, fills, lines, axis, marks, hover, hits)
  watermarkFit?.()
  const title = svg.querySelector('title')
  if (title) title.textContent = spec.title
  charts.set(id, { spec, layout: { x, y, width, height, at }, active: null })
  hideTip(id)
}

function focusYear(id, year) {
  const chart = charts.get(id)
  const svg = document.getElementById(id)
  const tip = document.getElementById(`tip-${id}`)
  if (!chart || !svg || !tip) return
  chart.active = year
  const { x, y, at, width, height } = chart.layout
  const cross = svg.querySelector('.chart__cross')
  cross.setAttribute('x1', x(year))
  cross.setAttribute('x2', x(year))
  cross.removeAttribute('hidden')
  let anchor = 0
  for (const dot of svg.querySelectorAll('.chart__dot')) {
    const v = at(dot.dataset.key, year)
    dot.setAttribute('cx', x(year))
    dot.setAttribute('cy', y(v))
    dot.removeAttribute('hidden')
    anchor = Math.max(anchor, v)
  }

  tip.replaceChildren()
  const head = document.createElement('b')
  head.textContent = yearLabel(year)
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
      const shown = document.getElementById(VERSUS)
      if (last && shown && shown.getBoundingClientRect().width > 0) drawCharts(last)
    }, 80)
  }
  const svg = document.getElementById(VERSUS)
  if (!svg) return
  svg.addEventListener('pointerleave', () => hideTip(VERSUS))
  svg.addEventListener('blur', () => hideTip(VERSUS))
  svg.addEventListener('keydown', (e) => {
    const active = charts.get(VERSUS)?.active
    if (e.key === 'ArrowRight') focusYear(VERSUS, Math.min(YEARS, (active ?? -1) + 1))
    else if (e.key === 'ArrowLeft') focusYear(VERSUS, Math.max(0, (active ?? YEARS + 1) - 1))
    else if (e.key === 'Escape') hideTip(VERSUS)
    else return
    e.preventDefault()
  })
  if ('ResizeObserver' in window) new ResizeObserver(redraw).observe(svg.parentElement)
  else window.addEventListener('resize', redraw)
}

export { approx }
