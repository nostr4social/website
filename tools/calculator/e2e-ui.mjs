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
  check('the modal holds the section\'s questions and no section of that name is on the tab', (await api.eval(`[...document.querySelectorAll('#save-modal [name]')].map(i => i.name).join(' ') + ' | ' + [...document.querySelectorAll('#calc-form .group__legend')].map(l => l.textContent.trim()).join(', ')`)) === 'app_name company contact_name email consent | Non Custody, Accounts & Storage, Staffing Costs, Payment Gateway, Availability & Growth')
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
  check('a fresh page says whose estimate it shows and invites the visitor in', first.whose === 'A typical estimate for an app with 50,000 active users.' && first.link === 'Customize App Details', `${first.whose} / ${first.link}`)
  check('the five-year saving is the watermark in the chart\'s gap, and the hero card is gone', /^\$\d+(\.\d+)?[kM]$/.test(first.hero) && first.sub === 'savings over five years' && !first.heroCard && first.gold !== '1px', `${first.hero} / ${first.sub} / rail ${first.gold}`)
  check('the one chart has a custody line and a Nostr path, a point per year, from one start', first.lines.length === 2 && first.lines[0] === 'chart__line chart__line--custodial:6' && first.lines[1] === 'chart__line:6' && first.starts[0] === first.starts[1] && !first.cumulative, `${first.lines.join(' ')} ${first.starts.join(' ')}`)
  check('a marker on every year, and no labels on them: only the watermark', first.markers === 11 && first.labels.length === 2 && first.labels[0] === first.hero && first.labels[1] === first.sub, `${first.markers} | ${first.labels.join(' | ')}`)
  check('the legend names the two lines in the page\'s words', first.legend.join(' / ') === 'Cost of Custody / Cost of Nostr', first.legend.join(' / '))
  check('the picture carries its small title at the top left, with the legend just under it', (await api.eval(`document.querySelector('#panel-cost .chart > .chart__title').textContent + ':' + document.querySelector('#panel-cost .chart > .chart__title').nextElementSibling.className`)) === 'Projected Nostr Integration:legend legend--chart')
  check('the chart is described, and the year-by-year table runs the years across and the measures down', first.title.includes('the area between them is') && first.years === 5 && first.yearOne === 'Year 1' && first.measures === 'Active users | Cost of Custody | Cost of Nostr | Saved | Cumulative Savings' && first.cells === 25, `${first.years} ${first.yearOne} | ${first.measures} | ${first.cells}`)
  check('the chart is drawn at the figure\'s own width', first.width.split(':')[0] === first.width.split(':')[1], first.width)
  check('the runway runs along the top from the start of integration, named in the gutter', first.top.join(' | ') === 'Start | Year 1 | Year 2 | Year 3 | Year 4 | Year 5 | Runway', first.top.join(' | '))
  check('projected users run along the bottom, one per year, named in the gutter', first.bottom.length === 7 && first.bottom[0] === '50k' && first.bottom[1] === '62.5k' && /k$/.test(first.bottom[5]) && first.bottom[6] === 'Users', first.bottom.join(' | '))
  await api.eval(`document.querySelector('#chart-custodial-cost-vs-nostr .chart__hit[data-year="3"]').dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))`)
  const tip = await api.eval(`({ hidden: document.getElementById('tip-chart-custodial-cost-vs-nostr').hidden, text: document.getElementById('tip-chart-custodial-cost-vs-nostr').textContent, cross: document.querySelector('#chart-custodial-cost-vs-nostr .chart__cross').hasAttribute('hidden'), dots: document.querySelectorAll('#chart-custodial-cost-vs-nostr .chart__dot:not([hidden])').length })`)
  check('hovering a year shows a three-line tooltip, crosshair and a dot on each line', !tip.hidden && !tip.cross && tip.dots === 2 && tip.text.startsWith('Year 3') && tip.text.includes('Cost of Custody') && tip.text.includes('Cost of Nostr') && tip.text.includes('Cumulative Savings') && !tip.text.includes('users'), tip.text)
  await api.eval(`document.getElementById('chart-custodial-cost-vs-nostr').dispatchEvent(new PointerEvent('pointerleave'))`)
  check('…and leaving hides it', await api.eval(`document.getElementById('tip-chart-custodial-cost-vs-nostr').hidden`))
  await api.eval(`document.getElementById('r-whose-link').click()`)
  check('Customize App Details opens App Info', (await api.eval(`document.getElementById('tab-app').getAttribute('aria-selected')`)) === 'true')
  await api.eval(`document.getElementById('tab-cost').click()`)
  check('…without a results link in the address bar', (await api.eval(`location.search`)) === '')
  check('the other two panels are hidden', await api.eval(`document.getElementById('panel-assumptions').hidden && document.getElementById('panel-app').hidden && !document.getElementById('panel-cost').hidden`))
  await api.eval(`document.getElementById('tab-app').click()`)
  check('the form carries the published form\'s own words and not its title', (await api.eval(`(() => {
    const legends = [...document.querySelectorAll('#calc-form .group__legend')].map(l => l.textContent.trim())
    const title = document.querySelector('.calc-form__title')?.textContent.trim()
    const q = document.querySelector('label[for=f-mau]').textContent.replace(/\\s+/g, ' ').trim()
    return title + ' | ' + legends.join(', ') + ' | ' + q
  })()`)) === 'undefined | Non Custody, Accounts & Storage, Staffing Costs, Payment Gateway, Availability & Growth | Number of Monthly Active Users (MAU)')
  check('the questions the page fills are not drawn', await api.eval(`!document.querySelector('[name=link], [name=test], [name=result_custodial], [name=version]')`))
  check('the required choices start with their defaults', await api.eval(`(() => {
    const on = [...document.querySelectorAll('#calc-form input:checked')].map(i => i.name + '=' + i.value).sort().join(' ')
    return on
  })()`) === 'jur=us')
  check('every grid row and number is a slider', (await api.eval(`document.querySelectorAll('input[type=range]').length`)) === 21)
  check('engineering sliders start on the band nearest the default hours', (await api.eval(`(() => {
    const s = document.querySelector('input[name=eng_content]')
    return s.dataset.values.split(',')[s.value] + ':' + s.closest('.slider-row').querySelector('output').textContent
  })()`)) === '5:1 - 10')
  check('every assumption is on the page with an editable typical value', (await api.eval(`document.querySelectorAll('.assume-input').length`)) === 71)

  check('number sliders start on their defaults', (await api.eval(`(() => {
    const v = (n) => { const s = document.querySelector('input[name=' + n + ']'); return s.dataset.values.split(',')[s.value] + '=' + s.closest('.slider-row').querySelector('output').textContent }
    return [v('mau'), v('posts_per_user'), v('mb'), v('rev'), v('legal_usd')].join(' ')
  })()`)) === '50000=50k 20=20 50=50 MB 0=0 0=0')

  // ── a bad value in a link ─────────────────────────────────────────────────
  await api.goto(`${BASE}/calculator/?mau=abc&jur=us`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const err = await api.eval(`({ text: document.getElementById('calc-error').textContent, hidden: document.getElementById('calc-error').hidden, invalid: document.querySelector('.is-invalid')?.id })`)
  check('a bad value in a link is refused and named with the form\'s own words', !err.hidden && err.text.includes('Number of Monthly Active Users') && err.invalid === 'field-mau', JSON.stringify(err))
  check('…and the results stay hidden', await api.eval(`document.getElementById('calc-results').hidden`))
  await api.goto(`${BASE}/calculator/`)
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)

  // ── a full calculation ────────────────────────────────────────────────────
  await api.eval(`(() => {
    const f = document.getElementById('calc-form')
    const slide = (name, value) => { const s = f.querySelector('input[name=' + name + ']'); s.value = s.dataset.values.split(',').indexOf(value); s.dispatchEvent(new Event('input', { bubbles: true })) }
    slide('mau', '50000'); slide('rev', '20000')
    slide('eng_accounts', '5'); slide('eng_content', '25'); slide('eng_infra', '25'); slide('mod_inhouse', '5')
    f.querySelector('input[name=rails][value=apple]').checked = true
    f.querySelector('input[name=rails][value=google]').checked = true
    f.querySelector('input[name=rails][value=processor]').checked = true
    f.querySelector('input[name=jur][value=eu]').checked = true
    f.querySelector('input[name=jur][value=uk]').checked = true
    f.querySelector('input[name=growth][value="0.5"]').checked = true
    f.requestSubmit()
  })()`)
  await api.waitFor(`!document.getElementById('calc-results').hidden`)
  const r = await api.eval(`(() => {
    const $ = (s) => document.querySelector(s)
    const row = (l) => document.querySelector('.lt-row[data-line="' + l + '"]')
    return {
      hero: $('.chart__watermark').textContent, whose: $('#r-whose-text').textContent, whoseLink: $('#r-whose-link').textContent,
      permauC: $('#r-permau-c').textContent, permauNC: $('#r-permau-nc').textContent, average: $('#r-average').textContent, averageRange: $('#r-average-range').textContent,
      eyebrows: [...document.querySelectorAll('#panel-cost .stat .eyebrow--gold')].map(e => e.textContent),
      yearTwoUsers: $('#r-years tbody tr[data-row=users] td:nth-child(3)').textContent,
      version: $('#r-version').textContent,
      accountsSaving: row('accounts').querySelector('.lt-saving').textContent,
      accountsPct: row('accounts').querySelector('.share__pct').textContent,
      badges: document.querySelectorAll('#r-table .badge').length,
      toggle: row('accounts').querySelector('.lt-toggle').textContent,
      shares: [...document.querySelectorAll('.lt-row .share')].map(b => parseFloat(b.style.getPropertyValue('--w'))),
      storageCut: row('storage').querySelector('.share__pct').textContent,
      totalCut: $('.lt-total .share__pct').textContent,
      editLink: $('#r-edit').className + ':' + getComputedStyle($('.results__actions')).justifyContent,
      versionAlign: getComputedStyle($('#r-version')).textAlign,
      tabColor: getComputedStyle($('#tab-cost')).color + '|' + getComputedStyle($('#tab-cost')).borderBottomColor,
      total: $('#r-total').textContent,
      tint: getComputedStyle($('.stat--saving')).backgroundColor + '|' + getComputedStyle($('.lt-total td')).backgroundColor,
      nudges: document.querySelectorAll('.lt-nudge:not([hidden])').length,
      subtitle: $('.results__sub').textContent,
      link: location.href,
      url: location.search,
      error: $('#calc-error').hidden,
      focused: document.activeElement?.id,
    }
  })()`)
  check('the watermark is the five-year saving, compact', /^\$\d+(\.\d+)?[kM]$/.test(r.hero), r.hero)
  check('the three facts are per user today, per user on Nostr, and the average year, under gold eyebrows', /^\$\d+\.\d\d$/.test(r.permauC) && /^\$\d+\.\d\d$/.test(r.permauNC) && /^\$[\d.]+[kM]$/.test(r.average) && /^Range \$/.test(r.averageRange) && r.eyebrows.join(' | ') === 'Custodial Cost per User/Year | Nostr Cost per User/Year | Average Savings per Year', `${r.permauC} ${r.permauNC} ${r.average} | ${r.eyebrows.join(' | ')}`)
  check('after Calculate the tab says it is the visitor\'s estimate', r.whose === 'Your estimate, for an app with 50,000 active users.' && r.whoseLink === 'Customize App Details', `${r.whose} / ${r.whoseLink}`)
  check('growth compounds in the year-by-year table (50% then decayed)', r.yearTwoUsers === '103,125', r.yearTwoUsers)
  check('each line shows its average saving in full, its share as a percentage, and no pills', /^\$[\d,]+$/.test(r.accountsSaving) && /^[\d.]+%$/.test(r.accountsPct) && r.badges === 0 && r.toggle === 'Show the Savings', `${r.accountsSaving} | ${r.accountsPct} | ${r.badges} badges | ${r.toggle}`)
  check('each bar is the share of that line\'s own cost that goes away', r.shares.length === 6 && r.shares.every(x => x >= 0 && x <= 100) && /^\d+(\.\d+)?%$/.test(r.storageCut) && parseFloat(r.storageCut) > 50 && /^\d+(\.\d+)?%$/.test(r.totalCut), `${r.shares.join(' ')} | storage ${r.storageCut} | total ${r.totalCut}`)
  check('the bottom link is a centred link, the version sits right, and the Results tab is purple', r.editLink === 'linkbutton results__edit:center' && r.versionAlign === 'right' && r.tabColor.split('|')[0] === r.tabColor.split('|')[1], `${r.editLink} | ${r.versionAlign} | ${r.tabColor}`)
  check('the foot row names the same figure as the Average Savings fact chip', r.total === r.average && r.subtitle.trim().length > 0, `${r.total} vs ${r.average}`)
  check('the fact chip and the foot row share one tint', r.tint.split('|')[0] === r.tint.split('|')[1] && !r.tint.startsWith('rgba(0, 0, 0, 0)'), r.tint)
  check('no nudge where every line with rails already saves', r.nudges === 0, String(r.nudges))
  check('the page URL carries the inputs and the version', r.link.includes('mau=50000') && r.link.includes('eng_content=25') && r.link.includes('jur=eu%2Cuk%2Cus') && r.link.includes('growth=0.5') && r.link.endsWith('v=1'), r.link)
  check('sliders standing on "not given" stay out of the link', !r.link.includes('n_keys=') && !r.link.includes('mod_vendor='), r.link)
  check('the version is named', r.version.includes('1'), r.version)
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
  check('the savings open under the line, headed by two averaged totals whose difference is the saving beside them', !parts.hidden && parts.open && parts.items.length === 4 && /^Cost of Custody \$[\d,]+ Cost of Nostr \$[\d,]+$/.test(parts.totals) && Math.abs(parts.gap - parts.saved) <= 1, `${parts.totals} | saved ${parts.saved} | ${parts.items.join(' | ')}`)
  check('a store part names its applied rate and tier', parts.items.some(t => /Apple App Store commission.*15%.*small-business tier/.test(t)), parts.items[0])

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
    averaged: document.getElementById('how-averaged').textContent,
  })`)
  check('…and says what the averaged figure in the list is', /^Averaged over the five projected years.*\$[\d,]+ of custody becomes \$[\d,]+ on Nostr/.test(how.averaged), how.averaged)
  if (SHOTS) await snap(api, join(SHOTS, 'how-1440.png'))
  check('a part opens the how-dialog with the arithmetic filled in', how.open && how.part === 'Identity and age checks' && how.line === 'Accounts & personal data' && /^50,000 users × 25% checked a year × \$1\.50 a check = \$[\d,]+$/.test(how.today) && /^10% of checks remain.*\$[\d,]+$/.test(how.nostr), `${how.today} | ${how.nostr}`)
  check('…and lists only the assumptions that applied, with value, range and confidence', how.items.length === 5 && how.items.some(i => i.startsWith('Users needing a check per year, UK') && i.includes('25%') && i.includes('10% to 50% · unsourced')) && !how.items.some(i => i.includes('other')), how.items.join(' | '))
  await api.eval(`document.getElementById('how-adjust').click()`)
  await sleep(200)
  const lit = await api.eval(`({
    tab: document.getElementById('tab-assumptions').getAttribute('aria-selected'), closed: !document.getElementById('how-modal').open,
    rows: [...document.querySelectorAll('.assume-table tr.is-focus')].map(r => r.dataset.key),
    strip: document.getElementById('a-filter').hidden + ':' + document.getElementById('a-filter-text').textContent,
    filtered: document.getElementById('calc-assume').classList.contains('is-filtered'),
  })`)
  check('Adjust Assumptions opens the tab with those rows lit and says why', lit.tab === 'true' && lit.closed && lit.filtered && [...lit.rows].sort().join(',') === 'verify_price,verify_remains_share,verify_share_eu,verify_share_uk,verify_share_us' && lit.strip === 'false:Showing the 5 assumptions behind Identity and age checks.', `${lit.rows.join(',')} | ${lit.strip}`)
  await api.eval(`document.getElementById('a-filter-clear').click()`)
  check('Show all clears the lights', (await api.eval(`document.querySelectorAll('.assume-table tr.is-focus').length + ':' + document.getElementById('a-filter').hidden + ':' + document.getElementById('calc-assume').classList.contains('is-filtered')`)) === '0:true:false')
  await api.eval(`document.getElementById('tab-cost').click()`)

  // Every part of every line explains itself without a blank: two input sets walk every branch.
  for (const query of ['mau=50000&posts_per_user=20&eng_accounts=5&mod_inhouse=5&mod_vendor=5&rails=p2p%2Capple%2Cgoogle%2Cprocessor%2Creseller&rev=50000&balances=yes&jur=eu%2Cuk%2Cus%2Cother&v=1', 'mau=10000000&rails=apple&rev=200000&legal_usd=50000&jur=us&v=1']) {
    await api.goto(`${BASE}/calculator/?${query}`)
    await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
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

  // ── a nudge in place of a zero ───────────────────────────────────────────
  await api.goto(`${BASE}/calculator/?mau=50000&rails=apple%2Cgoogle&rev=10000&jur=us&v=1`)
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
        check('the form secret decrypts the page\'s answers', byLabel['Number of Monthly Active Users (MAU)'] === '10000' && byLabel['Contact Email'] === 'founder@example.com' && byLabel['Company Name'] === 'Example' && byLabel['Contact Name'] === 'Founder' && byLabel['App Name'] === 'Example App', JSON.stringify(byLabel))
        const stored = await api.eval(`sessionStorage.getItem('nostr4.session-key')`)
        check('the response is signed by the tab\'s disposable key', Boolean(stored) && ev.pubkey === getPublicKey(hexToBytes(stored)), ev.pubkey.slice(0, 12))
        check('the computed figures and the link travel with the inputs', /^\d+$/.test(byLabel['Annual custodial cost (USD, typical)'] || '') && (byLabel['Results link'] || '').includes('mau=10000'), byLabel['Results link'])
        check('the test marker is blank when the URL had none', !('test' in byLabel))
        const eng = JSON.parse(byLabel['Software Engineering (hours per week)'] || '{}')
        const nostr = JSON.parse(byLabel['Our app already uses Nostr:'] || '{}')
        check('grid answers arrive as row id to column id, one per slider', Object.keys(eng).length === 4 && Object.keys(nostr).length === 10, `${byLabel['Software Engineering (hours per week)']} ${byLabel['Our app already uses Nostr:']}`)
      }
      // A lead with contact details also goes to hello's inbox as a gift wrap.
      // It is mined after the save is reported, so give it time.
      let wraps = []
      for (let i = 0; i < 30 && wraps.length === 0; i++) {
        wraps = await pool.querySync([RELAY], { kinds: [1059] }, { maxWait: 2000 })
        if (!wraps.length) await sleep(1000)
      }
      check('a lead message was gift-wrapped to the inbox', wraps.length === 1 && getPow(wraps[0].id) >= 18, `${wraps.length} wraps`)
      // A second save from the same tab comes from the same key and does not re-send the lead.
      await api.eval(`{ const c = document.getElementById('f-consent'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('save-submit').click() }`)
      await sleep(200)
      await api.eval(`document.getElementById('sign-session').click()`)
      await api.waitFor(`/Sent · /.test(document.getElementById('save-status').textContent) && document.getElementById('save-submit').disabled === false`, { timeout: 60000 })
      await sleep(500)
      const again = await pool.querySync([RELAY], { kinds: [KIND_RESPONSE], '#a': [formAddress(snapshot)] }, { maxWait: 4000 })
      const wrapsAgain = await pool.querySync([RELAY], { kinds: [1059] }, { maxWait: 2000 })
      check('a second save in the same tab comes from the same key', again.length === 2 && new Set(again.map((e) => e.pubkey)).size === 1, `${again.length} responses, ${new Set(again.map((e) => e.pubkey)).size} key(s)`)
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
