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
  check('the test checkbox sits beside Send, on by default, in the form\'s own words', testBox.checked && testBox.form === 'calc-form' && testBox.text === 'test' && testBox.title.startsWith('test submission') && testBox.beside === 'save-submit' && testBox.row === 'modal__send' && testBox.row !== 'modal__actions', JSON.stringify(testBox))
  const first = await api.eval(`({
    whose: document.getElementById('r-whose-text').textContent, link: document.getElementById('r-whose-link').textContent,
    hero: document.querySelector('#chart-custodial-cost-vs-nostr .chart__watermark').textContent, sub: document.querySelector('#chart-custodial-cost-vs-nostr .chart__watermark-sub').textContent,
    gold: getComputedStyle(document.querySelector('#panel-cost .chart')).borderLeftWidth, heroCard: Boolean(document.querySelector('.savings__hero')),
    lines: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr polyline')].map(p => p.getAttribute('class') + ':' + p.getAttribute('points').split(' ').length),
    starts: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr polyline')].map(p => p.getAttribute('points').split(' ')[0]),
    markers: document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__marker, #chart-custodial-cost-vs-nostr .chart__marker--custodial').length,
    labels: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__marks text')].map(t => t.textContent),
    legend: [...document.querySelectorAll('#panel-cost .legend--chart .legend__item')].map(l => l.textContent.trim()),
    title: document.getElementById('chart-custodial-cost-vs-nostr-title').textContent,
    cumulative: Boolean(document.getElementById('chart-cumulative-savings')),
    top: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__axis--top text')].map(t => t.textContent),
    bottom: [...document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__axis--bottom text')].map(t => t.textContent),
    years: document.querySelectorAll('#r-years thead th[data-year]').length,
    yearOne: document.querySelector('#r-years thead th[data-year]').textContent,
    measures: [...document.querySelectorAll('#r-years tbody th')].map(t => t.textContent).join(' | '),
    cells: document.querySelectorAll('#r-years tbody td').length,
    width: document.getElementById('chart-custodial-cost-vs-nostr').getAttribute('viewBox').split(' ')[2] + ':' + Math.round(document.getElementById('chart-custodial-cost-vs-nostr').getBoundingClientRect().width),
  })`)
  check('a fresh page says whose estimate it shows, describes the app section by section, and invites the visitor in', first.whose.startsWith('Estimated for') && first.whose.includes('50,000') && first.whose.includes('the US') && first.whose.endsWith('.') && first.link === 'Customize App Details', `${first.whose} / ${first.link}`)
  const bar = await api.eval(`({ illustrative: document.getElementById('tabbar').classList.contains('is-illustrative'), ring: getComputedStyle(document.getElementById('tab-app')).boxShadow, gold: getComputedStyle(document.getElementById('tab-app')).color !== getComputedStyle(document.getElementById('tab-cost')).color, share: document.getElementById('save-open').className, sticky: getComputedStyle(document.getElementById('tabbar')).position, quiet: parseFloat(getComputedStyle(document.getElementById('tab-assumptions')).fontSize) < parseFloat(getComputedStyle(document.getElementById('tab-cost')).fontSize) })`)
  check('on a fresh page App Details is gold with no ring, Send & Share is outlined, the bar sticks, Assumptions is the quiet tab', bar.illustrative && bar.ring === 'none' && bar.gold && bar.share.includes('btn--secondary') && bar.sticky === 'sticky' && bar.quiet, JSON.stringify(bar))
  check('the pieces the openers assumed are drawn quiet, the given ones bright (the team size among them), and the link is gold', (await api.eval(`document.querySelectorAll('#r-whose-text .whose__fact--assumed').length + ':' + document.querySelectorAll('#r-whose-text .whose__fact:not(.whose__fact--assumed)').length + ':' + getComputedStyle(document.getElementById('r-whose-link')).color`)) === `4:3:${await api.eval(`getComputedStyle(document.getElementById('tab-app')).color`)}`)
  check('no headline sentence: the saving a year at scale is the gold watermark in the chart\'s gap, and the hero card is gone', !(await api.eval(`document.getElementById('r-headline')`)) && /^\$\d+(\.\d+)?[kM]$/.test(first.hero) && first.sub === 'savings per year' && !first.heroCard && first.gold !== '1px', `${first.hero} / ${first.sub} / rail ${first.gold}`)
  const goldMark = await api.eval(`getComputedStyle(document.querySelector('.chart__watermark')).fill === getComputedStyle(document.querySelector('.chart__marker--scale')).fill && getComputedStyle(document.querySelector('.chart__scale-rule')).stroke === getComputedStyle(document.querySelector('.chart__marker--scale')).fill && parseFloat(getComputedStyle(document.querySelector('.chart__watermark')).fontSize) >= 48`)
  check('the watermark is gold, like the two dots and the rule between them, and larger than before', goldMark)
  check('the one chart has a custody line and a Nostr path, a point per year, from one start', first.lines.length === 2 && first.lines[0] === 'chart__line chart__line--custodial:6' && first.lines[1] === 'chart__line:6' && first.starts[0] === first.starts[1] && !first.cumulative, `${first.lines.join(' ')} ${first.starts.join(' ')}`)
  check('a marker on every year plus the two at scale, and no labels on them: only the watermark', first.markers === 13 && first.labels.length === 2 && first.labels[0] === first.hero && first.labels[1] === first.sub, `${first.markers} | ${first.labels.join(' | ')}`)
  const scaleDots = await api.eval(`(() => {
    const dots = [...document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__marker--scale')]
    const at = (i) => document.querySelectorAll('#chart-custodial-cost-vs-nostr polyline')[i].getAttribute('points').split(' ')[3].split(',').map(Number)
    const on = (d, p) => Math.abs(parseFloat(d.getAttribute('cx')) - p[0]) < 0.6 && Math.abs(parseFloat(d.getAttribute('cy')) - p[1]) < 0.6
    const rule = document.querySelector('#chart-custodial-cost-vs-nostr .chart__scale-rule')
    const text = document.querySelector('#chart-custodial-cost-vs-nostr .chart__watermark')
    return { n: dots.length, r: dots.map(d => d.getAttribute('r')).join(','), onCustody: on(dots[0], at(0)), onNostr: on(dots[1], at(1)), fill: getComputedStyle(dots[0]).fill, plain: getComputedStyle(document.querySelector('#chart-custodial-cost-vs-nostr .chart__marker:not(.chart__marker--scale)')).fill, gold: getComputedStyle(document.getElementById('tab-app')).color,
      rule: rule && rule.getAttribute('x1') === rule.getAttribute('x2') && Math.abs(parseFloat(rule.getAttribute('x1')) - at(0)[0]) < 0.6 && Math.abs(parseFloat(rule.getAttribute('y1')) - at(0)[1]) < 0.6 && Math.abs(parseFloat(rule.getAttribute('y2')) - at(1)[1]) < 0.6,
      right: text && parseFloat(text.getAttribute('x')) > at(0)[0] && text.getAttribute('text-anchor') === 'start' }
  })()`)
  check('at year three a gold dot sits on each line, a gold rule joins them, and the watermark stands to its right', scaleDots.n === 2 && scaleDots.r === '7,7' && scaleDots.onCustody && scaleDots.onNostr && scaleDots.fill !== scaleDots.plain && scaleDots.fill === scaleDots.gold && scaleDots.rule && scaleDots.right, JSON.stringify(scaleDots))
  check('the legend names the two lines in the page\'s words', first.legend.join(' / ') === 'Cost of Custody / Cost of Nostr', first.legend.join(' / '))
  check('the picture carries its small title at the top left, with the legend just under it', (await api.eval(`document.querySelector('#panel-cost .chart > .chart__title').textContent + ':' + document.querySelector('#panel-cost .chart > .chart__title').nextElementSibling.className`)) === 'Projected Nostr Integration:legend legend--chart')
  check('the chart is described, and the year-by-year table runs the calendar years across and the measures down', first.title.includes('In 2030, when Nostr is at scale') && first.title.includes('over five years') && first.years === 5 && first.yearOne === '2028' && first.measures === 'Active users | Cost of Custody | Cost of Nostr | Saved | Cumulative Savings' && first.cells === 25, `${first.years} ${first.yearOne} | ${first.measures} | ${first.cells} | ${first.title}`)
  check('the chart is drawn at the figure\'s own width', first.width.split(':')[0] === first.width.split(':')[1], first.width)
  check('the calendar runs along the top from today, 2028 to 2032, with no gutter to name it', first.top.join(' | ') === 'Today | 2028 | 2029 | 2030 | 2031 | 2032', first.top.join(' | '))
  check('projected users run along the bottom as first and last, the axis named between them; the illustrative app grows at Steady', first.bottom.join(' | ') === '50k | 101k | Active Users', first.bottom.join(' | '))
  check('the plot runs to the right edge now that the gutter is gone', await api.eval(`(() => { const svg = document.getElementById('chart-custodial-cost-vs-nostr'); const w = svg.viewBox.baseVal.width; const last = [...svg.querySelectorAll('.chart__axis--top text')].pop(); return w - parseFloat(last.getAttribute('x')) < 30 })()`))
  await api.eval(`document.querySelector('#chart-custodial-cost-vs-nostr .chart__hit[data-year="3"]').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))`)
  const tip = await api.eval(`({ hidden: document.getElementById('tip-chart-custodial-cost-vs-nostr').hidden, text: document.getElementById('tip-chart-custodial-cost-vs-nostr').textContent, cross: document.querySelector('#chart-custodial-cost-vs-nostr .chart__cross').hasAttribute('hidden'), dots: document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__dot:not([hidden])').length })`)
  check('hovering a year shows a four-line tooltip headed by its calendar year, users first, crosshair and a dot on each line', !tip.hidden && !tip.cross && tip.dots === 2 && tip.text.startsWith('2030') && /2030[\d,]+ active users/.test(tip.text) && tip.text.includes('Cost of Custody') && tip.text.includes('Cost of Nostr') && tip.text.includes('Cumulative Savings'), tip.text)
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
  check('the questions the page fills are not drawn; the test marker is, as the checkbox beside Send', await api.eval(`!document.querySelector('[name=link], [name=result_custodial], [name=version]') && document.querySelector('#save-modal [name=test]') !== null`))
  check('the required choices start with their defaults', await api.eval(`(() => {
    const on = [...document.querySelectorAll('#calc-form input:checked')].map(i => i.name + '=' + i.value).sort().join(' ')
    return on
  })()`) === 'jur=us')
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
  check('each section opens with its opener, whatever order the event lists, and the rest fold under a toggle', openers.first.join(' ') === 'nostr_now mau kind mod_who team rev jur' && openers.folded.every(Boolean) && openers.toggles.every(t => t === 'Add more details'), `${openers.first.join(' ')} | ${openers.folded.join(' ')}`)
  check('the scale questions are sliders, the lists run inline, the cards are numbered', openers.scales.join(' ') === 'nostr_now:3 growth:4 mod_heads:6 team:4' && openers.inline.join(' ') === 'field-kind field-mod_who field-jur' && openers.steps === '1234567' && openers.intro === 'Seven' && openers.title === 'Your App Details:false', `${openers.scales.join(' ')} | ${openers.inline.join(' ')} | ${openers.steps}`)
  check('a fresh page shows the derived defaults as suggestions on the untouched sliders, openers included; the team size and growth are answers, not suggestions', openers.suggested === 'eng_accounts eng_content eng_infra eng_legal mb n_algos n_event_storage n_feeds n_keys n_labels n_media_storage n_nips n_p2p n_raw_keys n_signed_events nostr_now posts_per_user' && Number(openers.hint) < 1 && (await api.eval(`['team', 'growth'].map(n => { const s = document.querySelector('input[name=' + n + ']'); return s.dataset.touched + ':' + s.dataset.values.split(',')[s.value] }).join(' ')`)) === '1:ten 1:0.25', `${openers.suggested} | opacity ${openers.hint}`)
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
  check('Reset Values clears the answers, folds the sections, restores the suggestions and the illustrative estimate', reset.kind === null && reset.mb === '50' && reset.suggested && reset.folded && reset.hero === heroBeforeKind && reset.url === '' && reset.mau === '50000' && reset.place === 'space-between', JSON.stringify(reset))
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
  check('every assumption is on the page with an editable typical value', (await api.eval(`document.querySelectorAll('.assume-input').length`)) === 102)
  const thesis = await api.eval(`(() => { const groups = [...document.querySelectorAll('.assume__group')].map(h => h.textContent); const first = document.querySelector('.assume__group'); return { groups, preamble: first.nextElementSibling.className, rows: first.nextElementSibling.nextElementSibling.querySelectorAll('tr[data-key]').length, thesisRows: document.querySelectorAll('tr.is-thesis').length, inThesis: [...first.nextElementSibling.nextElementSibling.querySelectorAll('tr[data-key]')].map(r => r.dataset.key).includes('scale_months'), intro: document.querySelector('.assume__intro').textContent } })()`)
  check('the rows that move the band are grouped first under "At scale: Nostr4\'s thesis" with one preamble, and the intro says the band is the thesis', thesis.groups[0] === "At scale: Nostr4's thesis" && thesis.preamble === 'assume__preamble' && thesis.rows === 20 && thesis.thesisRows === 20 && thesis.inThesis && thesis.intro.includes('not about cloud pricing'), JSON.stringify(thesis))

  check('number sliders start on their defaults', (await api.eval(`(() => {
    const v = (n) => { const s = document.querySelector('input[name=' + n + ']'); return s.dataset.values.split(',')[s.value] + '=' + s.closest('.slider-row').querySelector('output').textContent }
    return [v('mau'), v('posts_per_user'), v('mb'), v('rev'), v('legal_usd')].join(' ')
  })()`)) === '50000=50k 20=20 50=50 MB 0=0 0=0')

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
  check('…and the results stay hidden', await api.eval(`document.getElementById('calc-results').hidden`))
  await api.goto(`${BASE}/calculator/`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)

  // ── a full calculation ────────────────────────────────────────────────────
  await api.eval(`(() => {
    const f = document.getElementById('calc-form')
    const slide = (name, value) => { const s = f.querySelector('input[name=' + name + ']'); s.value = s.dataset.values.split(',').indexOf(value); s.dispatchEvent(new Event('input', { bubbles: true })) }
    slide('mau', '50000'); slide('rev', '20000')
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
      permauC: $('#r-permau-c').textContent, permauCRange: $('#r-permau-c-range').textContent, permauNC: $('#r-permau-nc').textContent, permauNCRange: $('#r-permau-nc-range').textContent, scale: $('#r-scale-nostr').textContent, scaleRange: $('#r-scale-nostr-range').textContent, cumulative: $('#r-cumulative').textContent,
      eyebrows: [...document.querySelectorAll('#panel-cost .stat .eyebrow--gold')].map(e => e.textContent),
      yearTwoUsers: $('#r-years tbody tr[data-row=users] td:nth-child(3)').textContent,
      version: $('#r-version').textContent,
      accountsSaving: row('accounts').querySelector('.lt-saving').textContent,
      accountsPct: row('accounts').querySelector('.share__pct').textContent,
      badges: document.querySelectorAll('#r-table .badge').length,
      toggle: row('accounts').querySelector('.lt-toggle').textContent,
      shares: [...document.querySelectorAll('.lt-row .share')].map(b => parseFloat(b.style.getPropertyValue('--w'))),
      storageCut: row('storage').querySelector('.share__pct').textContent,
      editLink: $('#r-edit').className + ':' + getComputedStyle($('.results__actions')).justifyContent,
      versionAlign: getComputedStyle($('#r-version')).textAlign,
      tabFill: getComputedStyle($('#tab-cost')).backgroundColor + '|' + getComputedStyle($('#tab-app')).backgroundColor,
      illustrative: document.getElementById('tabbar').classList.contains('is-illustrative'),
      share: document.getElementById('save-open').className,
      sum: [...document.querySelectorAll('.lt-row .lt-saving')].reduce((a, n) => a + Number(n.textContent.replace(/[^\\d]/g, '')), 0),
      footRows: document.querySelectorAll('#r-table tfoot tr').length,
      nudges: document.querySelectorAll('.lt-nudge:not([hidden])').length,
      subtitle: $('.results__sub').textContent,
      link: location.href,
      url: location.search,
      error: $('#calc-error').hidden,
      focused: document.activeElement?.id,
    }
  })()`)
  check('the watermark is the saving a year at scale, compact, and the third chip is the Nostr cost that year, a different figure', /^\$\d+(\.\d+)?[kM]$/.test(r.hero) && /^\$\d+(\.\d+)?[kM]$/.test(r.scale) && r.hero !== r.scale, `${r.hero} | ${r.scale}`)
  check('the three facts are per user at scale (no range: the custodial side does not vary), per user on Nostr with its range in reading order, and the Nostr cost a year at scale with its range, under gold eyebrows', /^\$\d+\.\d\d$/.test(r.permauC) && r.permauCRange === '' && /^\$\d+\.\d\d$/.test(r.permauNC) && /^Range \$(\d+\.\d\d) to \$(\d+\.\d\d)$/.test(r.permauNCRange) && parseFloat(r.permauNCRange.match(/\$([\d.]+) to/)[1]) <= parseFloat(r.permauNCRange.match(/to \$([\d.]+)/)[1]) && /^Range \$/.test(r.scaleRange) && r.eyebrows.join(' | ') === 'Custodial Cost per User | Nostr Cost per User | Nostr Cost per Year', `${r.permauC} [${r.permauCRange}] ${r.permauNC} [${r.permauNCRange}] ${r.scale} [${r.scaleRange}] | ${r.eyebrows.join(' | ')}`)
  check('the five years of saving sit on the year-by-year summary', /^\$[\d.]+[kM] saved over five years$/.test(r.cumulative), r.cumulative)
  const col = await api.eval(`(() => { const n = (row, i) => Number(document.querySelector('#r-years tbody tr[data-row=' + row + '] td:nth-child(' + (i + 1) + ')').textContent.replace(/[^\\d]/g, '')); return { users: n('users', 3), custodial: n('custodial', 3), path: n('path', 3) } })()`)
  check('the two per-user facts are the 2030 column of the table divided by that year\'s users, and the third is its Nostr cost', Math.abs(parseFloat(r.permauC.slice(1)) - col.custodial / col.users) < 0.01 && Math.abs(parseFloat(r.permauNC.slice(1)) - col.path / col.users) < 0.01 && Math.abs(parseFloat(r.scale.replace(/[^\d.]/g, '')) * (r.scale.endsWith('M') ? 1e6 : r.scale.endsWith('k') ? 1e3 : 1) - col.path) / col.path < 0.01, `${r.permauC} vs ${col.custodial}/${col.users} | ${r.permauNC} vs ${col.path}/${col.users} | ${r.scale} vs ${col.path}`)
  check('after Calculate the tab says it is the visitor\'s estimate', r.whose.startsWith('Your estimate') && r.whose.includes('50,000') && r.whose.includes('$20k') && r.whose.includes('the EU') && r.whoseLink === 'Customize App Details', `${r.whose} / ${r.whoseLink}`)
  check('growth compounds in the year-by-year table (50% then decayed)', r.yearTwoUsers === '103,125', r.yearTwoUsers)
  check('each line shows its saving a year at scale in full, its share as a percentage, and no pills', /^\$[\d,]+$/.test(r.accountsSaving) && /^[\d.]+%$/.test(r.accountsPct) && r.badges === 0 && r.toggle === 'Show the Savings', `${r.accountsSaving} | ${r.accountsPct} | ${r.badges} badges | ${r.toggle}`)
  check('each bar is the share of that line\'s own cost that goes away', r.shares.length === 6 && r.shares.every(x => x >= 0 && x <= 100) && /^\d+(\.\d+)?%$/.test(r.storageCut) && parseFloat(r.storageCut) > 50, `${r.shares.join(' ')} | storage ${r.storageCut}`)
  check('the bottom link is a centred link, the version sits right, and the active tab is a filled segment', r.editLink === 'linkbutton results__edit:center' && r.versionAlign === 'right' && r.tabFill.split('|')[0] !== r.tabFill.split('|')[1], `${r.editLink} | ${r.versionAlign} | ${r.tabFill}`)
  check('once the estimate is the visitor\'s own, the gold ring goes and Send & Share is filled', !r.illustrative && r.share.includes('btn--primary') && !r.share.includes('btn--secondary'), `${r.illustrative} ${r.share}`)
  check('the six lines add up to the figure in the chart, and there is no foot row', r.footRows === 0 && r.subtitle.trim().length > 0 && Math.abs(r.sum - parseFloat(r.hero.replace(/[^\d.]/g, '')) * (r.hero.endsWith('M') ? 1e6 : r.hero.endsWith('k') ? 1e3 : 1)) / r.sum < 0.01, `${r.sum} vs ${r.hero}`)
  check('the Nostr at Scale column names what remains, in the page\'s words', (await api.eval(`document.querySelector('#r-table thead .lt-remains').textContent + ' | ' + document.querySelector('.lt-row[data-line="payments"] .lt-remains').textContent.replace(/\\s+/g, ' ').trim()`)).startsWith('Nostr at Scale | Store rules still apply'))
  check('no nudge where every line with rails already saves', r.nudges === 0, String(r.nudges))
  check('the page URL carries the inputs and the version', r.link.includes('mau=50000') && r.link.includes('eng_content=25') && r.link.includes('jur=eu%2Cuk%2Cus') && r.link.includes('growth=0.5') && r.link.includes('team=ten') && r.link.endsWith('v=2'), r.link)
  check('sliders standing on "not given" or on a suggestion stay out of the link', !r.link.includes('n_keys=') && !r.link.includes('eng_legal=') && !r.link.includes('kind=') && r.link.includes('mod_who=team') && r.link.includes('mod_heads=3'), r.link)
  check('the version is named', r.version.includes('2'), r.version)
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
    const saved = Number(document.querySelector('.lt-row[data-line="payments"] .lt-saving').textContent.replace(/[^\\d]/g, ''))
    return { hidden: row.hidden, open: document.querySelector('.lt-row[data-line="payments"]').classList.contains('is-open'), totals: row.querySelector('.parts__totals').textContent.replace(/\\s+/g, ' ').trim(), gap: n('.parts__total-c') - n('.parts__total-nc'), saved, items: [...row.querySelectorAll('.part')].map(p => p.textContent.replace(/\\s+/g, ' ').trim()) }
  })()`)
  check('the savings open under the line, headed by two at-scale totals whose difference is the saving beside them', !parts.hidden && parts.open && parts.items.length === 4 && /^Cost of Custody \$[\d,]+ Cost of Nostr \$[\d,]+$/.test(parts.totals) && Math.abs(parts.gap - parts.saved) <= 1, `${parts.totals} | saved ${parts.saved} | ${parts.items.join(' | ')}`)
  check('a store part names its applied rate and tier', parts.items.some(t => /Apple App Store commission.*15%.*small-business tier/.test(t)), parts.items[0])
  await api.eval(`document.querySelector('.lt-row[data-line="compliance"] .lt-toggle').click()`)
  const risk = await api.eval(`(() => {
    const row = document.getElementById('parts-compliance')
    const items = [...row.querySelectorAll('.parts > li')].map(li => (li.classList.contains('parts__subtotal') ? 'SUB:' + li.querySelector('.parts__subtotal-label').textContent : li.querySelector('.part').dataset.part))
    const n = (li) => li.querySelector('.part__nums').textContent.split('→').map(x => Number(x.replace(/[^\\d]/g, '')))
    const subs = [...row.querySelectorAll('.parts__subtotal')].map(n)
    const parts = [...row.querySelectorAll('.parts > li:not(.parts__subtotal)')].map(n)
    const cash = parts.slice(0, 4).reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0])
    return { items, subs, cash, breach: parts[4], meta: row.querySelector('.part[data-part=breach] .part__meta')?.textContent }
  })()`)
  check('the compliance line lists its cash costs with a sub-total, then the expected breach loss as risk exposure with its own', risk.items.join(' ') === 'privacy_programs legal_labour dsar insurance SUB:Cash costs breach SUB:Risk exposure' && Math.abs(risk.subs[0][0] - risk.cash[0]) <= 2 && Math.abs(risk.subs[0][1] - risk.cash[1]) <= 2 && risk.subs[1][0] === risk.breach[0] && risk.subs[1][1] === risk.breach[1] && risk.meta === 'expected loss, not a bill', JSON.stringify(risk))

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
  check('the override travels in the link', after.link.includes('a.egress_gb_per_mau_month=5'), after.link)
  await api.eval(`document.getElementById('tab-assumptions').click(); document.getElementById('a-reset').click(); document.getElementById('a-recalc').click()`)
  await sleep(200)
  check('reset then Recalculate restores the typical value', (await api.eval(`document.querySelector('.lt-row[data-line="storage"] .lt-saving').textContent`)) === before)
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
  check('…and says what the at-scale figure in the list is', /^At scale \(2030, [\d,]+ users\): \$[\d,]+ of custody becomes \$[\d,]+ on Nostr/.test(how.scale), how.scale)
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
  for (const query of ['mau=50000&posts_per_user=20&eng_accounts=5&mod_who=team&mod_heads=15&team=ten&rails=p2p%2Capple%2Cgoogle%2Cprocessor%2Creseller&rev=50000&balances=yes&jur=eu%2Cuk%2Cus%2Cother&v=2', 'mau=10000000&rails=apple&rev=200000&legal_usd=50000&jur=us&v=1', 'mau=20000&mod_who=vendor&mod_heads=3&team=one&kind=messaging&nostr_now=0.5&jur=eu&v=2']) {
    await api.goto(`${BASE}/calculator/?${query}`)
    await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
    if (query.endsWith('v=1')) {
      // A version-1 link had no team question; it opens as the team size it assumed, under the current version, and says so.
      const older = await api.eval(`({ status: document.getElementById('r-status').textContent, hidden: document.getElementById('calc-results').hidden, team: document.querySelector('input[name=team]').dataset.values.split(',')[document.querySelector('input[name=team]').value], url: location.search })`)
      check('a results link made with version 1 opens under version 2 and says so', !older.hidden && older.status.startsWith('Opened from a results link made with assumptions version 1; shown with version 2.') && older.team === 'ten' && older.url.endsWith('v=2') && older.url.includes('team=ten'), JSON.stringify(older))
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

  // ── a nudge in place of a zero ───────────────────────────────────────────
  await api.goto(`${BASE}/calculator/?mau=50000&rails=apple%2Cgoogle&rev=10000&jur=us&team=ten&v=2`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const nudge = await api.eval(`(() => {
    const row = document.querySelector('.lt-row[data-line="payments"]')
    return { text: row.querySelector('.lt-nudge').textContent, nudgeHidden: row.querySelector('.lt-nudge').hidden, savingHidden: row.querySelector('.lt-saving').hidden, share: row.querySelector('.share').style.getPropertyValue('--w') }
  })()`)
  check('a payments line on store rails alone offers a peer-to-peer nudge instead of a zero', !nudge.nudgeHidden && nudge.savingHidden && /^Adds about \$[\d.]+[kM]? a year with a peer-to-peer rail\.$/.test(nudge.text) && nudge.share === '0%', JSON.stringify(nudge))

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
        const testField = snapshot.fields.find((f) => f.id === 'XU5x6e')
        check('the test marker travels as the form\'s own option while the box is on', byLabel[testField.label] === testField.options[0].id, JSON.stringify(byLabel[testField.label]))
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
