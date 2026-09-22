// Browser end-to-end test for /contact/. Drives real headless Chrome over the
// DevTools protocol, so this is the page as a visitor gets it — CSP, module
// loading, subresource integrity and all.
//
//   bundle exec jekyll serve          # or any static server on _site
//   npm run e2e:contact               # defaults to http://127.0.0.1:4000
//
// Every send is pointed at wss://dead.invalid, so the test exercises the whole
// pipeline without writing anything to a real relay. To test delivery for real,
// run a relay locally and pass ?relay=wss://localhost:... by hand.

import { withBrowser } from './cdp.mjs'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000'
// A key generated for this test and used nowhere else.
const TEST_NPUB = 'npub1pr3djwxy5pfr4gu4wqvnz24rev7u85u8e6xlp7q7tc4gmnsamh9sj5ae4p'
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

await withBrowser(async (api) => {
  const logs = []
  api.onEvent((m) => {
    if (m.method === 'Log.entryAdded') logs.push(`${m.params.entry.level}: ${m.params.entry.text}`)
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('console.error')
  })
  const requests = []
  api.onEvent((m) => { if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url) })

  // Point every send at an unreachable host: this exercises the whole pipeline
  // without writing anything to a real relay.
  await api.goto(`${BASE}/contact/?to=${TEST_NPUB}&relay=wss://dead.invalid`)
  await api.waitFor(`document.documentElement.dataset.contact === 'ready'`)

  check('method panel is the one on screen', await api.eval(`
    [...document.querySelectorAll('.contact__panel')].filter(p => !p.hidden).map(p => p.id).join(',')
  `) === 'panel-methods')

  check('email fallback is a real mailto', (await api.eval(`
    document.querySelector('[data-user][data-domain]').getAttribute('href')
  `)) === 'mailto:hello@nostr4.social?subject=%5Bnostr4.social%5D%20Contact')

  check('no third-party requests on load',
    requests.every((u) => u.startsWith(BASE) || u.startsWith('data:')),
    requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:')).join(' '))

  check('recipients loaded from the localhost override',
    await api.eval(`document.getElementById('panel-unavailable').hidden`))

  // ── guest mode ────────────────────────────────────────────────────────────
  await api.eval(`document.getElementById('method-guest').click()`)
  await api.waitFor(`!document.getElementById('panel-compose').hidden`)
  check('guest sign-in opens the compose panel', true)
  check('identity line names the one-time key',
    (await api.eval(`document.getElementById('contact-identity').textContent`)).includes('one-time key'))

  // Validation: too fast, and too short.
  await api.eval(`(() => {
    const f = document.getElementById('contact-form');
    f.elements.message.value = 'short';
    f.requestSubmit();
  })()`)
  await new Promise((r) => setTimeout(r, 300))
  check('a too-fast submit is refused',
    !(await api.eval(`document.getElementById('compose-error').hidden`)),
    await api.eval(`document.getElementById('compose-error').textContent`))

  // The honeypot looks like success and sends nothing.
  await api.eval(`(() => {
    const f = document.getElementById('contact-form');
    f.elements.website.value = 'https://spam.example';
    f.elements.message.value = 'A message long enough to pass the minimum length check.';
    f.requestSubmit();
  })()`)
  await api.waitFor(`!document.getElementById('panel-result').hidden`)
  check('the honeypot reports success and sends nothing',
    (await api.eval(`document.getElementById('result-list').children.length`)) === 0)

  // Real send, against a relay that does not exist.
  await api.goto(`${BASE}/contact/?to=${TEST_NPUB}&relay=wss://dead.invalid`)
  await api.waitFor(`document.documentElement.dataset.contact === 'ready'`)
  await api.eval(`document.getElementById('method-guest').click()`)
  await api.waitFor(`!document.getElementById('panel-compose').hidden`)
  await new Promise((r) => setTimeout(r, 3200)) // clear the min-seconds gate
  await api.eval(`(() => {
    const f = document.getElementById('contact-form');
    f.elements.subject.value = 'End to end test';
    f.elements.message.value = 'A message long enough to pass the minimum length check.';
    f.requestSubmit();
  })()`)
  await api.waitFor(`!document.getElementById('panel-result').hidden`, { timeout: 30000 })

  const result = await api.eval(`({
    items: document.getElementById('result-list').children.length,
    title: document.querySelector('#result-head h2')?.textContent,
    relays: [...document.querySelectorAll('.result__relay')].map(n => n.className + ' ' + n.textContent.trim()),
    wrapId: document.querySelector('.result__id code')?.textContent,
  })`)
  check('one result per recipient', result.items === 1)
  check('an unreachable relay ends in a failure verdict', result.title === 'Not sent.', result.title)
  check('the relay failure is shown with a reason',
    result.relays.some((r) => r.includes('is-failed') && r.includes('dead.invalid')), result.relays.join(' | '))
  check('the wrapper event id is shown', /^[0-9a-f]{64}$/.test(result.wrapId || ''), result.wrapId)

  check('still no third-party HTTP',
    requests.every((u) => u.startsWith(BASE) || u.startsWith('data:')),
    requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:')).join(' '))

  const bad = logs.filter((l) => !/dead\.invalid|ERR_NAME_NOT_RESOLVED|WebSocket connection|localhost overrides/i.test(l))
  check('no unexpected console errors', bad.length === 0, bad.slice(0, 5).join(' | '))
  if (logs.length) console.log('\n  browser log:\n   ' + logs.slice(0, 12).join('\n   '))
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
