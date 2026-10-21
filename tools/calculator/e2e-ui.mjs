// Browser end-to-end test for /calculator/. Drives real headless Chrome over
// the DevTools protocol, so this is the page as a visitor gets it — CSP,
// module loading, subresource integrity and all.
//
//   bundle exec jekyll serve          # or any static server on _site
//   npm run e2e:calculator            # defaults to http://127.0.0.1:4000
//
// SHOTS=dir writes screenshots of the results at 1440 and 390 wide into dir.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withBrowser } from '../contact-bundle/cdp.mjs'

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
  check('results are hidden until a calculation', await api.eval(`document.getElementById('calc-results').hidden`))
  check('the required choices start with their defaults', await api.eval(`(() => {
    const on = [...document.querySelectorAll('#calc-form input:checked')].map(i => i.name + '=' + i.value).sort().join(' ')
    return on
  })()`) === 'jur=us pay=no stores=apple stores=google ts=none')
  check('61 assumptions are on the page, each with an editable typical value', (await api.eval(`document.querySelectorAll('.assume-input').length`)) === 61)

  // ── a required field left empty ───────────────────────────────────────────
  await api.eval(`document.getElementById('calc-form').requestSubmit()`)
  await sleep(200)
  const err = await api.eval(`({ text: document.getElementById('calc-error').textContent, hidden: document.getElementById('calc-error').hidden, invalid: document.querySelector('.is-invalid')?.id })`)
  check('an empty required field is refused and named', !err.hidden && err.text.includes('Monthly active users') && err.invalid === 'field-mau', JSON.stringify(err))
  check('…and the results stay hidden', await api.eval(`document.getElementById('calc-results').hidden`))

  // ── a full calculation ────────────────────────────────────────────────────
  await api.eval(`(() => {
    const f = document.getElementById('calc-form')
    f.elements.mau.value = '50,000'
    f.elements.eng.value = '3'
    f.querySelector('input[name=ts][value=inhouse]').checked = true
    f.elements.ts_n.value = '2'
    f.querySelector('input[name=pay][value=yes]').checked = true
    f.elements.rev.value = '20000'
    f.querySelector('input[name=stores][value=web]').checked = true
    f.querySelector('input[name=jur][value=eu]').checked = true
    f.querySelector('input[name=jur][value=uk]').checked = true
    f.requestSubmit()
  })()`)
  await api.waitFor(`!document.getElementById('calc-results').hidden`)
  const r = await api.eval(`(() => {
    const $ = (s) => document.querySelector(s)
    const row = (l) => document.querySelector('.lt-row[data-line="' + l + '"]')
    return {
      hero: $('#r-hero').textContent, heroRange: $('#r-hero-range').textContent,
      nc: $('#r-nc').textContent, permau: $('#r-permau').textContent, saving: $('#r-saving').textContent,
      version: $('#r-version').textContent,
      accountsC: row('accounts').querySelector('.lt-value--c').textContent,
      accountsNC: row('accounts').querySelector('.lt-value--nc').textContent,
      paymentsNC: row('payments').querySelector('.lt-value--nc').textContent,
      barMax: Math.max(...[...document.querySelectorAll('.bar--c')].map(b => parseFloat(b.style.getPropertyValue('--w')))),
      barNc: parseFloat(row('moderation').querySelector('.bar--nc').style.getPropertyValue('--w')),
      link: $('#r-link').value,
      contact: $('#r-contact').getAttribute('href'),
      url: location.search,
      error: $('#calc-error').hidden,
      zeros: [...document.querySelectorAll('.lt-value--nc')].filter(n => n.textContent === '$0').length,
      focused: document.activeElement?.id,
    }
  })()`)
  check('the hero figure is the typical custodial cost, compact', /^\$\d+(\.\d+)?k$/.test(r.hero), r.hero)
  check('the hero carries its range', /^Range \$.+ to \$.+$/.test(r.heroRange), r.heroRange)
  check('the tiles are filled', r.nc.startsWith('$') && r.permau.startsWith('$') && r.saving.startsWith('$'), `${r.nc} ${r.permau} ${r.saving}`)
  check('the table shows full figures', /^\$[\d,]+$/.test(r.accountsC) && /^\$[\d,]+$/.test(r.accountsNC), `${r.accountsC} ${r.accountsNC}`)
  check('no non-custodial line is zero', r.zeros === 0, `${r.zeros} zero lines`)
  check('the widest custodial bar is the full scale', Math.abs(r.barMax - 100) < 0.01, String(r.barMax))
  check('non-custodial bars share that scale', r.barNc > 0 && r.barNc < 100, String(r.barNc))
  check('the results link carries the inputs and the version', r.link.includes('mau=50000') && r.link.includes('jur=eu%2Cuk%2Cus') && r.link.endsWith('v=1'), r.link)
  check('the page URL is the same link', r.url.includes('mau=50000'), r.url)
  check('the contact door carries a subject and the inputs', r.contact.startsWith('/contact/?subject=') && r.contact.includes('calc=mau'), r.contact)
  check('the version is named', r.version.includes('1'), r.version)
  check('the results heading took focus', r.focused === 'results-title', r.focused)
  check('the error cleared', r.error)

  // ── the parts ─────────────────────────────────────────────────────────────
  await api.eval(`document.querySelector('.lt-row[data-line="payments"] .lt-toggle').click()`)
  const parts = await api.eval(`(() => {
    const row = document.getElementById('parts-payments')
    return { hidden: row.hidden, items: [...row.querySelectorAll('.part')].map(p => p.textContent.replace(/\\s+/g, ' ').trim()) }
  })()`)
  check('the parts open under the line', !parts.hidden && parts.items.length === 4, parts.items.join(' | '))
  check('a store part names its applied rate and tier', parts.items.some(t => /Apple App Store commission.*15%.*small-business tier/.test(t)), parts.items[0])

  // ── an assumption edit ────────────────────────────────────────────────────
  const before = await api.eval(`document.querySelector('.lt-row[data-line="storage"] .lt-value--c').textContent`)
  await api.eval(`(() => {
    const i = document.getElementById('a-egress_gb_per_mau_month')
    i.value = '5'
    i.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await sleep(150)
  const after = await api.eval(`({
    storage: document.querySelector('.lt-row[data-line="storage"] .lt-value--c').textContent,
    changed: document.querySelector('tr[data-key="egress_gb_per_mau_month"]').classList.contains('is-changed'),
    link: document.getElementById('r-link').value,
  })`)
  check('changing an assumption recomputes the line', after.storage !== before, `${before} → ${after.storage}`)
  check('the changed row is marked', after.changed)
  check('the override travels in the link', after.link.includes('a.egress_gb_per_mau_month=5'), after.link)
  await api.eval(`document.getElementById('a-reset').click()`)
  await sleep(150)
  check('reset restores the typical value', (await api.eval(`document.querySelector('.lt-row[data-line="storage"] .lt-value--c').textContent`)) === before)

  if (SHOTS) {
    await snap(api, join(SHOTS, 'calculator-1440.png'))
    await api.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await sleep(300)
    await snap(api, join(SHOTS, 'calculator-390.png'))
    await api.send('Emulation.clearDeviceMetricsOverride')
  }

  // ── a shared link ─────────────────────────────────────────────────────────
  const link = after.link
  await api.goto(link + '&test=1')
  await api.waitFor(`document.documentElement.dataset.calculator === 'ready'`)
  const shared = await api.eval(`({
    hidden: document.getElementById('calc-results').hidden,
    status: document.getElementById('r-status').textContent,
    mau: document.getElementById('f-mau').value,
    ts: document.querySelector('input[name=ts]:checked')?.value,
    egress: document.getElementById('a-egress_gb_per_mau_month').value,
    url: location.search,
  })`)
  check('a results link opens straight to the results', !shared.hidden)
  check('…says nothing was submitted', shared.status.includes('Nothing was submitted'), shared.status)
  check('…fills the form from the link', shared.mau === '50000' && shared.ts === 'inhouse', `${shared.mau} ${shared.ts}`)
  check('…and the assumption override', shared.egress === '5', shared.egress)
  check('the test marker survives in the page URL', shared.url.includes('test=1'), shared.url)

  // ── hygiene ───────────────────────────────────────────────────────────────
  const foreign = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('about:'))
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
