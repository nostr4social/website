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
import { generateSecretKey, verifyEvent } from 'nostr-tools/pure'
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { getPow } from 'nostr-tools/nip13'
import { root, readRecipe, parseTemplate, formAddress, KIND_FORM, KIND_RESPONSE } from './lib.mjs'
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
  const recipe = await readRecipe()
  const { event: template, secret: formSecret, pubkey: formPubkey } = fixtureTemplate(recipe, RELAY)
  const pool = new SimplePool()
  await Promise.allSettled(pool.publish([RELAY], template))

  const fetched = await pool.get([RELAY], { kinds: [KIND_FORM], authors: [formPubkey], '#d': ['cost-of-custody-test'] })
  check('the template is on the relay', Boolean(fetched))
  const snapshot = parseTemplate(fetched)
  check('labels are read with their HTML stripped', snapshot.name === 'Cost of Custody test' && snapshot.fields[0].label === 'Monthly active users', snapshot.fields[0].label)
  check('the snapshot carries the relay list', snapshot.relays.join() === RELAY)

  // ── the page's submit module, bundled for node ────────────────────────────
  const dir = await mkdtemp(join(tmpdir(), 'nostr4-form-e2e-'))
  const strings = { compose: { header: 'via test:', subject: 'lead', results: '{custodial} / {noncustodial}', link: 'link {link}', name: 'Name', company: 'Company', email: 'Email', npub: 'Nostr' } }
  const config = { relays: { fallback_dm: [RELAY], discovery: [RELAY] }, timeouts: { publish: 4000, discovery: 1000 }, pow: { response: 12 } }
  const shim = join(dir, 'shim.mjs')
  await writeFile(shim, `
    globalThis.document = { getElementById: (id) => ({ textContent: id === 'page-strings' ? ${JSON.stringify(JSON.stringify(strings))} : id === 'page-config' ? ${JSON.stringify(JSON.stringify(config))} : null }) }
    globalThis.location = { hostname: 'example.test', search: '' }
    globalThis.Worker = undefined
  `)
  const entry = join(dir, 'entry.mjs')
  await writeFile(entry, `import '${shim}'\nexport * from '${resolve(root, 'assets/js/calculator/src/submit.js')}'\nexport { createGuestSigner } from '${resolve(root, 'assets/js/shared/src/signers.js')}'\n`)
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
            export { decode as decodeNip19, npubEncode } from 'nostr-tools/nip19'
            export { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44'
            export { BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46'
          `,
          resolveDir: root,
        }))
      },
    }],
  })
  const m = await import(`file://${out}`)

  const form = m.prepareForm(snapshot, recipe)
  check('the recipe maps onto the template', Boolean(form) && Object.keys(form.mapping.fields).length === Object.keys(recipe.fields).length)
  const bad = m.prepareForm({ ...snapshot, fields: snapshot.fields.slice(1) }, recipe)
  check('a template missing a question is refused', bad === null)

  const values = { mau: 50000, posts: 1000000, eng: 3, ts: 'inhouse', ts_n: 2, pay: 'yes', rev: 20000, stores: ['apple', 'web'], jur: ['eu', 'us'], nostr: [], hrs: null, result_custodial: 967914, result_noncustodial: 266254, link: 'https://nostr4.social/calculator/?mau=50000', overrides: '', version: '1', email: 'founder@example.com', test: '' }
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
  check('numbers come back as given', byLabel['Monthly active users'] === '50000' && byLabel['Annual custodial cost (USD, typical)'] === '967914', JSON.stringify(byLabel))
  const stores = byId[form.mapping.fields.stores.id]
  const storeIds = byLabel['App stores'].split(';')
  check('a multi-choice answer is option ids joined by ;', storeIds.length === 2 && storeIds.every((id) => stores.options.some((o) => o.id === id)))
  check('a single choice is one option id', stores.options.length === 3 && byLabel['Trust and safety function'] === byId[form.mapping.fields.ts.id].options.find((o) => o.label === 'In-house').id)
  check('blank values are left out', !('Name' in byLabel) && !('test' in byLabel) && !('Engineer hours per week on custody work' in byLabel))
  check('a stranger cannot decrypt it', (() => { try { decrypt(got.content, getConversationKey(generateSecretKey(), got.pubkey)); return false } catch { return true } })())

  // ── the lead message ──────────────────────────────────────────────────────
  const text = m.composeLead({ inputs: { mau: 50000, jur: ['eu', 'us'] }, result: { custodial: '$968k', noncustodial: '$266k' }, link: 'https://x', contact: { email: 'founder@example.com' }, fieldLabels: { mau: { label: 'Monthly active users' } } })
  check('the lead text names the source, the inputs, the figures, the link and the contact', text.startsWith('via test:') && text.includes('Monthly active users: 50000') && text.includes('jur: eu, us') && text.includes('$968k / $266k') && text.includes('link https://x') && text.endsWith('Email: founder@example.com'), text)

  signer.close()
  pool.destroy()
  await rm(dir, { recursive: true, force: true })
} finally {
  stopRelay()
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
