// Browser end-to-end test for /calculator/. Drives real headless Chrome over
// the DevTools protocol, so this is the page as a visitor gets it — CSP,
// module loading, subresource integrity and all.
//
//   bundle exec jekyll serve          # or any static server on _site
//   npm run e2e:calculator            # defaults to http://127.0.0.1:4000
//
// SHOTS=dir writes screenshots of the results at 1440 and 390 wide into dir.

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { getPow } from 'nostr-tools/nip13'
import { withBrowser } from '../contact-bundle/cdp.mjs'
import { formAddress, KIND_RESPONSE, parseTemplate, readSnapshot, SNAPSHOT, snapshotYaml } from '../forms/lib.mjs'
import { fixtureTemplate, localRelay } from '../forms/fixture.mjs'

useWebSocketImplementation(WebSocket)
const PORT = 10547
const RELAY = `ws://127.0.0.1:${PORT}`

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000'
const SHOTS = process.env.SHOTS || ''
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const money = (s) => parseFloat(s.replace(/[^\d.]/g, '')) * (s.endsWith('M') ? 1e6 : s.endsWith('k') ? 1e3 : 1)

await withBrowser(async (api) => {
  const logs = []
  api.onEvent((m) => {
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(m.params.entry.text)
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('console.error')
  })
  const requests = []
  api.onEvent((m) => { if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url) })

  // ── a fresh page ──────────────────────────────────────────────────────────
  await api.goto(`${BASE}/calculator/`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  check('a fresh page opens on Estimated Cost with the defaults\' result', (await api.eval(`[...document.querySelectorAll('[role=tab]')].map(t => t.id + ':' + t.getAttribute('aria-selected')).join(' ') + ' ' + document.getElementById('calc-results').hidden + ' ' + document.querySelector('.chart__watermark').textContent`)).startsWith('tab-cost:true tab-app:false tab-assumptions:false false $'))
  const shareTitle = (await readSnapshot()).sections.find((sec) => sec.questions.includes('PgP68U')).title
  check('the Save & Share button is named by the form\'s section and sits outside the tabs', (await api.eval(`document.getElementById('save-open').textContent.trim() + ':' + document.getElementById('save-open').hidden + ':' + Boolean(document.querySelector('.tabbar #save-open'))`)) === `${shareTitle}:false:true`, shareTitle)
  const names = await api.eval(`[...document.querySelectorAll('#save-modal [name]')].map(i => i.name).join(' ') + ' | ' + [...document.querySelectorAll('#calc-form .group__legend')].map(l => l.textContent.trim().replace(/^\\d+/, '')).join(', ')`)
  check('the modal holds the section\'s questions, plus the test box, and no section of that name is on the tab', names === 'email consent contact_name company app_name test | Nostr, Users, Content, Moderation, Team, Payments, Reach', names)
  const testBox = await api.eval(`(() => { const box = document.getElementById('f-test'); const label = box.closest('label'); return { checked: box.checked, form: box.getAttribute('form'), text: label.textContent.trim(), title: label.title, beside: label.previousElementSibling?.id, row: label.parentElement.className } })()`)
  check('the test checkbox sits beside Send, on while calculator_mode is test, in the form\'s own words', testBox.checked && testBox.form === 'calc-form' && testBox.text === 'test' && testBox.title.startsWith('test submission') && testBox.beside === 'save-submit' && testBox.row === 'modal__send' && testBox.row !== 'modal__actions', JSON.stringify(testBox))
  const first = await api.eval(`({
    whose: document.getElementById('r-whose-text').textContent, link: document.getElementById('r-whose-link').textContent,
    hero: document.querySelector('#chart-custodial-cost-vs-nostr .chart__watermark').textContent, sub: document.querySelector('#chart-custodial-cost-vs-nostr .chart__watermark-sub').textContent,
    gold: getComputedStyle(document.querySelector('#panel-cost .chart')).borderLeftWidth, heroCard: Boolean(document.querySelector('.savings__hero')),
    lines: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr polyline')].map(p => p.getAttribute('class') + ':' + p.getAttribute('points').split(' ').length),
    starts: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr polyline')].map(p => p.getAttribute('points').split(' ')[0]),
    yearDots: document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__marker:not(.chart__marker--scale)').length,
    mature: document.querySelector('#chart-custodial-cost-vs-nostr .chart__marker--mature, #chart-custodial-cost-vs-nostr .chart__mature-label') !== null,
    labels: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__marks text')].map(t => t.textContent),
    legend: [...document.querySelectorAll('#panel-cost .legend--chart .legend__item')].map(l => l.textContent.trim()),
    title: document.getElementById('chart-custodial-cost-vs-nostr-title').textContent,
    cumulative: Boolean(document.getElementById('chart-cumulative-savings')),
    top: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__axis--top text')].map(t => t.textContent),
    bottom: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__axis--bottom text')].map(t => t.textContent),
    years: document.querySelectorAll('#r-years thead th[data-year]').length,
    yearOne: document.querySelector('#r-years thead th[data-year]').textContent,
    yearHeads: [...document.querySelectorAll('#r-years thead th[data-year]')].map(t => t.textContent).join(' | '),
    measures: [...document.querySelectorAll('#r-years tbody th')].map(t => t.textContent).join(' | '),
    cells: document.querySelectorAll('#r-years tbody td').length,
    width: document.getElementById('chart-custodial-cost-vs-nostr').getAttribute('viewBox').split(' ')[2] + ':' + Math.round(document.getElementById('chart-custodial-cost-vs-nostr').getBoundingClientRect().width),
    text: document.getElementById('panel-cost').textContent,
  })`)
  check('a fresh page says whose estimate it shows, describes the app section by section, and invites the visitor in', first.whose.startsWith('Estimated for') && first.whose.includes('50,000') && first.whose.includes('the US') && first.whose.endsWith('.') && first.link === 'Customize App Details', `${first.whose} / ${first.link}`)
  const bar = await api.eval(`({ illustrative: document.getElementById('tabbar').classList.contains('is-illustrative'), ring: getComputedStyle(document.getElementById('tab-app')).boxShadow, gold: getComputedStyle(document.getElementById('tab-app')).color !== getComputedStyle(document.getElementById('tab-cost')).color, share: document.getElementById('save-open').className, sticky: getComputedStyle(document.getElementById('tabbar')).position, quiet: parseFloat(getComputedStyle(document.getElementById('tab-assumptions')).fontSize) < parseFloat(getComputedStyle(document.getElementById('tab-cost')).fontSize) })`)
  check('on a fresh page App Details is gold with no ring, Send & Share is outlined, the bar sticks, Assumptions is the quiet tab', bar.illustrative && bar.ring === 'none' && bar.gold && bar.share.includes('btn--secondary') && bar.sticky === 'sticky' && bar.quiet, JSON.stringify(bar))
  check('the pieces the openers assumed are drawn quiet, the given ones bright (the team size, the growth and the payment volume among them), and the link is gold', (await api.eval(`document.querySelectorAll('#r-whose-text .whose__fact--assumed').length + ':' + document.querySelectorAll('#r-whose-text .whose__fact:not(.whose__fact--assumed)').length + ':' + getComputedStyle(document.getElementById('r-whose-link')).color`)) === `2:6:${await api.eval(`getComputedStyle(document.getElementById('tab-app')).color`)}`)
  check('the frame names the growth band after the user count', first.whose.includes('has 50,000 active users growing about 50% a year, with a team of up to 10'), first.whose)
  check('for the bitcoiners: the illustrative app, a messaging app in the US growing fast, saves $210k a year, a rounded headline (two significant figures, never a figure like $292,469)', first.hero === '$210k' && first.whose.startsWith('Estimated for a messaging app in the US'), `${first.hero} | ${first.whose}`)
  check('the illustrative app facilitates $5k a month, so the payments line shows a saving on a fresh page', first.whose.includes('facilitates $5k a month') && /^\$[\d.]+[kM]?$/.test(await api.eval(`document.querySelector('.lt-row[data-line="payments"] .lt-saving').textContent`)) && (await api.eval(`document.querySelector('.lt-row[data-line="payments"] .lt-flag--none').hidden`)), first.whose)
  const headless = await api.eval(`({ next: document.querySelector('.results__head').nextElementSibling.className, text: document.getElementById('panel-cost').textContent })`)
  check('the results head is the title and the whose line, then the picture; the headline is the gold watermark at the estimated-savings instant, named without a year, and nothing on the tab estimates integration cost, a payback or a cumulative', first.sub === 'Estimated savings' && !first.heroCard && first.gold !== '1px' && headless.next === 'results__view' && !/payback month|pays back|person-weeks|overlap|cumulative|over five years|\b20[2-4]\d\b/i.test(headless.text.replace(/20\d\d-\d\d-\d\d/g, '')), `${first.hero} / ${first.sub} / rail ${first.gold} / ${headless.next}`)
  const goldMark = await api.eval(`getComputedStyle(document.querySelector('.chart__watermark')).fill === getComputedStyle(document.querySelector('.chart__marker--scale')).fill && getComputedStyle(document.querySelector('.chart__scale-rule')).stroke === getComputedStyle(document.querySelector('.chart__marker--scale')).fill && parseFloat(getComputedStyle(document.querySelector('.chart__watermark')).fontSize) >= 48`)
  check('the watermark is gold, like the two dots and the rule between them, and hero-sized', goldMark)
  const startGap = first.starts.map(p => p.split(',').map(Number))
  check('the one chart has a custody line and a Nostr line through the six year dots and the marker instants, starting apart: the Nostr line below custody today, a real number', first.lines.length === 2 && first.lines[0].startsWith('chart__line chart__line--custodial:') && first.lines[1].startsWith('chart__line:') && startGap[0][0] === startGap[1][0] && startGap[1][1] > startGap[0][1] + 10 && !first.cumulative, `${first.lines.join(' ')} ${first.starts.join(' ')}`)
  check('six dots on each line, the two gold ones, and three labels: the integration window, the figure and its name; no network-mature dot on the picture', first.yearDots === 12 && first.labels.length === 3 && first.labels[0] === 'integration window' && first.labels[1] === first.hero && first.labels[2] === first.sub && !first.mature, `${first.yearDots} | ${first.labels.join(' | ')}`)
  const marks = await api.eval(`(() => {
    const svg = document.getElementById('chart-custodial-cost-vs-nostr')
    const pts = (i) => svg.querySelectorAll('polyline')[i].getAttribute('points').split(' ').map(p => p.split(',').map(Number))
    const yAt = (line, x) => { for (let i = 1; i < line.length; i++) if (x <= line[i][0] + 0.01) { const [a, b] = [line[i - 1], line[i]]; return b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]) } return line[line.length - 1][1] }
    const near = (a, b) => Math.abs(a - b) < 0.8
    const custody = pts(0), nostr = pts(1)
    const years = [...svg.querySelectorAll('.chart__axis--top text')].map(t => +t.getAttribute('x'))
    const dots = [...svg.querySelectorAll('.chart__marker--scale')].map(d => [+d.getAttribute('cx'), +d.getAttribute('cy')])
    const rule = svg.querySelector('.chart__scale-rule')
    const text = svg.querySelector('.chart__watermark')
    const ramp = svg.querySelector('.chart__ramp')
    const wedge = svg.querySelector('.chart__wedge'), bands = svg.querySelectorAll('.chart__band')
    const op = (n) => parseFloat(getComputedStyle(n).fillOpacity)
    return {
      ruleAtYear3: rule && near(+rule.getAttribute('x1'), years[3]) && rule.getAttribute('x1') === rule.getAttribute('x2'),
      ruleSpans: rule && near(+rule.getAttribute('y1'), yAt(custody, years[3])) && near(+rule.getAttribute('y2'), yAt(nostr, years[3])),
      dotsOnLines: dots.length === 2 && near(dots[0][1], yAt(custody, dots[0][0])) && near(dots[1][1], yAt(nostr, dots[1][0])) && dots.every(d => near(d[0], years[3])),
      right: text && +text.getAttribute('x') > years[3] && text.getAttribute('text-anchor') === 'start',
      rampFromCustodyToday: ramp && near(+ramp.getAttribute('x1'), custody[0][0]) && near(+ramp.getAttribute('y1'), custody[0][1]),
      rampToNostrAtYear2: ramp && near(+ramp.getAttribute('x2'), years[2]) && near(+ramp.getAttribute('y2'), yAt(nostr, years[2])),
      dashed: ramp && getComputedStyle(ramp).strokeDasharray !== 'none', rampStroke: ramp && getComputedStyle(ramp).stroke, nostrStroke: getComputedStyle(svg.querySelector('.chart__line:not(.chart__line--custodial)')).stroke,
      wedgeLabel: (() => { const l = svg.querySelector('.chart__wedge-label'); const sub = getComputedStyle(svg.querySelector('.chart__watermark-sub')); const cs = getComputedStyle(l); const lx = +l.getAttribute('x'), ly = +l.getAttribute('y'); const r = svg.querySelector('.chart__ramp'); const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(k => +r.getAttribute(k)); const edgeY = y1 + (y2 - y1) * (lx - x1) / (x2 - x1); const slope = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI; const m = (l.getAttribute('transform') || '').match(/^rotate\\(([-\\d.]+) /); return l && l.textContent === 'integration window' && lx > years[0] && lx < years[1] && ly > edgeY + 8 && ly < yAt(nostr, lx) && m && Math.abs(+m[1] - slope) < 0.1 && cs.fill === getComputedStyle(svg.querySelector('.chart__line:not(.chart__line--custodial)')).stroke && cs.textTransform === sub.textTransform && cs.fontSize === sub.fontSize && cs.letterSpacing === sub.letterSpacing })(),
      wedgeHatched: wedge && bands.length === 2 && getComputedStyle(wedge).fill.startsWith('url(') && svg.querySelector('pattern .chart__hatch-line') !== null && parseFloat(getComputedStyle(svg.querySelector('pattern .chart__hatch-bg')).fillOpacity) < op(bands[0]),
      wedgeBox: wedge && wedge.getBBox().x + wedge.getBBox().width <= years[2] + 1 && wedge.getBBox().y + wedge.getBBox().height >= yAt(nostr, years[0]) - 2 && wedge.getBBox().y >= yAt(custody, years[0]) - 1,
      bandAboveEdge: bands[0].getBBox().y <= yAt(custody, years[0]) + 1 && bands[0].getBBox().y + bands[0].getBBox().height <= yAt(nostr, years[2]) + 1,
      dotFill: getComputedStyle(svg.querySelector('.chart__marker--custodial')).fill, lineStroke: getComputedStyle(svg.querySelector('.chart__line--custodial')).stroke,
      nostrDotFill: getComputedStyle(svg.querySelector('.chart__marker:not(.chart__marker--custodial):not(.chart__marker--scale)')).fill,
    }
  })()`)
  check('at the estimated-savings instant (month 36: year three) a gold dot sits on each line, a gold rule joins them, and the figure stands to its right', marks.ruleAtYear3 && marks.ruleSpans && marks.dotsOnLines && marks.right, JSON.stringify(marks))
  check('the integration wedge: a dotted edge in the Nostr line\'s colour from today\'s custody dot to the Nostr line at the end of the payback window (year two); the gap left of it, against the Nostr line, hatched and lighter than the saving above the edge', marks.rampFromCustodyToday && marks.rampToNostrAtYear2 && marks.dashed && marks.rampStroke === marks.nostrStroke && marks.wedgeHatched && marks.wedgeBox && marks.bandAboveEdge && marks.wedgeLabel, JSON.stringify(marks))
  check('the custody line\'s dots are the colour of the custody line, the Nostr dots the colour of the Nostr line', marks.dotFill === marks.lineStroke && marks.nostrDotFill === marks.nostrStroke && marks.dotFill !== marks.nostrDotFill, `${marks.dotFill} vs ${marks.lineStroke} | ${marks.nostrDotFill} vs ${marks.nostrStroke}`)
  check('the legend names the two lines in the page\'s words', first.legend.join(' / ') === 'Cost of Custody / Cost of Nostr', first.legend.join(' / '))
  check('the picture carries its small title at the top left, saying what it shows, with the legend just under it', (await api.eval(`document.querySelector('#panel-cost .chart > .chart__title').textContent + ':' + document.querySelector('#panel-cost .chart > .chart__title').nextElementSibling.className`)) === "Your app's yearly cost: as it runs today, and if it ran on Nostr:legend legend--chart")
  check('the chart is described by its dots and markers, with no cumulative, and the year-by-year table runs Today and Year 1 to 5 across with four measures down', /^Today custody costs \$[\d.]+[kM] a year against \$[\d.]+[kM] if integrated today; in year five, \$[\d.]+[kM] against \$[\d.]+[kM]\. The hatched wedge is the two-year integration window\. The gold rule marks the estimated savings of \$[\d.]+[kM] a year in year three, one year after the window\.$/.test(first.title) && first.years === 6 && first.yearHeads === 'Today | Year 1 | Year 2 | Year 3 | Year 4 | Year 5' && first.measures === 'Active users | Cost of Custody | Cost of Nostr | Estimated Saving' && first.cells === 24, `${first.yearHeads} | ${first.measures} | ${first.cells} | ${first.title}`)
  const caption = await api.eval(`document.getElementById('caption-text-chart-custodial-cost-vs-nostr').textContent`)
  check('the caption says what the chart shows, that integration cost is not estimated but payback lands within the window, and where the gold rule reads, with every span derived as words and no network-maturity claim', caption === 'This chart shows the cost of custody for your app today, and the same app running on Nostr. The gap between the lines is the saving. Integration cost is not estimated here, but payback should land within the two-year integration window. The gold rule marks the estimated savings in year three, one year after the window.' && !/\{|mature/.test(caption), caption)
  const year0 = await api.eval(`(() => { const n = (row, i = 2) => Number(document.querySelector('#r-years tbody tr[data-row=' + row + '] td:nth-child(' + i + ')').textContent.replace(/[^\\d-]/g, '')); return { custodial: n('custodial'), nostr: n('nostr'), realised: n('realised'), y3: n('realised', 5) } })()`)
  check('today\'s column: the Nostr cost is a real number below custody and the saving is the gap; the year-three column is the headline', year0.nostr > 0 && year0.nostr < year0.custodial && Math.abs(year0.realised - (year0.custodial - year0.nostr)) <= 1 && Math.abs(year0.y3 - money(first.hero)) / year0.y3 < 0.06, JSON.stringify({ ...year0, hero: first.hero }))
  check('the chart is drawn at the figure\'s own width', first.width.split(':')[0] === first.width.split(':')[1], first.width)
  check('the years run along the top from today as the app\'s own: Today, Year 1 to Year 5, no calendar year anywhere', first.top.join(' | ') === 'Today | Year 1 | Year 2 | Year 3 | Year 4 | Year 5', first.top.join(' | '))
  check('projected users run along the bottom as first and last, the axis named between them; the illustrative app grows at Fast', first.bottom.join(' | ') === '50k | 185k | Active Users', first.bottom.join(' | '))
  check('the plot runs to the right edge', await api.eval(`(() => { const svg = document.getElementById('chart-custodial-cost-vs-nostr'); const w = svg.viewBox.baseVal.width; const last = [...svg.querySelectorAll('.chart__axis--top text')].pop(); return w - parseFloat(last.getAttribute('x')) < 30 })()`))
  await api.eval(`document.querySelector('#chart-custodial-cost-vs-nostr .chart__hit[data-year="3"]').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))`)
  const tip = await api.eval(`({ hidden: document.getElementById('tip-chart-custodial-cost-vs-nostr').hidden, text: document.getElementById('tip-chart-custodial-cost-vs-nostr').textContent, cross: document.querySelector('#chart-custodial-cost-vs-nostr .chart__cross').hasAttribute('hidden'), dots: document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__dot:not([hidden])').length })`)
  check('hovering a year shows a four-line tooltip headed by its year, users first, the saving that year last, crosshair and a dot on each line', !tip.hidden && !tip.cross && tip.dots === 2 && tip.text.startsWith('Year 3') && /Year 3[\d,]+ active users/.test(tip.text) && tip.text.includes('Cost of Custody') && tip.text.includes('Cost of Nostr') && tip.text.includes('Estimated saving') && !/cumulative/i.test(tip.text), tip.text)
  await api.eval(`document.querySelector('#chart-custodial-cost-vs-nostr .chart__hit[data-year="0"]').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))`)
  check('at Today the Nostr line\'s tooltip reads "if integrated today"', (await api.eval(`document.getElementById('tip-chart-custodial-cost-vs-nostr').textContent`)).includes('If integrated today'), await api.eval(`document.getElementById('tip-chart-custodial-cost-vs-nostr').textContent`))
  await api.eval(`document.getElementById('chart-custodial-cost-vs-nostr').dispatchEvent(new PointerEvent('pointerleave'))`)
  check('…and leaving hides it', await api.eval(`document.getElementById('tip-chart-custodial-cost-vs-nostr').hidden`))
  check('a fresh page loads at the top: nothing scrolls until a tab is pressed', (await api.eval(`window.scrollY`)) === 0, String(await api.eval(`window.scrollY`)))
  await api.eval(`document.getElementById('r-whose-link').click()`)
  check('Customize App Details opens App Info', (await api.eval(`document.getElementById('tab-app').getAttribute('aria-selected')`)) === 'true')
  await api.eval(`window.scrollTo(0, 2000)`)
  await api.eval(`document.getElementById('tab-app').click()`)
  await sleep(700)
  check('pressing a tab, even the open one, brings the bar to the top of the view', Math.abs(await api.eval(`document.getElementById('calc').getBoundingClientRect().top`)) < 4, String(await api.eval(`document.getElementById('calc').getBoundingClientRect().top`)))
  await api.eval(`document.getElementById('tab-cost').click()`)
  check('…without a results link in the address bar', (await api.eval(`location.search`)) === '')
  check('the other two panels are hidden', await api.eval(`document.getElementById('panel-assumptions').hidden && document.getElementById('panel-app').hidden && !document.getElementById('panel-cost').hidden`))
  await api.eval(`document.getElementById('tab-app').click()`)
  check('the form carries the published form\'s own words and not its title', (await api.eval(`(() => {
    const legends = [...document.querySelectorAll('#calc-form .group__legend')].map(l => l.textContent.trim().replace(/^\\d+/, ''))
    const title = document.querySelector('.calc-form__title')?.textContent.trim()
    const q = document.querySelector('label[for=f-mau]').textContent.replace(/\\s+/g, ' ').trim()
    return title + ' | ' + legends.join(', ') + ' | ' + q
  })()`)) === 'undefined | Nostr, Users, Content, Moderation, Team, Payments, Reach | How many Monthly Active Users (MAU)')
  check('the questions the page fills are not drawn; the test marker is, as the checkbox beside Send', await api.eval(`!document.querySelector('[name=link], [name=result_custodial], [name=version], [name=fees_saved]') && document.querySelector('#save-modal [name=test]') !== null`))
  check('the required choices start with their defaults', await api.eval(`(() => {
    const on = [...document.querySelectorAll('#calc-form input:checked')].map(i => i.name + '=' + i.value).sort().join(' ')
    return on
  })()`) === 'jur=us kind=messaging')
  check('every grid row, number and scale is a slider', (await api.eval(`document.querySelectorAll('input[type=range]').length`)) === 23)
  const openers = await api.eval(`(() => {
    const groups = [...document.querySelectorAll('#calc-form .group')]
    return {
      first: groups.map(g => g.querySelector('.group__fields [name]')?.name),
      folded: groups.map(g => g.querySelector('.group__more')?.hidden),
      toggles: groups.map(g => g.querySelector('.group__toggle')?.textContent),
      suggested: [...document.querySelectorAll('.slider-row.is-suggested input')].map(i => i.name).sort().join(' '),
      hint: getComputedStyle(document.querySelector('.slider-row.is-suggested .slider')).opacity,
      pills: [...document.querySelectorAll('.field--inline .choice')].length + ':' + getComputedStyle(document.querySelector('.field--inline .choice')).borderRadius,
      submit: getComputedStyle(document.querySelector('.calc-form__submit')).justifyContent,
      toggle: getComputedStyle(document.querySelector('.group__toggle')).color,
      gold: getComputedStyle(document.getElementById('tab-app')).color,
      scales: [...document.querySelectorAll('input[type=range][name=nostr_now], input[type=range][name=team], input[type=range][name=growth], input[type=range][name=mod_heads]')].map(i => i.name + ':' + i.dataset.labels.split('|').length),
      inline: [...document.querySelectorAll('.field--inline')].map(f => f.id),
      steps: [...document.querySelectorAll('.group__step')].map(e => e.textContent).join(''),
      intro: document.querySelector('#panel-app .panel__lede')?.textContent.trim().split(' ')[0],
      title: document.getElementById('app-title')?.textContent.trim() + ':' + Boolean(document.querySelector('#calc-form #app-title')),
    }
  })()`)
  check('each section opens with its opener, whatever order the event lists, and the rest fold under a toggle', openers.first.join(' ') === 'nostr_now mau kind mod_who team p2p_volume jur' && openers.folded.every(Boolean) && openers.toggles.every(t => t === 'Add more details'), `${openers.first.join(' ')} | ${openers.folded.join(' ')}`)
  check('the scale questions are sliders, the lists run inline, the cards are numbered', openers.scales.join(' ') === 'nostr_now:3 growth:4 mod_heads:6 team:4' && openers.inline.join(' ') === 'field-kind field-mod_who field-jur' && openers.steps === '1234567' && openers.intro === 'Seven' && openers.title === 'Your App Details:false', `${openers.scales.join(' ')} | ${openers.inline.join(' ')} | ${openers.steps}`)
  check('a suggested slider announces itself as a suggestion, not an answer, and an answered one by its band', (await api.eval(`document.querySelector('input[name=mb]').getAttribute('aria-valuetext') + ' | ' + document.querySelector('input[name=team]').getAttribute('aria-valuetext')`)) === 'Suggested: 5 MB | up to 10', await api.eval(`document.querySelector('input[name=mb]').getAttribute('aria-valuetext')`))
  check('the contact fields carry their autocomplete tokens', (await api.eval(`document.getElementById('f-contact_name').getAttribute('autocomplete') + ':' + document.getElementById('f-email').getAttribute('autocomplete') + ':' + document.getElementById('f-company').getAttribute('autocomplete')`)) === 'name:email:off')
  check('a fresh page shows the derived defaults as suggestions on the untouched sliders, openers included; the team size and growth are answers, not suggestions', openers.suggested === 'eng_accounts eng_content eng_infra eng_legal mb n_algos n_event_storage n_feeds n_keys n_labels n_media_storage n_nips n_p2p n_raw_keys n_signed_events nostr_now posts_per_user' && Number(openers.hint) < 1 && (await api.eval(`['team', 'growth'].map(n => { const s = document.querySelector('input[name=' + n + ']'); return s.dataset.touched + ':' + s.dataset.values.split(',')[s.value] }).join(' ')`)) === '1:ten 1:0.5', `${openers.suggested} | opacity ${openers.hint}`)
  check('the inline choices are pills, the toggle is gold, and Calculate sits right', openers.pills === '11:999px' && openers.toggle === openers.gold && openers.submit === 'space-between', `${openers.pills} | ${openers.toggle} vs ${openers.gold} | ${openers.submit}`)
  await api.eval(`document.querySelector('#calc-form .group__toggle').click()`)
  check('the toggle opens the section\'s details and renames itself', (await api.eval(`document.querySelector('#calc-form .group__more').hidden + ':' + document.querySelector('#calc-form .group__toggle').textContent`)) === 'false:Fewer details')
  if (SHOTS) {
    await api.eval(`document.querySelectorAll('#calc-form .group__toggle')[4].click()`)
    await snap(api, join(SHOTS, 'form-1440.png'))
  }
  // Choosing a kind on the form moves the section's suggestions and the estimate at once, without leaving the tab.
  const heroBeforeKind = await api.eval(`document.querySelector('.chart__watermark').textContent`)
  await api.eval(`document.querySelector('label.choice:has(input[name=kind][value=feed])').click()`)
  await sleep(400)
  const live = await api.eval(`({ tab: document.getElementById('tab-app').getAttribute('aria-selected'), mb: document.querySelector('input[name=mb]').dataset.values.split(',')[document.querySelector('input[name=mb]').value], suggested: document.querySelector('input[name=mb]').closest('.slider-row').classList.contains('is-suggested'), hero: document.querySelector('.chart__watermark').textContent, url: location.search })`)
  check('an opener moves its section\'s suggestions and the estimate live, on the form', live.tab === 'true' && live.mb === '500' && live.suggested && live.hero !== heroBeforeKind && live.url.includes('kind=feed') && !live.url.includes('mb='), JSON.stringify(live) + ' before ' + heroBeforeKind)
  // Reset Values: back to the start, folded, suggestions restored, link cleared.
  await api.eval(`document.getElementById('calc-reset').click()`)
  await sleep(300)
  const reset = await api.eval(`({ kind: document.querySelector('input[name=kind]:checked')?.value ?? null, mb: document.querySelector('input[name=mb]').dataset.values.split(',')[document.querySelector('input[name=mb]').value], suggested: document.querySelector('input[name=mb]').closest('.slider-row').classList.contains('is-suggested'), folded: [...document.querySelectorAll('#calc-form .group__more')].every(m => m.hidden), hero: document.querySelector('.chart__watermark').textContent, url: location.search, mau: document.querySelector('input[name=mau]').dataset.values.split(',')[document.querySelector('input[name=mau]').value], place: getComputedStyle(document.querySelector('.calc-form__submit')).justifyContent })`)
  check('Reset Values clears the answers, folds the sections, restores the suggestions and the illustrative estimate', reset.kind === 'messaging' && reset.mb === '5' && reset.suggested && reset.folded && reset.hero === heroBeforeKind && reset.url === '' && reset.mau === '50000' && reset.place === 'space-between', JSON.stringify(reset))
  await api.eval(`{ const s = document.querySelector('input[name=nostr_now]'); s.value = '2'; s.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('tab-cost').click() }`)
  await sleep(200)
  const nostrSuggested = await api.eval(`({ n: document.querySelectorAll('.slider-row.is-suggested input[name^=n_]').length, raw: document.querySelector('input[name=n_raw_keys]').dataset.values.split(',')[document.querySelector('input[name=n_raw_keys]').value], keys: document.querySelector('input[name=n_keys]').dataset.values.split(',')[document.querySelector('input[name=n_keys]').value], url: location.search })`)
  check('answering the Nostr opener suggests the whole grid, raw keys excepted, without putting it in the link', nostrSuggested.n === 10 && nostrSuggested.keys === '1' && nostrSuggested.raw === '0' && nostrSuggested.url.includes('nostr_now=1') && !nostrSuggested.url.includes('n_keys='), JSON.stringify(nostrSuggested))
  await api.eval(`{ document.getElementById('tab-app').click(); const s = document.querySelector('input[name=n_feeds]'); s.value = '1'; s.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('tab-cost').click() }`)
  await sleep(300)
  check('moving a suggested slider makes it an answer', (await api.eval(`location.search`)).includes('n_feeds=0.5') && !(await api.eval(`document.querySelector('input[name=n_feeds]').closest('.slider-row').classList.contains('is-suggested')`)))
  await api.goto(`${BASE}/calculator/`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  check('engineering sliders start on the band nearest the default hours', (await api.eval(`(() => {
    const s = document.querySelector('input[name=eng_content]')
    return s.dataset.values.split(',')[s.value] + ':' + s.closest('.slider-row').querySelector('output').textContent
  })()`)) === '5:1 - 10')
  check('every assumption is on the page with an editable typical value, the two dates as date inputs', (await api.eval(`document.querySelectorAll('.assume-input').length + ':' + document.querySelectorAll('.assume-input[type=date]').length + ':' + document.getElementById('a-network_mature_end').value`)) === '117:2:2030-03-01')
  const thesis = await api.eval(`(() => { const groups = [...document.querySelectorAll('.assume__group')].map(h => h.textContent); const first = document.querySelector('.assume__group'); const table = first.nextElementSibling.nextElementSibling; return { groups, preamble: first.nextElementSibling.className, rows: table.querySelectorAll('tr[data-key]').length, thesisRows: document.querySelectorAll('tr.is-thesis').length, keys: [...table.querySelectorAll('tr[data-key]')].map(r => r.dataset.key).slice(0, 2), intro: document.querySelector('.assume__intro').textContent, files: [...document.querySelectorAll('.assume__files .chip')].map(a => a.textContent), filesBeforeTable: document.querySelector('.assume__files').compareDocumentPosition(table) === Node.DOCUMENT_POSITION_FOLLOWING, notes: (() => { const c = document.getElementById('calc').cloneNode(true); for (const n of c.querySelectorAll('script')) n.remove(); return c.textContent })() } })()`)
  check('the rows that move the band are grouped first under "Network mature: Nostr4\'s thesis" with one preamble, the store commission first, the timeline rows in a group of their own, and the intro says the band is the thesis', thesis.groups[0] === "Network mature: Nostr4's thesis" && thesis.groups[1].startsWith('The timeline') && thesis.preamble === 'assume__preamble' && thesis.rows === 21 && thesis.thesisRows === 21 && thesis.keys.join(',') === 'p2p_store_fee_remains_share,media_sponsor_share' && thesis.intro.includes('not about cloud pricing'), JSON.stringify({ ...thesis, notes: undefined }))
  check('the two file links sit under the intro, before the table, and name version 4', thesis.files.join(' ') === 'assumptions.v4.json assumptions.v4.md' && thesis.filesBeforeTable, thesis.files.join(' '))
  check('no string on the page says at scale, and no typed year survives', !/at scale|Nostr at Scale/i.test(thesis.notes) && !/\b20(2[7-9]|3\d)\b(?!-\d\d)/.test(thesis.notes.replace(/\d{4}-\d\d-\d\d/g, '').replace(/IRIS 2025|2025|2026|2024|2023|2022|2021|2019|2020|v2026|20\d\d-\d\d/g, '')), (thesis.notes.match(/.{30}(?:at scale|\b20(2[7-9]|3\d)\b).{30}/i) || [''])[0])
  check('no string on the page says floor, at least, passkey, rockstars or winners', !/\bfloor\b|at least|passkey|rockstars|winners/i.test(thesis.notes), (thesis.notes.match(/.{30}(?:\bfloor\b|at least|passkey|rockstars|winners).{30}/i) || [''])[0])

  check('number sliders start on their defaults', (await api.eval(`(() => {
    const v = (n) => { const s = document.querySelector('input[name=' + n + ']'); return s.dataset.values.split(',')[s.value] + '=' + s.closest('.slider-row').querySelector('output').textContent }
    return [v('mau'), v('posts_per_user'), v('mb'), v('p2p_volume'), v('legal_usd')].join(' ')
  })()`)) === '50000=50k 200=200 5=5 MB 5000=$5k 0=0')

  // ── a tab named in the address ───────────────────────────────────────────
  for (const [anchor, tab] of [['results', 'cost'], ['app', 'app'], ['assumptions', 'assumptions']]) {
    // A query of its own each time, so each is a fresh load and not a same-page jump.
    await api.goto(`${BASE}/calculator/?open=${anchor}#${anchor}`)
    await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
    await sleep(300)
    const at = await api.eval(`({ selected: document.getElementById('tab-${tab}').getAttribute('aria-selected'), hidden: document.getElementById('panel-${tab}').hidden, top: Math.round(document.getElementById('calc').getBoundingClientRect().top), scrolled: window.scrollY > 100 })`)
    check(`#${anchor} opens the ${tab} tab and brings the bar to the top of the view`, at.selected === 'true' && !at.hidden && Math.abs(at.top) < 4 && at.scrolled, JSON.stringify(at))
  }
  await api.goto(`${BASE}/calculator/?mau=50000&jur=us&team=ten&v=2`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  await sleep(300)
  check('a results link without an anchor opens on Estimated Cost without scrolling', (await api.eval(`document.getElementById('tab-cost').getAttribute('aria-selected') + ':' + window.scrollY`)) === 'true:0')
  await api.eval(`location.hash = '#assumptions'`)
  await sleep(900)
  const hashed = await api.eval(`document.getElementById('tab-assumptions').getAttribute('aria-selected') + ':' + Math.round(document.getElementById('calc').getBoundingClientRect().top)`)
  check('changing the anchor on the open page switches the tab too', /^true:-?[0-3]$/.test(hashed), hashed)

  // ── a bad value in a link ─────────────────────────────────────────────────
  await api.goto(`${BASE}/calculator/?mau=abc&jur=us`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const err = await api.eval(`({ text: document.getElementById('calc-error').textContent, hidden: document.getElementById('calc-error').hidden, invalid: document.querySelector('.is-invalid')?.id })`)
  check('a bad value in a link is refused and named with the form\'s own words', !err.hidden && err.text.includes('How many Monthly Active Users') && err.invalid === 'field-mau', JSON.stringify(err))
  check('…and the field says so to assistive tech, pointing at the message', (await api.eval(`(() => { const i = document.querySelector('input[name=mau]'); return i.getAttribute('aria-invalid') + ':' + i.getAttribute('aria-describedby') })()`)) === 'true:calc-error')
  check('…and the results stay hidden', await api.eval(`document.getElementById('calc-results').hidden`))
  await api.goto(`${BASE}/calculator/`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)

  // ── a full calculation ────────────────────────────────────────────────────
  await api.eval(`(() => {
    const f = document.getElementById('calc-form')
    const slide = (name, value) => { const s = f.querySelector('input[name=' + name + ']'); s.value = s.dataset.values.split(',').indexOf(value); s.dispatchEvent(new Event('input', { bubbles: true })) }
    slide('mau', '50000'); slide('p2p_volume', '20000')
    slide('eng_accounts', '5'); slide('eng_content', '25'); slide('eng_infra', '25')
    f.querySelector('input[name=mod_who][value=team]').checked = true
    slide('mod_heads', '3')
    f.querySelector('input[name=rails][value=apple]').checked = true
    f.querySelector('input[name=rails][value=google]').checked = true
    f.querySelector('input[name=rails][value=processor]').checked = true
    f.querySelector('input[name=jur][value=eu]').checked = true
    f.querySelector('input[name=jur][value=uk]').checked = true
    slide('growth', '0.5')
    f.requestSubmit()
  })()`)
  await api.waitFor(`!document.getElementById('calc-results').hidden`)
  const r = await api.eval(`(() => {
    const $ = (s) => document.querySelector(s)
    const row = (l) => document.querySelector('.lt-row[data-line="' + l + '"]')
    return {
      hero: $('.chart__watermark').textContent, whose: $('#r-whose-text').textContent, whoseLink: $('#r-whose-link').textContent,
      permauC: $('#r-permau-c').textContent, permauCRange: $('#r-permau-c-range').textContent, permauNC: $('#r-permau-nc').textContent, permauNCRange: $('#r-permau-nc-range').textContent, scale: $('#r-scale-nostr').textContent, scaleRange: $('#r-scale-nostr-range').textContent, cumulative: $('#r-cumulative'),
      note: $('#r-note-text').textContent.replace(/\\s+/g, ' ').trim(), noteBold: $('#r-note-text b')?.textContent, how: $('#r-breach-how').textContent, howHidden: $('#r-breach-how').hidden, noteInCaption: $('#caption-chart-custodial-cost-vs-nostr').contains($('#r-breach-how')),
      eyebrows: [...document.querySelectorAll('#panel-cost .stat .eyebrow--gold')].map(e => e.textContent),
      yearTwoUsers: $('#r-years tbody tr[data-row=users] td:nth-child(4)').textContent,
      version: $('#r-version').textContent,
      accountsSaving: row('accounts').querySelector('.lt-saving').textContent,
      accountsPct: row('accounts').querySelector('.share__pct').textContent,
      badges: document.querySelectorAll('#r-table .badge').length,
      toggle: row('accounts').querySelector('.lt-toggle').textContent,
      shares: [...document.querySelectorAll('.lt-row .share')].map(b => parseFloat(b.style.getPropertyValue('--w'))),
      storageCut: row('storage').querySelector('.share__pct').textContent,
      editLink: $('#r-edit').className + ':' + getComputedStyle($('.results__actions')).justifyContent, editBorder: getComputedStyle($('#r-edit')).borderTopColor, gold: getComputedStyle($('#tab-app')).color,
      versionAlign: getComputedStyle($('#r-version')).textAlign,
      tabFill: getComputedStyle($('#tab-cost')).borderBottomColor + '|' + getComputedStyle($('#tab-app')).borderBottomColor + '|' + getComputedStyle($('#tab-cost')).backgroundColor,
      illustrative: document.getElementById('tabbar').classList.contains('is-illustrative'),
      share: document.getElementById('save-open').className,
      sum: [...document.querySelectorAll('.lt-row .lt-saving')].reduce((a, n) => { const t = n.textContent; return a + parseFloat(t.replace(/[^\\d.]/g, '')) * (t.endsWith('M') ? 1e6 : t.endsWith('k') ? 1e3 : 1) }, 0),
      footRows: document.querySelectorAll('#r-table > tfoot tr').length,
      subtitle: $('.results__sub').textContent,
      link: location.href,
      url: location.search,
      error: $('#calc-error').hidden,
      focused: document.activeElement?.id,
    }
  })()`)
  check('the watermark is the estimated saving a year, rounded, and the third chip is the Nostr cost a year then, a different figure', /^\$\d+(\.\d+)?[kM]$/.test(r.hero) && /^\$\d+(\.\d+)?[kM]$/.test(r.scale) && r.hero !== r.scale, `${r.hero} | ${r.scale}`)
  check('the three facts are per user at the estimated instant (no range: the custodial side does not vary), per user on Nostr with its range in reading order, and the Nostr cost a year then with its range, under gold eyebrows that name no year', /^\$\d+\.\d\d$/.test(r.permauC) && r.permauCRange === '' && /^\$\d+\.\d\d$/.test(r.permauNC) && /^Range \$(\d+\.\d\d) to \$(\d+\.\d\d)$/.test(r.permauNCRange) && parseFloat(r.permauNCRange.match(/\$([\d.]+) to/)[1]) <= parseFloat(r.permauNCRange.match(/to \$([\d.]+)/)[1]) && /^Range \$/.test(r.scaleRange) && r.eyebrows.join(' | ') === 'Custodial cost per user | Nostr cost per user | Cost of Nostr app, a year', `${r.permauC} [${r.permauCRange}] ${r.permauNC} [${r.permauNCRange}] ${r.scale} [${r.scaleRange}] | ${r.eyebrows.join(' | ')}`)
  check('the chart\'s caption ends with the breach exposure, calculated separately, in bold, and a button to its dialog', r.noteInCaption && r.note.startsWith('Calculated separately: about $') && r.note.endsWith('a year of breach exposure that Nostr also reduces, with no passwords and little private data to lose.') && /^\$\d{1,3}(\.\d)?[kM]?$/.test(r.noteBold || '') && r.how === "Here's how we estimate this →" && !r.howHidden, r.note)
  check('nothing cumulative sits on the year-by-year summary', r.cumulative === null)
  const foot = await api.eval(`({ note: document.querySelector('#save-modal .modal__note')?.textContent.replace(/\\s+/g, ' ').trim(), disclaimer: document.querySelector('.results__disclaimer')?.textContent, measures: [...document.querySelectorAll('#r-years tbody th')].map(t => t.textContent).join(' | '), cols: [...document.querySelectorAll('#r-table > thead th')].map(t => t.textContent).join(' | ') })`)
  check('the figures are called estimates wherever they stand, the foot of the tab says what they are not, and the modal says what sending does with the answers', foot.disclaimer === "Estimates from public benchmarks and Nostr4's assumptions; not legal, tax or financial advice." && foot.measures === 'Active users | Cost of Custody | Cost of Nostr | Estimated Saving' && foot.cols === 'Cost area | Estimated savings a year | Estimated Share Saved | Post Integration' && foot.note.startsWith('Sending publishes your answers as a response on public Nostr relays') && foot.note.includes('You can ask the relays to delete it'), JSON.stringify(foot))
  const col = await api.eval(`(() => { const n = (row, i) => Number(document.querySelector('#r-years tbody tr[data-row=' + row + '] td:nth-child(' + (i + 2) + ')').textContent.replace(/[^\\d]/g, '')); return { users: n('users', 3), custodial: n('custodial', 3), nostr: n('nostr', 3) } })()`)
  check('the two per-user facts are the year-three column of the table (the estimated instant with the defaults) divided by that year\'s users, the third is its Nostr cost, and the watermark is custody less Nostr that year, all rounded', Math.abs(parseFloat(r.permauC.slice(1)) - col.custodial / col.users) < 0.01 && Math.abs(parseFloat(r.permauNC.slice(1)) - col.nostr / col.users) < 0.01 && Math.abs(money(r.scale) - col.nostr) / col.nostr < 0.06 && Math.abs(money(r.hero) - (col.custodial - col.nostr)) / (col.custodial - col.nostr) < 0.06, `${r.permauC} vs ${col.custodial}/${col.users} | ${r.permauNC} vs ${col.nostr}/${col.users} | ${r.scale} vs ${col.nostr} | ${r.hero}`)
  await api.eval(`document.getElementById('r-breach-how').click()`)
  const breachHow = await api.eval(`({ open: document.getElementById('how-modal').open, part: document.getElementById('how-part').textContent, today: document.getElementById('how-today').textContent, nostr: document.getElementById('how-nostr').textContent, foot: document.getElementById('how-scale').textContent, items: [...document.querySelectorAll('#how-list .how__item')].map(i => i.textContent.replace(/\\s+/g, ' ').trim()) })`)
  check('"How we estimate this" opens the breach dialog: the IRIS arithmetic by firm, the cyber-policy cross-check beside it, and a foot that says it is an exposure, not in the headline', breachHow.open && breachHow.part === 'Expected breach loss' && /^An expected loss, not a bill: 5\.6% chance of a breach in a year × \$357,000, the median loss for a firm with a team of up to 10 \(IRIS 2025\) = \$[\d,]+\. Cross-check from the insurance side: a small-business cyber policy costs \$1,552 a year/.test(breachHow.today) && /no passwords to lose: \$[\d,]+$/.test(breachHow.nostr) && /^36 months from today: \$[\d,]+ a year of exposure becomes \$[\d,]+, about \$[\d.]+[kM]? a year less\. An exposure, not a saving/.test(breachHow.foot) && breachHow.items.some(i => i.startsWith('Team of up to ten: median loss from a breach')) && breachHow.items.some(i => i.startsWith('Cyber liability insurance')) && !breachHow.items.some(i => /Team of one|more than fifty/.test(i)), JSON.stringify(breachHow))
  await api.eval(`document.getElementById('how-modal').close()`)
  check('after Calculate the tab says it is the visitor\'s estimate, facilitating that volume a month', r.whose.startsWith('Your estimate') && r.whose.includes('50,000') && r.whose.includes('facilitates $20k a month in in-app payments') && r.whose.includes('the EU') && r.whoseLink === 'Customize App Details', `${r.whose} / ${r.whoseLink}`)
  check('growth compounds in the year-by-year table (50% then decayed)', r.yearTwoUsers === '103,125', r.yearTwoUsers)
  check('each line shows its estimated saving a year, rounded as the headline is, its share as a percentage, and no pills', /^\$[\d.]+[kM]?$/.test(r.accountsSaving) && /^[\d.]+%$/.test(r.accountsPct) && r.badges === 0 && r.toggle === 'Show the Savings', `${r.accountsSaving} | ${r.accountsPct} | ${r.badges} badges | ${r.toggle}`)
  check('each bar is the share of that line\'s own cost that goes away', r.shares.length === 6 && r.shares.every(x => x >= 0 && x <= 100) && /^\d+(\.\d+)?%$/.test(r.storageCut) && parseFloat(r.storageCut) > 50, `${r.shares.join(' ')} | storage ${r.storageCut}`)
  check('the way back to the form is a centred gold-bordered button, the version sits right, and the active tab is underlined, not filled', r.editLink === 'btn btn--secondary results__edit:center' && r.editBorder === r.gold && r.versionAlign === 'right' && r.tabFill.split('|')[0] !== r.tabFill.split('|')[1] && r.tabFill.split('|')[1] === 'rgba(0, 0, 0, 0)' && r.tabFill.split('|')[2] === 'rgba(0, 0, 0, 0)', `${r.editLink} | ${r.editBorder} vs ${r.gold} | ${r.versionAlign} | ${r.tabFill}`)
  check('the bar is a hairline with no track: the tabs row has no border or fill, and Assumptions sits at its far end', await api.eval(`(() => { const row = document.getElementById('calc-tabs'); const cs = getComputedStyle(row); const quiet = document.getElementById('tab-assumptions').getBoundingClientRect(); const app = document.getElementById('tab-app').getBoundingClientRect(); return cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.borderTopWidth === '0px' && cs.borderRadius === '0px' && quiet.left - app.right > 80 })()`))
  check('no integration card on the tab; the services door sits in the closing callout, stacked above the consult door', (await api.eval(`!document.getElementById('r-integ') && [...document.querySelectorAll('.callout .actions--stacked .btn')].map(a => a.textContent + ':' + a.getAttribute('href')).join(' | ') + ' | ' + getComputedStyle(document.querySelector('.callout .actions--stacked')).flexDirection`)) === 'See Services:/services/ | Book a Free Consult:/contact/?subject=Free+consult | column')
  check('once the estimate is the visitor\'s own, the gold ring goes and Send & Share is filled', !r.illustrative && r.share.includes('btn--primary') && !r.share.includes('btn--secondary'), `${r.illustrative} ${r.share}`)
  check('there is no foot row, and the six lines, each rounded as the headline is, add up to the headline', r.footRows === 0 && r.subtitle.trim().length > 0 && Math.abs(r.sum - money(r.hero)) / money(r.hero) < 0.06, `${r.sum} vs ${r.hero}`)
  const remains = await api.eval(`document.querySelector('#r-table thead .lt-remains').textContent + ' | ' + document.querySelector('.lt-row[data-line="payments"] .lt-remains').textContent.replace(/\\s+/g, ' ').trim()`)
  check('the Post Integration column summarises what remains, in the page\'s words; the payments row keeps the app-store sentence and says the volume is split across the rails', remains.startsWith("Post Integration | Payments between users settle on their own rails.") && remains.includes("An app selling its own products in-app still pays the app-store's commission.") && remains.endsWith('The volume you give is split evenly across the rails you name.'), remains)
  check('the page URL carries the inputs and the version', r.link.includes('mau=50000') && r.link.includes('eng_content=25') && r.link.includes('jur=eu%2Cuk%2Cus') && r.link.includes('growth=0.5') && r.link.includes('team=ten') && /v=4&t=\d{4}-\d\d-\d\d$/.test(r.link), r.link)
  check('sliders standing on "not given" or on a suggestion stay out of the link', !r.link.includes('n_keys=') && !r.link.includes('eng_legal=') && r.link.includes('kind=messaging') && r.link.includes('mod_who=team') && r.link.includes('mod_heads=3'), r.link)
  check('the version and the date are named', /^Assumptions version 4 · calculated as of \d{4}-\d\d-\d\d$/.test(r.version), r.version)
  const sourcing = await api.eval(`document.getElementById('r-sourcing').textContent`)
  check('the sourcing line is three counts that add up to the file', /^\d+ sourced, \d+ defaults you can replace, \d+ are our thesis$/.test(sourcing) && sourcing.match(/\d+/g).map(Number).reduce((a, b) => a + b, 0) === 117, sourcing)
  await api.eval(`document.querySelector('.lt-row[data-line="accounts"] .lt-toggle').click()`)
  const engMeta = await api.eval(`({ given: document.querySelector('.lt-parts[data-line="accounts"] .part[data-part="engineering"] .part__meta')?.textContent, defaulted: (() => { document.querySelector('.lt-row[data-line="compliance"] .lt-toggle').click(); return document.querySelector('.lt-parts[data-line="compliance"] .part[data-part="legal_labour"] .part__meta')?.textContent })() })`)
  check('an engineering part says where its hours came from: the founder\'s own band, or a default for the team size with the way to Customize', engMeta.given === 'based on your 5 hours a week' && engMeta.defaulted === 'based on a default for a team of up to 10; enter your hours in Customize', JSON.stringify(engMeta))
  await api.eval(`document.querySelector('.lt-row[data-line="accounts"] .lt-toggle').click(); document.querySelector('.lt-row[data-line="compliance"] .lt-toggle').click()`)
  check('the results heading took focus', r.focused === 'results-title', r.focused)
  check('Calculate opened the Estimated Cost tab', (await api.eval(`document.getElementById('tab-cost').getAttribute('aria-selected') + ':' + document.getElementById('panel-cost').hidden + ':' + document.getElementById('panel-app').hidden`)) === 'true:false:true')

  // ── a change, then opening Your Cost ─────────────────────────────────────
  const heroBefore = await api.eval(`document.querySelector('.chart__watermark').textContent`)
  await api.eval(`{ document.getElementById('tab-app').click(); const s = document.querySelector('input[name=mau]'); s.value = s.dataset.values.split(',').indexOf('500000'); s.dispatchEvent(new Event('input', { bubbles: true })) }`)
  check('a changed slider does not recompute by itself', (await api.eval(`document.querySelector('.chart__watermark').textContent`)) === heroBefore)
  await sleep(300)
  check('…but the address bar follows it', (await api.eval(`location.search`)).includes('mau=500000'))
  await api.eval(`document.getElementById('tab-cost').click()`)
  await sleep(150)
  const heroAfter = await api.eval(`document.querySelector('.chart__watermark').textContent`)
  check('opening Estimated Cost after a change recomputes', heroAfter !== heroBefore, `${heroBefore} → ${heroAfter}`)
  await api.eval(`{ document.getElementById('tab-app').click(); const s = document.querySelector('input[name=mau]'); s.value = s.dataset.values.split(',').indexOf('50000'); s.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('tab-cost').click() }`)
  await sleep(150)
  check('…and back again', (await api.eval(`document.querySelector('.chart__watermark').textContent`)) === heroBefore)
  check('the error cleared', r.error)

  // ── the parts ─────────────────────────────────────────────────────────────
  await api.eval(`document.querySelector('.lt-row[data-line="payments"] .lt-toggle').click()`)
  const parts = await api.eval(`(() => {
    const row = document.getElementById('parts-payments')
    const n = (sel) => Number(row.querySelector(sel).textContent.replace(/[^\\d]/g, ''))
    const savedText = document.querySelector('.lt-row[data-line="payments"] .lt-saving').textContent
    const saved = parseFloat(savedText.replace(/[^\\d.]/g, '')) * (savedText.endsWith('M') ? 1e6 : savedText.endsWith('k') ? 1e3 : 1)
    const table = row.querySelector('.parts-table')
    const cols = (tr) => [...tr.children].map(c => c.textContent.replace(/\\s+/g, ' ').trim())
    const right = (sel) => getComputedStyle(table.querySelector(':scope > ' + sel)).textAlign
    return { hidden: row.hidden, open: document.querySelector('.lt-row[data-line="payments"]').classList.contains('is-open'), heads: cols(table.querySelector('thead tr')), foot: cols(table.querySelector('tfoot tr')), gap: n('.parts__total-c') - n('.parts__total-nc'), saved, items: [...row.querySelectorAll('.part')].map(p => p.textContent.replace(/\\s+/g, ' ').trim()), rows: [...table.querySelectorAll('tbody tr')].map(tr => tr.children.length), subs: [...row.querySelectorAll('.parts__subtotal th')].map(s => s.textContent), aligned: right('tbody .parts-num') === 'right' && right('tfoot .parts-num') === 'right' && right('thead .parts-num') === 'right', nums: [...table.querySelectorAll(':scope > tbody .parts-num, :scope > tfoot .parts-num')].every(c => /^\\$[\\d,]+$/.test(c.textContent.trim())) }
  })()`)
  const partsWhy = { shown: !parts.hidden && parts.open, four: parts.items.length === 4, heads: parts.heads.join(' | ') === 'Item | Cost of Custody | Cost of Nostr', three: parts.rows.every(n => n === 3), foot: /^Total \$[\d,]+ \$[\d,]+$/.test(parts.foot.join(' ')), aligned: parts.aligned, nums: parts.nums, gap: Math.abs(parts.gap - parts.saved) / parts.saved < 0.06 }
  check('the savings open under the line as three columns, item, custody and Nostr, every figure right-aligned in its column, with the two totals at the estimated instant as the foot row whose difference is the (rounded) saving beside them', Object.values(partsWhy).every(Boolean), `${JSON.stringify(partsWhy)} | ${parts.heads.join(' | ')} | ${parts.foot.join(' ')} | saved ${parts.saved} | ${parts.items.join(' | ')}`)
  check('a store part names its applied rate and tier, and the payments line closes with its fees sub-total', parts.items.some(t => /Apple App Store commission.*15%.*small-business tier/.test(t)) && parts.subs.join('|') === 'Fees on in-app payments', `${parts.items[0]} | ${parts.subs.join('|')}`)
  await api.eval(`document.querySelector('.lt-parts[data-line="payments"] button.part[data-part="store_apple"]').click()`)
  const storeHow = await api.eval(`document.getElementById('how-nostr').textContent + ' || ' + [...document.querySelectorAll('#how-list .how__item')].map(i => i.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`)
  check('a store part\'s dialog says how much commission the precedent leaves and names the user\'s rail, resting on the store-commission row', /^\$[\d,]+ × 15% × 50% store commission while the precedent is open, plus \$[\d,]+ × 1% on the user's rail = \$[\d,]+ \|\|/.test(storeHow) && storeHow.includes('Share of the store commission that still applies') && storeHow.includes('100% to 10%'), storeHow)
  await api.eval(`document.getElementById('how-modal').close()`)
  await api.eval(`document.querySelector('.lt-row[data-line="compliance"] .lt-toggle').click()`)
  const risk = await api.eval(`(() => {
    const row = document.getElementById('parts-compliance')
    const items = [...row.querySelectorAll('.parts > tr')].map(tr => (tr.classList.contains('parts__subtotal') ? 'SUB:' + tr.querySelector('th').textContent : tr.querySelector('.part').dataset.part))
    const n = (tr) => [...tr.querySelectorAll('.parts-num')].map(x => Number(x.textContent.replace(/[^\\d]/g, '')))
    const subs = [...row.querySelectorAll('.parts__subtotal')].map(n)
    const parts = [...row.querySelectorAll('.parts > tr:not(.parts__subtotal)')].map(n)
    const cash = parts.slice(0, 4).reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0])
    const foot = [...row.querySelectorAll('tfoot .parts-num')].map(x => Number(x.textContent.replace(/[^\\d]/g, '')))
    return { items, subs, cash, foot }
  })()`)
  check('the compliance line lists its four cash costs and no sub-total; the expected breach loss is not in the table, and the foot is the cash costs', risk.items.join(' ') === 'privacy_programs legal_labour dsar insurance' && risk.subs.length === 0 && Math.abs(risk.foot[0] - risk.cash[0]) <= 2 && Math.abs(risk.foot[1] - risk.cash[1]) <= 2, JSON.stringify(risk))

  // ── an assumption edit, then Recalculate ─────────────────────────────────
  const before = await api.eval(`document.querySelector('.lt-row[data-line="storage"] .lt-saving').textContent`)
  await api.eval(`document.getElementById('tab-assumptions').click()`)
  check('the Our Assumptions tab opens', (await api.eval(`document.getElementById('panel-assumptions').hidden`)) === false)
  await api.eval(`(() => {
    const i = document.getElementById('a-egress_gb_per_mau_month')
    i.value = '5'
    i.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await sleep(100)
  check('the changed row is marked, and nothing recomputes yet', (await api.eval(`document.querySelector('tr[data-key="egress_gb_per_mau_month"]').classList.contains('is-changed') + ':' + document.querySelector('.lt-row[data-line="storage"] .lt-saving').textContent`)) === `true:${before}`)
  await api.eval(`document.getElementById('a-recalc').click()`)
  await sleep(200)
  const after = await api.eval(`({
    storage: document.querySelector('.lt-row[data-line="storage"] .lt-saving').textContent,
    link: location.href,
    tab: document.getElementById('tab-cost').getAttribute('aria-selected'),
    status: document.getElementById('r-status').textContent,
  })`)
  check('Recalculate recomputes the line and opens Estimated Cost', after.storage !== before && after.tab === 'true', `${before} → ${after.storage}`)
  check('the override travels in the link, and the banner says the result is not the defaults', after.link.includes('a.egress_gb_per_mau_month=5') && !(await api.eval(`document.getElementById('r-custom').hidden`)), after.link)
  await api.eval(`document.getElementById('tab-assumptions').click(); document.getElementById('a-reset').click(); document.getElementById('a-recalc').click()`)
  await sleep(200)
  check('reset then Recalculate restores the typical value', (await api.eval(`document.querySelector('.lt-row[data-line="storage"] .lt-saving').textContent`)) === before)
  // A date row: the network's start moved to the start of this year makes today's share small, so the Nostr line starts higher.
  // An overridden span reads as months: 18 months of payback is an "18-month" window and the headline at month 30.
  const heroDefault = await api.eval(`document.querySelector('.chart__watermark').textContent`)
  const nostrTodayDefault = await api.eval(`Number(document.querySelector('#r-years tbody tr[data-row=nostr] td:nth-child(2)').textContent.replace(/[^\\d]/g, ''))`)
  await api.eval(`document.getElementById('tab-assumptions').click()`)
  await api.eval(`(() => { const i = document.getElementById('a-network_mature_start'); i.value = '2026-01-01'; i.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await api.eval(`document.getElementById('a-recalc').click()`)
  await sleep(300)
  const dated = await api.eval(`({ changed: document.querySelector('tr[data-key="network_mature_start"]').classList.contains('is-changed'), url: location.search, nostrToday: Number(document.querySelector('#r-years tbody tr[data-row=nostr] td:nth-child(2)').textContent.replace(/[^\\d]/g, '')), hero: document.querySelector('.chart__watermark').textContent, value: document.getElementById('a-network_mature_start').value })`)
  check('a date assumption is an override like any other: marked, in the link as its ISO date, and today\'s Nostr cost moves with the curve (the headline at month 36 barely does)', dated.changed && dated.url.includes('a.network_mature_start=2026-01-01') && dated.nostrToday > nostrTodayDefault * 1.5 && dated.value === '2026-01-01', JSON.stringify({ ...dated, nostrTodayDefault, heroDefault }))
  await api.eval(`document.getElementById('a-reset').click()`)
  await api.eval(`document.getElementById('a-recalc').click()`)
  await sleep(300)
  check('…and reset brings the date back', (await api.eval(`document.getElementById('a-network_mature_start').value + ':' + location.search.includes('network_mature')`)) === '2023-01-01:false')
  await api.eval(`(() => { const i = document.getElementById('a-integration_payback_months'); i.value = '18'; i.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await api.eval(`document.getElementById('a-recalc').click()`)
  await sleep(300)
  const spanned = await api.eval(`document.getElementById('caption-text-chart-custodial-cost-vs-nostr').textContent`)
  check('a span that is not whole years is said in months', spanned.includes('within the 18-month integration window') && spanned.includes('estimated savings in month 30, one year after the window'), spanned)
  await api.eval(`document.getElementById('a-reset').click()`)
  await api.eval(`document.getElementById('a-recalc').click()`)
  await sleep(300)
  await api.eval(`document.getElementById('r-edit').click()`)
  check('Customize App Details returns to App Info', (await api.eval(`document.getElementById('tab-app').getAttribute('aria-selected')`)) === 'true')
  // leave the override in place for the shared-link check below
  await api.eval(`{ document.getElementById('tab-assumptions').click(); const i = document.getElementById('a-egress_gb_per_mau_month'); i.value = '5'; i.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('a-recalc').click() }`)
  await sleep(200)
  after.link = await api.eval(`location.href`)

  if (SHOTS) {
    await snap(api, join(SHOTS, 'calculator-1440.png'))
    await api.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await sleep(300)
    await snap(api, join(SHOTS, 'calculator-390.png'))
    await api.send('Emulation.clearDeviceMetricsOverride')
  }

  // ── how this is calculated ───────────────────────────────────────────────
  await api.eval(`document.querySelector('.lt-row[data-line="accounts"] .lt-toggle').click()`)
  await api.eval(`document.querySelector('.lt-parts[data-line="accounts"] button.part[data-part="verify"]').click()`)
  const how = await api.eval(`({
    open: document.getElementById('how-modal').open,
    part: document.getElementById('how-part').textContent, line: document.getElementById('how-line').textContent,
    today: document.getElementById('how-today').textContent, nostr: document.getElementById('how-nostr').textContent,
    items: [...document.querySelectorAll('#how-list .how__item')].map(i => i.textContent.replace(/\\s+/g, ' ').trim()),
    adjust: document.getElementById('how-adjust').textContent,
    scale: document.getElementById('how-scale').textContent,
  })`)
  check('…and says what the figure in the list is: the same part at the estimated instant', /^36 months from today \([\d,]+ users\): \$[\d,]+ of custody becomes \$[\d,]+ on Nostr/.test(how.scale), how.scale)
  if (SHOTS) await snap(api, join(SHOTS, 'how-1440.png'))
  check('a part opens the how-dialog with the arithmetic filled in: the check share is the regions\' weighted mean', how.open && how.part === 'Identity and age checks' && how.line === 'Accounts & personal data' && /^50,000 users × 5\.[0-9]% checked a year \(each region's share of users at that region's rate\) × \$1\.50 a check = \$[\d,]+$/.test(how.today) && /^10% of checks remain.*\$[\d,]+$/.test(how.nostr), `${how.today} | ${how.nostr}`)
  check('…and lists only the assumptions that applied, the regions\' weights among them, with value, range and confidence', how.items.length === 8 && how.items.some(i => i.startsWith('Users needing a check per year, UK') && i.includes('25%') && i.includes('10% to 50% · unsourced')) && how.items.some(i => i.startsWith('Weight of the UK')) && !how.items.some(i => i.includes('other')), how.items.join(' | '))
  await api.eval(`document.getElementById('how-adjust').click()`)
  await sleep(200)
  const lit = await api.eval(`({
    tab: document.getElementById('tab-assumptions').getAttribute('aria-selected'), closed: !document.getElementById('how-modal').open,
    rows: [...document.querySelectorAll('.assume-table tr.is-focus')].map(r => r.dataset.key),
    strip: document.getElementById('a-filter').hidden + ':' + document.getElementById('a-filter-text').textContent,
    filtered: document.getElementById('calc-assume').classList.contains('is-filtered'),
  })`)
  check('Adjust Assumptions opens the tab with those rows lit and says why', lit.tab === 'true' && lit.closed && lit.filtered && [...lit.rows].sort().join(',') === 'jur_weight_eu,jur_weight_uk,jur_weight_us,verify_price,verify_remains_share,verify_share_eu,verify_share_uk,verify_share_us' && lit.strip === 'false:Showing the 8 assumptions behind Identity and age checks.', `${lit.rows.join(',')} | ${lit.strip}`)
  await api.eval(`document.getElementById('a-filter-clear').click()`)
  check('Show all clears the lights', (await api.eval(`document.querySelectorAll('.assume-table tr.is-focus').length + ':' + document.getElementById('a-filter').hidden + ':' + document.getElementById('calc-assume').classList.contains('is-filtered')`)) === '0:true:false')
  await api.eval(`document.getElementById('tab-cost').click()`)

  // Every part of every line explains itself without a blank: two input sets walk every branch.
  for (const query of ['mau=50000&posts_per_user=20&eng_accounts=5&mod_who=team&mod_heads=15&team=ten&rails=p2p%2Capple%2Cgoogle%2Cprocessor%2Creseller&p2p_volume=50000&balances=yes&jur=eu%2Cuk%2Cus%2Cother&v=2', 'mau=10000000&rails=apple&rev=200000&legal_usd=50000&jur=us&v=1', 'mau=20000&mod_who=vendor&mod_heads=3&team=one&kind=messaging&nostr_now=0.5&jur=eu&v=2']) {
    await api.goto(`${BASE}/calculator/?${query}`)
    await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
    if (query.includes('nostr_now=0.5')) check('a partly integrated app is named in full in the frame', (await api.eval(`document.getElementById('r-whose-text').textContent`)).includes('partially Nostr integrated'), await api.eval(`document.getElementById('r-whose-text').textContent`))
    if (query.endsWith('v=1')) {
      // A version-1 link had no team question; it opens as the team size it assumed, under the current version, and says so.
      const older = await api.eval(`({ status: document.getElementById('r-status').textContent, hidden: document.getElementById('calc-results').hidden, team: document.querySelector('input[name=team]').dataset.values.split(',')[document.querySelector('input[name=team]').value], url: location.search })`)
      check('a results link made with version 1 opens under version 4 and says so', !older.hidden && older.status.startsWith('Opened from a results link made with assumptions version 1; shown with version 4.') && older.team === 'ten' && /v=4&t=\d{4}-\d\d-\d\d$/.test(older.url) && older.url.includes('team=ten'), JSON.stringify(older))
    }
    const gaps = await api.eval(`(() => {
      const problems = []
      let count = 0
      for (const row of document.querySelectorAll('.lt-row')) {
        row.querySelector('.lt-toggle').click()
        for (const button of document.querySelectorAll('.lt-parts[data-line="' + row.dataset.line + '"] button.part')) {
          button.click()
          count++
          const today = document.getElementById('how-today').textContent, nostr = document.getElementById('how-nostr').textContent
          const list = document.getElementById('how-list').textContent
          if (!today || !nostr || /\\{[a-z]\\./.test(today + nostr) || /NaN|undefined/.test(today + nostr + list)) problems.push(row.dataset.line + '.' + button.dataset.part + ': ' + today + ' / ' + nostr)
          document.getElementById('how-modal').close()
        }
      }
      return { count, problems }
    })()`)
    check(`every part explains itself (${gaps.count} parts, ${query.slice(0, 20)}…)`, gaps.count >= 20 && gaps.problems.length === 0, gaps.problems.join(' || '))
  }

  // ── a version-2 link with an override of a key version 3 and later derive ──
  await api.goto(`${BASE}/calculator/?mau=50000&jur=us&team=ten&a.key_support_per_mau_year=0.1&a.egress_gb=0.05&v=2`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const v2 = await api.eval(`({ hidden: document.getElementById('calc-results').hidden, status: document.getElementById('r-status').textContent, url: location.search, egress: document.getElementById('a-egress_gb').value, handoff: document.querySelector('.lt-parts[data-line="accounts"] button.part[data-part="key_handoff"]') !== null, support: document.querySelector('.lt-parts[data-line="accounts"] button.part[data-part="key_support"]') !== null })`)
  check('a version-2 link opens under version 4, says so, keeps the override it still knows and drops the key-support one', !v2.hidden && v2.status.startsWith('Opened from a results link made with assumptions version 2; shown with version 4.') && /v=4&t=\d{4}-\d\d-\d\d$/.test(v2.url) && v2.url.includes('a.egress_gb=0.05') && !v2.url.includes('key_support') && v2.egress === '0.05' && v2.handoff && !v2.support, JSON.stringify(v2))

  // ── a crafted link: out-of-range and junk overrides, a date, an anchor ───
  await api.goto(`${BASE}/calculator/?mau=50000&jur=us&team=ten&a.eng_base_salary=1e308&a.media_sponsor_share=5&a.blob_gb_month=&a.db_gb_month=0x10&a.egress_gb=10000000&t=2028-11-03&v=4#results`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const crafted = await api.eval(`({ text: document.getElementById('panel-cost').textContent, banner: document.getElementById('r-custom').hidden, bannerText: document.getElementById('r-custom').textContent.replace(/\\s+/g, ' ').trim(), url: location.search + location.hash, version: document.getElementById('r-version').textContent, share: document.getElementById('a-media_sponsor_share').value, salary: document.getElementById('a-eng_base_salary').value, egress: document.getElementById('a-egress_gb').value })`)
  check('junk overrides are ignored and out-of-range ones clamped: no NaN or Infinity anywhere, the share held to 1, the egress to ten times its high', !/NaN|Infinity/.test(crafted.text) && crafted.share === '1' && crafted.salary === '135980' && crafted.egress === '0.9', JSON.stringify({ share: crafted.share, salary: crafted.salary, egress: crafted.egress }))
  check('the custom-assumptions banner says so, names what was clamped, and offers the reset', !crafted.banner && crafted.bannerText.startsWith("This result uses custom assumptions, not Nostr4's defaults. Out-of-range values were clamped: ") && crafted.bannerText.includes('media_sponsor_share 5 → 1') && crafted.bannerText.includes('egress_gb 10000000 → 0.9') && crafted.bannerText.endsWith('Reset to defaults →'), crafted.bannerText)
  check('the link\'s date is the calculation\'s date, the address bar keeps the clamped overrides, the date and the anchor', crafted.version.endsWith('calculated as of 2028-11-03') && crafted.url.includes('a.media_sponsor_share=1') && crafted.url.includes('a.egress_gb=0.9') && !crafted.url.includes('eng_base_salary') && crafted.url.includes('t=2028-11-03') && crafted.url.endsWith('#results'), crafted.url)
  await api.eval(`document.getElementById('r-custom-reset').click()`)
  await sleep(300)
  const resetTo = await api.eval(`({ banner: document.getElementById('r-custom').hidden, url: location.search, mau: document.querySelector('input[name=mau]').dataset.values.split(',')[document.querySelector('input[name=mau]').value], share: document.getElementById('a-media_sponsor_share').value })`)
  check('Reset to defaults keeps the inputs and drops the overrides', resetTo.banner && !resetTo.url.includes('a.') && resetTo.url.includes('mau=50000') && resetTo.mau === '50000' && resetTo.share === '0.25', JSON.stringify(resetTo))
  await api.goto(`${BASE}/calculator/`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  check('a fresh page carries no banner', await api.eval(`document.getElementById('r-custom').hidden`))

  // ── an app already on Nostr for keys and storage: nothing left to lose ───
  await api.goto(`${BASE}/calculator/?mau=50000&jur=us&team=ten&n_keys=1&n_event_storage=1&n_media_storage=1&v=4`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const noBreach = await api.eval(`({ note: document.getElementById('r-note-text').textContent.replace(/\\s+/g, ' ').trim(), howHidden: document.getElementById('r-breach-how').hidden, bold: document.querySelector('#r-note-text b') })`)
  check('with no breach exposure left, the caption\'s breach sentence and its button are left out: never "$0 of exposure"', noBreach.note === '' && noBreach.howHidden && noBreach.bold === null, JSON.stringify(noBreach))
  const callout = await api.eval(`({ title: document.querySelector('.callout .section-head h2')?.textContent.trim(), lede: document.querySelector('.callout .lede')?.textContent.replace(/\\s+/g, ' ').trim() })`)
  check('the closing callout says "by 2030", derived from the network\'s date, and no longer "at scale" or "within three years"', callout.lede.includes('fully supported on Nostr by 2030.') && !/within three years|\{mature_year\}|at scale/i.test(callout.lede + callout.title), JSON.stringify(callout))

  // ── nobody moderates ──────────────────────────────────────────────────────
  await api.goto(`${BASE}/calculator/?mau=50000&mod_who=nobody&jur=us&team=ten&v=4`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const nobody = await api.eval(`(() => {
    const row = document.querySelector('.lt-row[data-line="moderation"]')
    return { saving: row.querySelector('.lt-saving').textContent, range: row.querySelector('.lt-saving-range').textContent, note: row.querySelector('.lt-flag--nobody').textContent, noteHidden: row.querySelector('.lt-flag--nobody').hidden, share: row.querySelector('.share').style.getPropertyValue('--w'), whose: document.getElementById('r-whose-text').textContent, bright: [...document.querySelectorAll('#r-whose-text .whose__fact:not(.whose__fact--assumed)')].map(f => f.textContent) }
  })()`)
  check('with nobody moderating the line shows zero to zero, claims nothing, and names the benchmark it would have billed', nobody.saving === '$0' && nobody.range === '$0 to $0' && nobody.share === '0%' && !nobody.noteHidden && /^No moderation today\. Benchmarks put it at about [\d.]+ people, \$[\d.]+[kM]? a year\. On Nostr that work moves to the network; nothing is saved because nothing is spent\.$/.test(nobody.note), JSON.stringify(nobody))
  check('…and the frame says no moderation, as an answer; unanswered says benchmark, assumed', nobody.whose.includes('no moderation') && nobody.bright.includes('no moderation') && first.whose.includes('moderation at benchmark levels'), nobody.whose)
  await api.eval(`document.querySelector('.lt-row[data-line="moderation"] .lt-toggle').click()`)
  await api.eval(`document.querySelector('.lt-parts[data-line="moderation"] button.part[data-part="labour"]').click()`)
  const nobodyHow = await api.eval(`({ today: document.getElementById('how-today').textContent, nostr: document.getElementById('how-nostr').textContent, items: [...document.querySelectorAll('#how-list .how__item')].map(i => i.textContent.replace(/\\s+/g, ' ').trim()) })`)
  check('its dialog says nothing is spent and what the benchmark would be, resting on the benchmark rows', nobodyHow.today === 'Nobody moderates today: nothing is spent.' && /^Nothing is saved\. Benchmarks would put this at [\d.]+ people, \$[\d,]+ a year\.$/.test(nobodyHow.nostr) && nobodyHow.items.length === 4 && nobodyHow.items.some(i => i.startsWith('Moderators per million monthly users')), JSON.stringify(nobodyHow))
  await api.eval(`document.getElementById('how-modal').close()`)

  // ── the payback figure, the services band and the sign disclosure ─────────
  await api.goto(`${BASE}/calculator/`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  await api.eval(`document.getElementById('save-open').click()`)
  const disclosure = await api.eval(`({ open: document.getElementById('save-modal').open, save: document.getElementById('save-submit').textContent, closed: !document.getElementById('save-sign').open, summary: document.querySelector('#save-sign summary').textContent, chipInside: document.querySelector('#save-sign #sign-signed') !== null, mining: document.getElementById('save-mining').getAttribute('aria-live') })`)
  check('the modal opens on one button, Book a free consult with these results, with the signing options folded under "Already on Nostr?"', disclosure.open && disclosure.save === 'Book a free consult with these results' && disclosure.closed && disclosure.summary === 'Already on Nostr? Sign with your key' && disclosure.chipInside && disclosure.mining === 'polite', JSON.stringify(disclosure))
  await api.eval(`document.getElementById('save-sign').open = true; document.getElementById('save-sign-open').click()`)
  check('its button opens the sign dialog with the three doors', await api.eval(`document.getElementById('sign-modal').open && document.getElementById('sign-extension') !== null && document.getElementById('sign-bunker') !== null && document.getElementById('sign-session') !== null`))
  await api.eval(`document.getElementById('sign-cancel').click(); document.getElementById('save-modal').close()`)

  // ── the tab bar on a phone ───────────────────────────────────────────────
  await api.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await api.goto(`${BASE}/calculator/`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const phone = await api.eval(`({ row: getComputedStyle(document.getElementById('tabs-current')).display, track: getComputedStyle(document.getElementById('calc-tabs')).display, label: document.querySelector('#tabs-current .tabs__current-tab').textContent.trim(), icon: Boolean(document.querySelector('#tabs-current .tab__icon')), expanded: document.getElementById('tabs-current').getAttribute('aria-expanded') })`)
  check('on a phone the bar is one row naming the active tab, the track folded', phone.row === 'flex' && phone.track === 'none' && phone.label === (await api.eval(`document.getElementById('tab-cost').textContent.trim()`)) && phone.icon && phone.expanded === 'false', JSON.stringify(phone))
  await api.eval(`document.getElementById('tabs-current').click()`)
  const dropped = await api.eval(`getComputedStyle(document.getElementById('calc-tabs')).display + ':' + document.getElementById('tabs-current').getAttribute('aria-expanded') + ':' + getComputedStyle(document.getElementById('tab-cost')).display + ':' + getComputedStyle(document.getElementById('tab-app')).display`)
  check('pressing the row drops the track, offering only the other tabs', dropped === 'flex:true:none:flex', dropped)
  await api.eval(`document.getElementById('tab-app').click()`)
  await sleep(200)
  const picked = await api.eval(`({ track: getComputedStyle(document.getElementById('calc-tabs')).display, label: document.querySelector('#tabs-current .tabs__current-tab').textContent.trim(), tab: document.getElementById('tabs-current').dataset.tab, selected: document.getElementById('tab-app').getAttribute('aria-selected'), gold: getComputedStyle(document.getElementById('tabs-current')).color === getComputedStyle(document.getElementById('tab-app')).color })`)
  check('picking a tab folds the track and the row takes its name and colour', picked.track === 'none' && picked.tab === 'app' && picked.selected === 'true' && picked.label === (await api.eval(`document.getElementById('tab-app').textContent.trim()`)) && picked.gold, JSON.stringify(picked))
  await api.send('Emulation.clearDeviceMetricsOverride')

  // ── a shared link ─────────────────────────────────────────────────────────
  const link = after.link
  await api.goto(link + '&test=1')
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const shared = await api.eval(`({
    hidden: document.getElementById('calc-results').hidden,
    status: document.getElementById('r-status').textContent,
    mau: (() => { const s = document.getElementById('f-mau'); return s.dataset.values.split(',')[s.value] })(),
    ts: (() => { const s = document.querySelector('input[name=eng_content]'); return s.dataset.values.split(',')[s.value] })(),
    egress: document.getElementById('a-egress_gb_per_mau_month').value,
    url: location.search,
  })`)
  check('a results link opens straight to the results', !shared.hidden)
  check('…on the Estimated Cost tab', (await api.eval(`document.getElementById('tab-cost').getAttribute('aria-selected')`)) === 'true')
  check('…says nothing was submitted', shared.status.includes('Nothing was submitted'), shared.status)
  check('…fills the form from the link', shared.mau === '50000' && shared.ts === '25', `${shared.mau} ${shared.ts}`)
  check('…and the assumption override', shared.egress === '5', shared.egress)
  check('the test marker survives in the page URL', shared.url.includes('test=1'), shared.url)

  // ── saving: a fixture form on a local relay ───────────────────────────────
  // The committed snapshot's questions are republished to `nak serve` under a
  // throwaway key, the snapshot is swapped for that fixture while the test
  // runs (so the page encrypts to a key the test holds), the page submits,
  // and the response is read back as the form holder would. The committed
  // snapshot is restored afterwards.
  let committed = null
  try {
    committed = await readFile(SNAPSHOT, 'utf8')
  } catch {
    committed = null
  }
  if (!committed) {
    console.log('--   no form snapshot is committed; the saving path is not exercised')
  } else {
    const stopRelay = await localRelay(PORT, { spawn })
    const pool = new SimplePool()
    try {
      const base = await readSnapshot()
      const fixture = fixtureTemplate(base, RELAY)
      await Promise.allSettled(pool.publish([RELAY], fixture.event))
      const snapshot = parseTemplate(fixture.event)
      await writeFile(SNAPSHOT, snapshotYaml(snapshot, base.naddr))
      // The dev server rebuilds; the page then carries the fixture form.
      for (let i = 0; i < 60; i++) {
        await api.goto(`${BASE}/calculator/?relay=${encodeURIComponent(RELAY)}`)
        await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
        const pk = await api.eval(`JSON.parse(document.getElementById('page-form').textContent)?.pubkey`)
        if (pk === fixture.pubkey && (await api.eval(`document.documentElement.dataset.calculatorForm`)) === 'ready') break
        await sleep(1000)
      }
      check('the page carries the form', (await api.eval(`document.documentElement.dataset.calculatorForm`)) === 'ready')

      await api.eval(`(() => {
        const f = document.getElementById('calc-form')
        const slide = (name, value) => { const s = f.querySelector('input[name=' + name + ']'); s.value = s.dataset.values.split(',').indexOf(value); s.dispatchEvent(new Event('input', { bubbles: true })) }
        slide('mau', '10000'); slide('eng_infra', '25'); slide('n_media_storage', '0.5')
        f.querySelector('input[name=jur][value=us]').checked = true
        document.getElementById('save-open').click()
      })()`)
      check('Save & Share opens the modal with Send on (nothing is required) and the copy link on', (await api.eval(`document.getElementById('save-modal').open + ':' + document.getElementById('save-submit').disabled + ':' + document.getElementById('save-copy').disabled + ':' + document.getElementById('save-copy').textContent.trim()`)) === 'true:false:false:Copy URL for Sharing')
      await api.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: BASE })
      await api.send('Page.bringToFront')
      await sleep(300)
      await api.eval(`document.getElementById('save-copy').click()`)
      await sleep(300)
      const copied = await api.eval(`document.getElementById('save-copy').className + ' | ' + location.search + ' | ' + document.getElementById('save-status').textContent`)
      const clipboard = await api.eval(`navigator.clipboard.readText().catch(() => '')`)
      check('the copy link copies the form\'s URL and shows the check', (copied.includes('is-copied') && clipboard.includes('mau=10000')) || copied.includes('?mau=10000') || copied.includes('&mau=10000'), copied + ' | clipboard: ' + clipboard)
      check('…with nothing listed as needed', (await api.eval(`document.getElementById('save-needed').textContent`)) === '')
      check('the modal was hidden before it was opened', !(await api.eval(`getComputedStyle(document.getElementById('sign-modal')).display !== 'none'`)))
      check('the consent line sits right under the email field', (await api.eval(`document.getElementById('field-email').nextElementSibling.classList.contains('choice--consent')`)))
      await api.eval(`(() => {
        const f = document.getElementById('calc-form')
        const set = (name, v) => { f.elements[name].value = v; f.elements[name].dispatchEvent(new Event('input', { bubbles: true })) }
        set('app_name', 'Example App'); set('email', 'founder@example.com'); set('company', 'Example'); set('contact_name', 'Founder')
      })()`)
      check('required answers alone do not enable Save once an email is given; consent is needed', await api.eval(`document.getElementById('save-submit').disabled`))
      check('the modal says what is still needed', (await api.eval(`document.getElementById('save-needed').textContent`)) === 'Still needed: your consent to email')
      await api.eval(`{ const c = document.getElementById('f-consent'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })) }`)
      check('consent enables Send', (await api.eval(`document.getElementById('save-submit').disabled`)) === false)
      await sleep(3200) // past the too-fast guard
      await api.eval(`document.getElementById('save-submit').click()`)
      check('Save to Nostr asks how to sign', await api.eval(`document.getElementById('sign-modal').open && !document.getElementById('bunker-panel').hidden === false`))
      check('the disposable key is explained', (await api.eval(`document.getElementById('sign-session').textContent`)).includes('Close the tab and it is gone'))
      await api.eval(`document.getElementById('sign-session').click()`)
      check('choosing it closes the sign dialog', !(await api.eval(`document.getElementById('sign-modal').open`)))
      await api.waitFor(`/Sent · |Could not reach/.test(document.getElementById('save-status').textContent)`, { timeout: 60000 })
      const status = await api.eval(`document.getElementById('save-status').textContent`)
      check('the modal reports the send with the event id', /Sent · 1 of 1 relays · event [0-9a-f]{12}/.test(status), status)

      const got = await pool.querySync([RELAY], { kinds: [KIND_RESPONSE], '#a': [formAddress(snapshot)] }, { maxWait: 4000 })
      check('one kind 1069 landed on the relay', got.length === 1, String(got.length))
      const ev = got[0]
      if (ev) {
        check('it is signed, and carries the configured proof of work', verifyEvent(ev) && getPow(ev.id) >= 20, `${getPow(ev.id)} bits`)
        const answers = JSON.parse(decrypt(ev.content, getConversationKey(fixture.secret, ev.pubkey)))
        const byId = Object.fromEntries(snapshot.fields.map((f) => [f.id, f.label]))
        const byLabel = Object.fromEntries(answers.map(([, id, v]) => [byId[id], v]))
        check('the form secret decrypts the page\'s answers', byLabel['How many Monthly Active Users (MAU)'] === '10000' && byLabel['Contact Email'] === 'founder@example.com' && byLabel['Company Name'] === 'Example' && byLabel['Contact Name'] === 'Founder' && byLabel['App Name'] === 'Example App', JSON.stringify(byLabel))
        const stored = await api.eval(`sessionStorage.getItem('nostr4.session-key')`)
        check('the response is signed by the tab\'s disposable key', Boolean(stored) && ev.pubkey === getPublicKey(hexToBytes(stored)), ev.pubkey.slice(0, 12))
        check('the computed figures and the link travel with the inputs', /^\d+$/.test(byLabel['Annual custodial cost (USD, typical)'] || '') && (byLabel['Results link'] || '').includes('mau=10000'), byLabel['Results link'])
        check('the fees saved travel as their own question; nothing about payback or integration does', /^\d+$/.test(byLabel['Fees saved (estimated)'] || '') && !('Payback month' in byLabel) && !('Integration weeks (typical)' in byLabel), JSON.stringify([byLabel['Fees saved (estimated)'], byLabel['Payback month'], byLabel['Integration weeks (typical)']]))
        const testField = snapshot.fields.find((f) => f.id === 'XU5x6e')
        check('the test marker travels as the form\'s own option while the box is on', byLabel[testField.label] === testField.options[0].id, JSON.stringify(byLabel[testField.label]))
        const consentTag = answers.find((a) => a[0] === 'consent')
        check('consent is recorded in the response with the consent text\'s version and the time', consentTag && consentTag[1] === '1' && /^\d{4}-\d\d-\d\dT/.test(consentTag[2]), JSON.stringify(consentTag))
        const engLabel = 'How many developer hours per week spent on the following:'
        const nostrLabel = 'Your app uses Nostr for the following:'
        const eng = JSON.parse(byLabel[engLabel] || '{}')
        const nostr = JSON.parse(byLabel[nostrLabel] || '{}')
        check('grid answers arrive as row id to column id, only for the sliders that were moved', Object.keys(eng).length === 1 && Object.keys(nostr).length === 1, `${byLabel[engLabel]} ${byLabel[nostrLabel]}`)
      }
      // A lead with contact details also goes to hello's inbox as a gift wrap.
      // It is mined after the save is reported, so give it time.
      let wraps = []
      for (let i = 0; i < 30 && wraps.length === 0; i++) {
        wraps = await pool.querySync([RELAY], { kinds: [1059] }, { maxWait: 2000 })
        if (!wraps.length) await sleep(1000)
      }
      check('a lead message was gift-wrapped to the inbox', wraps.length === 1 && getPow(wraps[0].id) >= 18, `${wraps.length} wraps`)
      // A second save from the same tab comes from the same key and does not re-send the lead; with the test box cleared it is a real one.
      if (SHOTS) await snap(api, join(SHOTS, 'modal-1440.png'))
      await api.eval(`{ const c = document.getElementById('f-consent'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('f-test').checked = false; document.getElementById('save-submit').click() }`)
      await sleep(200)
      await api.eval(`document.getElementById('sign-session').click()`)
      await api.waitFor(`/Sent · /.test(document.getElementById('save-status').textContent) && document.getElementById('save-submit').disabled === false`, { timeout: 60000 })
      await sleep(500)
      const again = await pool.querySync([RELAY], { kinds: [KIND_RESPONSE], '#a': [formAddress(snapshot)] }, { maxWait: 4000 })
      const wrapsAgain = await pool.querySync([RELAY], { kinds: [1059] }, { maxWait: 2000 })
      check('a second save in the same tab comes from the same key', again.length === 2 && new Set(again.map((e) => e.pubkey)).size === 1, `${again.length} responses, ${new Set(again.map((e) => e.pubkey)).size} key(s)`)
      if (again.length === 2) {
        const newest = [...again].sort((a, b) => b.created_at - a.created_at)[0]
        const later = JSON.parse(decrypt(newest.content, getConversationKey(fixture.secret, newest.pubkey)))
        check('with the test box cleared, the second response carries no test marker', !later.some(([, id, v]) => id === 'XU5x6e' && v), JSON.stringify(later.find(([, id]) => id === 'XU5x6e') || null))
      }
      check('an unchanged lead is not sent twice', wrapsAgain.length === 1, `${wrapsAgain.length} wraps`)

      // ── opening the sent response from its link, in the same tab ──────────
      const { neventEncode } = await import('nostr-tools/nip19')
      const nevent = neventEncode({ id: ev.id, relays: [RELAY], author: ev.pubkey })
      await api.goto(`${BASE}/calculator/?nevent=${nevent}&relay=${encodeURIComponent(RELAY)}`)
      await api.waitFor(`/Opened a response sent/.test(document.getElementById('r-status').textContent) || /not found|sign in/i.test(document.getElementById('r-status').textContent)`, { timeout: 20000 })
      const restored = await api.eval(`({
        status: document.getElementById('r-status').textContent,
        mau: (() => { const s = document.getElementById('f-mau'); return s.dataset.values.split(',')[s.value] })(),
        email: document.getElementById('f-email').value,
        tab: document.getElementById('tab-cost').getAttribute('aria-selected'),
      })`)
      check('the tab\'s key opens the sent response and fills the page', restored.status.includes('with the key that sent it') && restored.mau === '10000' && restored.email === 'founder@example.com' && restored.tab === 'true', JSON.stringify(restored))
      await api.eval(`sessionStorage.clear()`)
      await api.goto(`${BASE}/calculator/?nevent=${nevent}&relay=${encodeURIComponent(RELAY)}`)
      await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
      await sleep(500)
      check('without that key the page asks for a signer', (await api.eval(`document.getElementById('sign-modal').open + ':' + document.getElementById('r-status').textContent`)).startsWith('true:To open a sent response'))
      await api.eval(`document.getElementById('sign-cancel').click()`)
    } finally {
      pool.destroy()
      stopRelay()
      await writeFile(SNAPSHOT, committed)
      // Wait for the dev server to carry the real form again, so later runs start clean.
      for (let i = 0; i < 60; i++) {
        const html = await (await fetch(`${BASE}/calculator/`)).text().catch(() => '')
        if (html.includes('9e8b472eda9cf77668a0753534ed12a7b1e74e9773545b1cd02fe776df080959')) break
        await sleep(1000)
      }
    }
  }

  // ── hygiene ───────────────────────────────────────────────────────────────
  const foreign = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:') && !u.startsWith(RELAY))
  check('no third-party requests', foreign.length === 0, foreign.join(' '))
  check('no console errors', logs.length === 0, logs.join(' | '))
})

async function snap(api, file) {
  await api.eval(`window.scrollTo(0, 0)`)
  const { data } = await api.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(file, Buffer.from(data, 'base64'))
  console.log(`     wrote ${file}`)
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
