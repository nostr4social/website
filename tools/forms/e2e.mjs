// End-to-end test of the form pipeline, offline: a template is published to
// a local in-memory relay (nak serve), the real submit module builds and
// publishes a response to it, and the response is read back and decrypted
// with the form's secret, as formstr.app would.
//
//   npm run e2e:form            # needs `nak` on the PATH
//
// It runs the real assets/js/calculator/src/submit.js and the shared forms
// module, bundled for node with the vendor imports aliased to the package.

import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { getConversationKey, decrypt, encrypt } from 'nostr-tools/nip44'
import { bytesToHex } from '@noble/hashes/utils.js'
import { getPow } from 'nostr-tools/nip13'
import { root, readMap, readSnapshot, parseTemplate, formAddress, KIND_FORM, KIND_RESPONSE, checkMap } from './lib.mjs'
import { fixtureTemplate, localRelay } from './fixture.mjs'

useWebSocketImplementation(WebSocket)
const PORT = 10547
const RELAY = `ws://127.0.0.1:${PORT}`
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// ── a local relay ─────────────────────────────────────────────────────────────
const stopRelay = await localRelay(PORT, { spawn })

try {
  // ── the form, as formstr.app would publish it ─────────────────────────────
  const map = await readMap()
  const committed = await readSnapshot()
  const { event: template, secret: formSecret, pubkey: formPubkey } = fixtureTemplate(committed, RELAY)
  const pool = new SimplePool()
  await Promise.allSettled(pool.publish([RELAY], template))

  const fetched = await pool.get([RELAY], { kinds: [KIND_FORM], authors: [formPubkey], '#d': [committed.d] })
  check('the template is on the relay', Boolean(fetched))
  const snapshot = parseTemplate(fetched)
  check('labels are read with their HTML stripped', snapshot.name === committed.name && snapshot.fields[0].label === committed.fields[0].label, snapshot.fields[0].label)
  check('grids are read with their rows and columns', snapshot.fields.some((f) => f.grid && f.grid.rows.length && f.grid.columns.length))
  check('the snapshot carries the relay list', snapshot.relays.join() === RELAY)

  // ── the page's submit module, bundled for node ────────────────────────────
  const dir = await mkdtemp(join(tmpdir(), 'nostr4-form-e2e-'))
  const strings = { compose: { header: 'via test:', subject: 'lead', results: '{custodial} / {noncustodial}', five_year: 'five years {five_year}, low {low}', fees: 'fees {amount}', link: 'link {link}', open: 'open {link}' } }
  const config = { relays: { fallback_dm: [RELAY], discovery: [RELAY] }, timeouts: { publish: 4000, discovery: 2000 }, pow: { response: 12 } }
  const shim = join(dir, 'shim.mjs')
  await writeFile(shim, `
    globalThis.document = { getElementById: (id) => ({ textContent: id === 'page-strings' ? ${JSON.stringify(JSON.stringify(strings))} : id === 'page-config' ? ${JSON.stringify(JSON.stringify(config))} : null }) }
    globalThis.location = { hostname: 'localhost', search: '?relay=${RELAY}' }
    globalThis.Worker = undefined
  `)
  const entry = join(dir, 'entry.mjs')
  await writeFile(entry, `import '${shim}'\nexport * from '${resolve(root, 'assets/js/calculator/src/submit.js')}'\nexport * as restore from '${resolve(root, 'assets/js/calculator/src/restore.js')}'\nexport { createGuestSigner } from '${resolve(root, 'assets/js/shared/src/signers.js')}'\nexport { readResponses, formSecretFromList } from '${resolve(root, 'assets/js/shared/src/forms.js')}'\n`)
  const out = join(dir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    nodePaths: [resolve(root, 'node_modules')],
    absWorkingDir: root,
    logLevel: 'warning',
    plugins: [{
      name: 'alias-vendor',
      setup(b) {
        b.onResolve({ filter: /^\/assets\/js\/vendor\/nostr-tools\// }, () => ({ path: 'nostr-tools-shim', namespace: 'shim' }))
        b.onResolve({ filter: /^\/assets\/js\/vendor\/uqr\// }, () => ({ path: resolve(root, 'node_modules/uqr/dist/index.mjs') }))
        b.onLoad({ filter: /^nostr-tools-shim$/, namespace: 'shim' }, () => ({
          contents: `
            export { generateSecretKey, getPublicKey, finalizeEvent, getEventHash, verifyEvent } from 'nostr-tools/pure'
            export { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
            export { decode as decodeNip19, npubEncode, neventEncode } from 'nostr-tools/nip19'
            export { getConversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from 'nostr-tools/nip44'
            export { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46'
          `,
          resolveDir: root,
        }))
      },
    }],
  })
  const m = await import(`file://${out}`)

  check('every id in the map is in the template', checkMap(snapshot, map).length === 0, checkMap(snapshot, map).join(' | '))
  const form = m.prepareForm(snapshot, map)
  check('the page accepts the form', Boolean(form))
  const bad = m.prepareForm({ ...snapshot, fields: snapshot.fields.slice(1) }, map)
  check('a template missing a mapped question is refused', bad === null)

  const values = { mau: 50000, posts_per_user: 20, rails: ['apple', 'processor'], rev: 20000, jur: ['eu', 'us'], growth: '0.5', balances: [], engineering: { accounts: 5, infra: 25 }, mod_who: 'team', mod_heads: '3', team: 'ten', kind: 'feed', nostr_now: '0.5', nostr: { keys: 1, media_storage: 0.5 }, legal_usd: '', result_custodial: 967914, result_noncustodial: 266254, fees_saved: 4200, link: 'https://nostr4.social/calculator/?mau=50000', overrides: '', version: '1', email: 'founder@example.com', test: '' }
  const signer = m.createGuestSigner()
  const started = Date.now()
  const { event, relays, ok } = await m.submitResponse(form, { signer, values, pow: 12 })
  check('the response was accepted by the relay', ok === 1 && relays[0].ok, JSON.stringify(relays))
  check('it is a kind 1069 signed by the one-time key', event.kind === KIND_RESPONSE && event.pubkey === signer.pubkey && verifyEvent(event))
  check('it points at the form', event.tags.some((t) => t[0] === 'a' && t[1] === formAddress(snapshot)))
  check('it carries at least 12 bits of proof of work', getPow(event.id) >= 12, `${getPow(event.id)} bits in ${Date.now() - started} ms`)
  check('the content is not plaintext', !event.content.includes('founder@example.com') && !event.content.includes('50000'))

  // ── read back as the form holder ──────────────────────────────────────────
  const got = await pool.get([RELAY], { kinds: [KIND_RESPONSE], '#a': [formAddress(snapshot)] })
  check('the response is on the relay under the form address', Boolean(got) && got.id === event.id)
  const key = getConversationKey(formSecret, got.pubkey)
  const answers = JSON.parse(decrypt(got.content, key))
  const byId = Object.fromEntries(snapshot.fields.map((f) => [f.id, f]))
  const byLabel = {}
  for (const [, id, value] of answers) byLabel[byId[id].label] = value
  check('the form secret decrypts the answers', answers.length > 0 && answers.every((a) => a[0] === 'response' && a[3] === '{}'))
  const label = (key) => byId[map.fields[key].id].label
  check('numbers come back as given', byLabel[label('mau')] === '50000' && byLabel[label('result_custodial')] === '967914', JSON.stringify(byLabel))
  check('the fees saved travel as their own question', byLabel[label('fees_saved')] === '4200', byLabel[label('fees_saved')])
  const railIds = byLabel[label('rails')].split(';')
  check('a multi-choice answer is option ids joined by ;', railIds.join(';') === `${map.fields.rails.options.apple};${map.fields.rails.options.processor}`)
  const eng = JSON.parse(byLabel[label('engineering')])
  check('a grid answer is JSON of row id to column id', eng[map.fields.engineering.rows.accounts] === map.fields.engineering.columns['5'] && eng[map.fields.engineering.rows.infra] === map.fields.engineering.columns['25'] && Object.keys(eng).length === 2, byLabel[label('engineering')])
  const nostr = JSON.parse(byLabel[label('nostr')])
  check('a half answer maps to the Somewhat column', nostr[map.fields.nostr.rows.media_storage] === map.fields.nostr.columns['0.5'])
  check('a single-choice answer is its option id', byLabel[label('growth')] === map.fields.growth.options['0.5'], byLabel[label('growth')])
  check('blank values are left out', !(label('app_name') in byLabel) && !(label('test') in byLabel) && !(label('legal_usd') in byLabel) && !(label('balances') in byLabel))
  check('a stranger cannot decrypt it', (() => { try { decrypt(got.content, getConversationKey(generateSecretKey(), got.pubkey)); return false } catch { return true } })())

  // ── the lead message ──────────────────────────────────────────────────────
  const text = m.composeLead({ inputs: { mau: 50000, jur: ['eu', 'us'] }, result: { custodial: '$968k', noncustodial: '$266k', five_year: '$3.1M', low: '$400k', fees: '$4.2k' }, link: 'https://x', contact: { email: 'founder@example.com' }, fieldLabels: { mau: { label: 'Monthly active users' } } })
  check('the lead text names the source, the inputs, the figures, the fees, the link and the contact, and nothing about payback', text.startsWith('via test:') && text.includes('Monthly active users: 50000') && text.includes('jur: eu, us') && text.includes('$968k / $266k') && text.includes('five years $3.1M, low $400k') && text.includes('fees $4.2k') && text.includes('link https://x') && !/payback/i.test(text) && text.endsWith('email: founder@example.com'), text)

  // ── reading a response back ───────────────────────────────────────────────
  const back = m.readResponses(map, answers)
  check('response tags read back into values keyed like the map', back.mau === '50000' && back.growth.join() === '0.5' && back.mod_who.join() === 'team' && back.mod_heads.join() === '3' && back.kind.join() === 'feed' && back.rails.join() === 'apple,processor' && back.engineering.accounts === '5' && back.engineering.infra === '25' && back.nostr.media_storage === '0.5' && back.email === 'founder@example.com', JSON.stringify(back))

  // The responder opens it with the key that sent it.
  const asResponder = await m.restore.openResponse(got, { signer, snapshot, map })
  check('the responder\'s key opens the response', asResponder.how === 'responder' && asResponder.values.mau === '50000', JSON.stringify(asResponder.error || asResponder.how))
  const stranger = m.createGuestSigner()
  const asStranger = await m.restore.openResponse(got, { signer: stranger, snapshot, map })
  check('a stranger\'s key cannot', asStranger.error === 'restore_locked')

  // The form holder opens it through their My Forms list (kind 14083), as formstr.app would.
  const holderSecret = generateSecretKey()
  const holderPub = getPublicKey(holderSecret)
  const list = [['f', `${snapshot.pubkey}:${snapshot.d}`, RELAY, bytesToHex(formSecret)]]
  const listEvent = finalizeEvent({ kind: 14083, created_at: Math.floor(Date.now() / 1000), tags: [], content: encrypt(JSON.stringify(list), getConversationKey(holderSecret, holderPub)) }, holderSecret)
  await Promise.allSettled(pool.publish([RELAY], listEvent))
  const holder = { kind: 'nip07', pubkey: holderPub, nip44Decrypt: async (target, ciphertext) => decrypt(ciphertext, getConversationKey(holderSecret, target)) }
  check('the form\'s secret is found in the holder\'s list', m.formSecretFromList(list, snapshot) === bytesToHex(formSecret))
  const asHolder = await m.restore.openResponse(got, { signer: holder, snapshot, map })
  check('the holder\'s key opens it through the list', asHolder.how === 'holder' && asHolder.values.email === 'founder@example.com', JSON.stringify(asHolder.error || asHolder.how))

  signer.close()
  pool.destroy()
  await rm(dir, { recursive: true, force: true })
} finally {
  stopRelay()
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
