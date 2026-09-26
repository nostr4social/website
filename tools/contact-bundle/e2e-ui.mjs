// Browser end-to-end test for /contact/. Drives real headless Chrome over the
// DevTools protocol, so this is the page as a visitor gets it — CSP, module
// loading, subresource integrity and all.
//
//   bundle exec jekyll serve          # or any static server on _site
//   npm run e2e:ui                    # defaults to http://127.0.0.1:4000
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await withBrowser(async (api) => {
  const logs = []
  api.onEvent((m) => {
    if (m.method === 'Log.entryAdded') logs.push(`${m.params.entry.level}: ${m.params.entry.text}`)
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('console.error')
  })
  const requests = []
  api.onEvent((m) => { if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url) })

  // ── the real recipient list ───────────────────────────────────────────────
  await api.goto(`${BASE}/contact/?to=andrew&subject=Research+group`)
  await api.waitFor(`document.documentElement.dataset.contact === 'ready'`)

  const to = await api.eval(`({
    options: [...document.querySelectorAll('#field-to option')].map(o => o.value),
    selected: document.getElementById('field-to').value,
    text: document.getElementById('field-to').selectedOptions[0]?.textContent,
    subject: document.getElementById('field-subject').value,
  })`)
  check('recipients come from nostr.json in file order', to.options.join(',') === 'hello,manime,derekross,andrew', to.options.join(','))
  check('?to=<name> preselects the recipient', to.selected === 'andrew', to.selected)
  check('the option shows the NIP-05 identity', (to.text || '').includes('andrew@nostr4.social'), to.text)
  check('?subject= prefills the subject', to.subject === 'Research group', to.subject)

  check('the composer is on screen with the guest send row', await api.eval(`
    !document.getElementById('contact-form').hidden && !document.getElementById('send-guest').hidden
      && document.getElementById('send-signed').hidden && document.getElementById('panel-result').hidden
  `))
  check('the reply-to field shows for a one-time key', await api.eval(`!document.getElementById('field-reply').hidden`))
  check('the travel chain rests', (await api.eval(`
    [...document.querySelectorAll('.travel__node')].map(n => n.dataset.state).join(',')
  `)) === 'rest,rest,rest')

  check('email door is a real mailto', (await api.eval(`
    document.querySelector('[data-user][data-domain]').getAttribute('href')
  `)) === 'mailto:hello@nostr4.social?subject=%5Bnostr4.social%5D%20Contact')

  check('no third-party requests on load',
    requests.every((u) => u.startsWith(BASE) || u.startsWith('data:')),
    requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:')).join(' '))

  // The extension link, with no extension: an error, not a dead click.
  await api.eval(`document.getElementById('sign-extension').click()`)
  await sleep(300)
  check('signing with a missing extension explains itself',
    !(await api.eval(`document.getElementById('sign-error').hidden`)),
    await api.eval(`document.getElementById('sign-error').textContent`))

  // The bunker modal opens with a QR and a nostrconnect URI, and cancels clean.
  await api.eval(`document.getElementById('sign-bunker').click()`)
  await api.waitFor(`document.getElementById('bunker-modal').open && document.querySelector('#bunker-qr svg')`)
  const uri = await api.eval(`document.getElementById('bunker-uri').value`)
  check('the bunker modal shows a nostrconnect URI', uri.startsWith('nostrconnect://'), uri.slice(0, 40))
  check('it asks for the two permissions only', uri.includes('perms=sign_event%3A13%2Cnip44_encrypt'), uri)
  await api.eval(`document.getElementById('bunker-cancel').click()`)
  await sleep(200)
  check('cancel closes the modal', !(await api.eval(`document.getElementById('bunker-modal').open`)))

  // ── validation, against the throwaway key ─────────────────────────────────
  await api.goto(`${BASE}/contact/?to=${TEST_NPUB}&relay=wss://dead.invalid`)
  await api.waitFor(`document.documentElement.dataset.contact === 'ready'`)
  check('a localhost ?to=<npub> becomes the one test recipient',
    (await api.eval(`[...document.querySelectorAll('#field-to option')].map(o => o.value).join(',')`)) === 'test')

  await api.eval(`(() => {
    const f = document.getElementById('contact-form');
    f.elements.message.value = 'short';
    f.requestSubmit();
  })()`)
  await sleep(300)
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
  check('the honeypot reports success', (await api.eval(`document.getElementById('result-title').textContent`)) === 'Sent.')
  check('…and opened no relay socket', !requests.some((u) => u.startsWith('wss://')), requests.filter((u) => u.startsWith('wss://')).join(' '))

  // ── a real send, against a relay that does not exist ──────────────────────
  await api.goto(`${BASE}/contact/?to=${TEST_NPUB}&relay=wss://dead.invalid`)
  await api.waitFor(`document.documentElement.dataset.contact === 'ready'`)
  await sleep(3200) // clear the min-seconds gate
  await api.eval(`(() => {
    const f = document.getElementById('contact-form');
    f.elements.subject.value = 'End to end test';
    f.elements.message.value = 'A message long enough to pass the minimum length check.';
    f.elements.replyto.value = 'kai@example.com';
    f.requestSubmit();
  })()`)
  await api.waitFor(`!document.getElementById('send-busy').hidden`)
  check('the send row becomes the progress', true)
  // Mining is quick on a desktop, so the two are read in one go.
  await api.waitFor(`document.getElementById('progress-label').textContent === 'Proving work'
    && document.querySelector('.travel__node .travel__note').textContent.includes('proof of work')`, { timeout: 10000 })
  check('the progress names the proof of work, and the chain shows it on the browser node', true)
  await api.waitFor(`!document.getElementById('panel-result').hidden`, { timeout: 30000 })

  const result = await api.eval(`({
    title: document.getElementById('result-title').textContent,
    who: [...document.querySelectorAll('#result-who .who')].map(n => n.textContent.replace(/\\s+/g, ' ').trim()),
    relays: [...document.querySelectorAll('#result-relays .relay')].map(n => n.className + ' ' + n.textContent.trim()),
    wrapId: document.querySelector('#result-id .code')?.textContent,
    travel: [...document.querySelectorAll('.travel__node')].map(n => n.dataset.state).join(','),
    retry: !document.getElementById('result-retry').hidden,
    reply: document.getElementById('result-reply').textContent,
    composerHidden: document.getElementById('contact-form').classList.contains('composer--result'),
  })`)
  check('an unreachable relay ends in a failure verdict', result.title === 'Not sent.', result.title)
  check('one recipient row, not delivered', result.who.length === 1 && result.who[0].includes('Not delivered'), result.who.join(' | '))
  check('the relay failure is shown with a reason',
    result.relays.some((r) => r.includes('is-failed') && r.includes('dead.invalid')), result.relays.join(' | '))
  check('the wrapper event id is shown', /^[0-9a-f]{64}$/.test(result.wrapId || ''), result.wrapId)
  const zeroBits = (hex) => { let n = 0; for (const c of hex) { const v = parseInt(c, 16); if (v === 0) { n += 4; continue } n += Math.clz32(v) - 28; break } return n }
  const difficulty = await api.eval(`JSON.parse(document.getElementById('contact-config').textContent).pow.anonymous`)
  check(`a one-time key's wrapper carries the configured ${difficulty} bits of proof of work`, zeroBits(result.wrapId || 'f') >= difficulty, `${zeroBits(result.wrapId || 'f')} bits`)
  check('the chain marks the relays as the point of failure', result.travel === 'done,failed,rest', result.travel)
  check('retry is offered after a failure', result.retry)
  check('the receipt replaces the composer', result.composerHidden)

  // Send another brings the composer back, at rest.
  await api.eval(`document.getElementById('result-again').click()`)
  await sleep(200)
  check('send another restores the composer', await api.eval(`
    !document.getElementById('contact-form').classList.contains('composer--result')
      && document.getElementById('panel-result').hidden
      && [...document.querySelectorAll('.travel__node')].every(n => n.dataset.state === 'rest')
      && document.getElementById('field-to').value === 'test'
  `))

  check('still no third-party HTTP',
    requests.every((u) => u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('wss://dead.invalid')),
    requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('wss://dead.invalid')).join(' '))

  const bad = logs.filter((l) => !/dead\.invalid|ERR_NAME_NOT_RESOLVED|WebSocket connection|localhost overrides/i.test(l))
  check('no unexpected console errors', bad.length === 0, bad.slice(0, 5).join(' | '))
  if (logs.length) console.log('\n  browser log:\n   ' + logs.slice(0, 12).join('\n   '))
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
