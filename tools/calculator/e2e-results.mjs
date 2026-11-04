// Browser end-to-end test for /calculator/responses/: a fixture form and a
// few responses on the offline relay (nak serve), the page opened with a
// NIP-07 signer injected that holds the fixture form's key, the rows
// decrypted, screened by the reader policy, filtered, sorted and exported.
//
//   bundle exec jekyll serve
//   npm run e2e:results            # defaults to http://127.0.0.1:4000

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { getConversationKey, encrypt } from 'nostr-tools/nip44'
import { bytesToHex } from '@noble/hashes/utils.js'
import { withBrowser } from '../contact-bundle/cdp.mjs'
import { formAddress, parseTemplate, readMap, readSnapshot, SNAPSHOT, snapshotYaml } from '../forms/lib.mjs'
import { fixtureTemplate, localRelay } from '../forms/fixture.mjs'
import { root } from '../lib/config.mjs'

useWebSocketImplementation(WebSocket)
const PORT = 10548
const RELAY = `ws://127.0.0.1:${PORT}`
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000'
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)

const committed = await readFile(SNAPSHOT, 'utf8')
const base = await readSnapshot()
const map = await readMap()
const assets = await readFile(`${root}/_data/assets.yml`, 'utf8')
const vendorPath = assets.match(/nostr_tools:\n\s+path: (\S+)/)[1]

const stopRelay = await localRelay(PORT, { spawn })
const pool = new SimplePool()
try {
  // ── the form and a few responses ──────────────────────────────────────────
  const fixture = fixtureTemplate(base, RELAY)
  await Promise.allSettled(pool.publish([RELAY], fixture.event))
  const snapshot = parseTemplate(fixture.event)
  const address = formAddress(snapshot)
  const F = map.fields
  const answers = ({ mau = '50000', team = 'ten', jur = ['us'], kind = 'messaging', growth = '0.5', volume = '5000', email = '', test = false, version = '4', link = `https://nostr4.social/calculator/?mau=${mau}&v=4&t=2026-11-03`, saved = null }) => {
    const list = [
      ['response', F.mau.id, mau, '{}'],
      ['response', F.team.id, F.team.options[team], '{}'],
      ['response', F.jur.id, jur.map((j) => F.jur.options[j]).join(';'), '{}'],
      ['response', F.kind.id, F.kind.options[kind], '{}'],
      ['response', F.growth.id, F.growth.options[growth], '{}'],
      ['response', F.p2p_volume.id, volume, '{}'],
      ['response', F.version.id, version, '{}'],
      ['response', F.link.id, link, '{}'],
    ]
    if (email) list.push(['response', F.email.id, email, '{}'])
    if (test) list.push(['response', F.test.id, F.test.options.yes, '{}'])
    if (saved) list.push(['response', F.result_custodial.id, String(saved[0]), '{}'], ['response', F.result_noncustodial.id, String(saved[1]), '{}'])
    return list
  }
  const respond = (secret, list, { at = now(), tags = [['a', address]] } = {}) =>
    finalizeEvent({ kind: 1069, created_at: at, tags, content: encrypt(JSON.stringify(list), getConversationKey(secret, fixture.pubkey)) }, secret)
  const alice = generateSecretKey() // signed in: has a profile, so no proof of work is asked
  const bob = generateSecretKey() // unverified, no proof of work: dropped
  const profile = finalizeEvent({ kind: 0, created_at: now(), tags: [], content: JSON.stringify({ name: 'alice' }) }, alice)
  const events = [
    profile,
    respond(alice, answers({ email: 'alice@example.com' }), { at: now() - 300 }),
    respond(alice, answers({ email: 'alice@example.com' }), { at: now() - 200 }), // the same answers again: a duplicate, the older goes
    respond(alice, answers({ mau: '20000', test: true }), { at: now() - 100 }),
    respond(alice, answers({ mau: '200000', team: 'fifty', jur: ['eu', 'us'], volume: '50000' }), { at: now() - 50 }),
    respond(alice, answers({ mau: '50000', version: '3', link: 'https://nostr4.social/calculator/?mau=50000&v=3', saved: [312000, 20000] }), { at: now() - 400 }), // a version-3 response: shown only when asked, with the figures it saved
    respond(bob, answers({ mau: '1000' }), { at: now() - 10 }),
    respond(bob, answers({ mau: '1000' }), { at: now() - 5, tags: [['a', '30168:' + 'c'.repeat(64) + ':other']] }),
  ]
  for (const e of events) await Promise.allSettled(pool.publish([RELAY], e))

  await writeFile(SNAPSHOT, snapshotYaml(snapshot, base.naddr))
  await withBrowser(async (api) => {
    const logs = []
    api.onEvent((m) => {
      if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('console.error')
    })
    const requests = []
    api.onEvent((m) => { if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url) })
    // A NIP-07 signer holding the fixture form's key, from the site's own vendored module.
    await api.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      (() => {
        const hex = '${bytesToHex(fixture.secret)}'
        const sk = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)))
        const mod = () => import('${vendorPath}')
        window.nostr = {
          getPublicKey: async () => (await mod()).getPublicKey(sk),
          signEvent: async (e) => (await mod()).finalizeEvent(e, sk),
          nip44: {
            encrypt: async (pk, text) => { const m = await mod(); return m.nip44Encrypt(text, m.getConversationKey(sk, pk)) },
            decrypt: async (pk, ct) => { const m = await mod(); return m.nip44Decrypt(ct, m.getConversationKey(sk, pk)) },
          },
        }
      })()` })
    // The dev server rebuilds with the fixture snapshot.
    for (let i = 0; i < 60; i++) {
      await api.goto(`${BASE}/calculator/responses/?relay=${encodeURIComponent(RELAY)}`)
      await api.waitFor(`document.documentElement.dataset.results === 'ready'`)
      if ((await api.eval(`JSON.parse(document.getElementById('page-form').textContent)?.pubkey`)) === fixture.pubkey) break
      await sleep(1000)
    }
    const before = await api.eval(`({ status: document.getElementById('inbox-status').textContent, table: document.getElementById('inbox-table').hidden, tools: document.getElementById('inbox-tools').hidden, robots: document.querySelector('meta[name=robots]')?.content, session: document.getElementById('sign-session') })`)
    check('signed out, the page shows nothing but the invitation to sign in; it is noindex and offers no one-time key', before.status === 'Sign in to read the responses.' && before.table && before.tools && before.robots === 'noindex, nofollow' && before.session === null, JSON.stringify(before))
    await api.eval(`document.getElementById('inbox-sign-open').click()`)
    await api.eval(`document.getElementById('sign-extension').click()`)
    await api.waitFor(`!document.getElementById('inbox-count').hidden`, { timeout: 30000 })
    const after = await api.eval(`({
      count: document.getElementById('inbox-count').textContent,
      rows: [...document.querySelectorAll('#inbox-rows tr')].map(tr => [...tr.children].map(td => td.textContent)),
      dropped: [...document.querySelectorAll('#inbox-dropped-list li')].map(li => li.textContent),
      who: document.getElementById('identity-key').textContent,
    })`)
    check('the form\'s key signs in and the responses are decrypted and screened: two live v4 rows shown of four kept, two dropped (the event addressed to another form never arrives: the relay query is on this form\'s a tag)', after.count === '2 of 4 shown · 2 dropped by policy' && after.rows.length === 2, JSON.stringify(after))
    check('the newest first; each row carries the date, version, signer, contact, app, users, team, regions, volume, the recomputed headline and a link', after.rows[0][1] === 'v4' && after.rows[0][3] === 'signed in' && after.rows[0][7] === '200,000' && after.rows[0][8] === '≤50' && after.rows[0][9] === 'EU, US' && after.rows[0][10] === '$50k' && /^\$\d+(\.\d+)?[kM]$/.test(after.rows[0][11]) && after.rows[0][12] === 'open' && after.rows[1][5] === 'alice@example.com' && after.rows[1][7] === '50,000' && after.rows[1][11] === '$210k', JSON.stringify(after.rows))
    const versionFilter = await api.eval(`({ value: document.getElementById('inbox-version').value, options: [...document.getElementById('inbox-version').options].map(o => o.value + ':' + o.textContent) })`)
    check('the version filter defaults to v4 and up and lists all versions and each one present', versionFilter.value === 'recent' && versionFilter.options.join(' | ') === 'recent:v4 and up | all:All versions | 4:v4 only | 3:v3 only', JSON.stringify(versionFilter))
    await api.eval(`document.getElementById('inbox-version').value = 'all'; document.getElementById('inbox-version').dispatchEvent(new Event('change'))`)
    const withOld = await api.eval(`({ count: document.getElementById('inbox-count').textContent, last: [...document.querySelectorAll('#inbox-rows tr')].pop().children[11].textContent, version: [...document.querySelectorAll('#inbox-rows tr')].pop().children[1].textContent })`)
    check('all versions brings in the version-3 response, showing the figures it saved rather than a recompute', withOld.count === '3 of 4 shown · 2 dropped by policy' && withOld.version === 'v3' && withOld.last === '$310k custody · $20k Nostr (v3, as saved)', JSON.stringify(withOld))
    await api.eval(`document.getElementById('inbox-version').value = 'recent'; document.getElementById('inbox-version').dispatchEvent(new Event('change'))`)
    check('"Proof of work required" is on by default', await api.eval(`document.getElementById('inbox-pow').checked`))
    await api.eval(`document.getElementById('inbox-pow').checked = false; document.getElementById('inbox-pow').dispatchEvent(new Event('change'))`)
    const noPow = await api.eval(`({ count: document.getElementById('inbox-count').textContent, tiers: [...document.querySelectorAll('#inbox-rows tr td:nth-child(4)')].map(td => td.textContent), dropped: [...document.querySelectorAll('#inbox-dropped-list li')].map(li => li.textContent) })`)
    check('with it off, the unverified key\'s response below the proof of work is shown too, still labelled unverified; the duplicate stays dropped', noPow.count === '3 of 5 shown · 1 dropped by policy' && noPow.tiers.includes('unverified') && noPow.dropped.length === 1 && /duplicate of/.test(noPow.dropped[0]), JSON.stringify(noPow))
    await api.eval(`document.getElementById('inbox-pow').checked = true; document.getElementById('inbox-pow').dispatchEvent(new Event('change'))`)
    check('…and back on, it is dropped again', (await api.eval(`document.getElementById('inbox-count').textContent`)) === '2 of 4 shown · 2 dropped by policy')
    check('dropped: the unverified key below the proof of work, and the older duplicate, each with its reason', after.dropped.length === 2 && after.dropped.some(d => /proof of work \d+ below 20/.test(d)) && after.dropped.some(d => /duplicate of/.test(d)), after.dropped.join(' | '))
    await api.eval(`document.getElementById('inbox-mode').value = 'all'; document.getElementById('inbox-mode').dispatchEvent(new Event('change'))`)
    const all = await api.eval(`({ count: document.getElementById('inbox-count').textContent, tests: document.querySelectorAll('#inbox-rows tr.is-test').length })`)
    check('showing tests too adds the flagged row, drawn quiet', all.count === '3 of 4 shown · 2 dropped by policy' && all.tests === 1, JSON.stringify(all))
    await api.eval(`document.getElementById('inbox-contact').checked = true; document.getElementById('inbox-contact').dispatchEvent(new Event('change'))`)
    check('"only with contact details" keeps the row with an email', (await api.eval(`document.querySelectorAll('#inbox-rows tr').length + ':' + document.querySelector('#inbox-rows tr td:nth-child(6)').textContent`)) === '1:alice@example.com')
    await api.eval(`document.getElementById('inbox-contact').checked = false; document.getElementById('inbox-contact').dispatchEvent(new Event('change')); document.getElementById('inbox-sort').value = 'savings'; document.getElementById('inbox-sort').dispatchEvent(new Event('change'))`)
    const sorted = await api.eval(`[...document.querySelectorAll('#inbox-rows tr td:nth-child(8)')].map(td => td.textContent)`)
    check('sorted by savings, the largest app comes first', sorted[0] === '200,000', sorted.join(' | '))
    const csv = await api.eval(`window.__inboxCsv()`)
    check('the CSV is made in the browser, a header and one line per visible row', csv.split('\n').length === 4 && csv.startsWith('Date,Version,Test,Signer,') && csv.includes('alice@example.com'), csv.split('\n')[0])
    const foreign = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith(RELAY) && !u.startsWith('ws://127.0.0.1'))
    check('nothing left the browser but the relay', foreign.length === 0, foreign.join(' '))
    check('no console errors', logs.length === 0, logs.join(' | '))
  })
} finally {
  await writeFile(SNAPSHOT, committed)
  pool.destroy()
  stopRelay()
}
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
