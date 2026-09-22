// Protocol end-to-end test for the contact form's NIP-17 pipeline.
//
//   node tools/contact-bundle/e2e.mjs                 # crypto only, offline
//   node tools/contact-bundle/e2e.mjs wss://relay...  # also publish and read back
//
// This runs the real assets/js/contact/src/nip17.js — not a copy of it. The
// module imports the vendored browser bundle by absolute URL, so the bundler
// here aliases that path to the installed package.

import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Rewrites the page's vendor URLs to the packages node can actually load. */
const aliasVendor = {
  name: 'alias-vendor',
  setup(b) {
    b.onResolve({ filter: /^\/assets\/js\/vendor\/nostr-tools\// }, () => ({
      path: 'nostr-tools-shim',
      namespace: 'shim',
    }))
    b.onResolve({ filter: /^\/assets\/js\/vendor\/uqr\// }, () => ({
      path: resolve(root, 'node_modules/uqr/dist/index.mjs'),
    }))
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
}

const dir = await mkdtemp(join(tmpdir(), 'nostr4-e2e-'))
const entry = join(dir, 'entry.mjs')
await writeFile(
  entry,
  `export * from '${resolve(root, 'assets/js/contact/src/nip17.js')}'\n` +
    `export { useWebSocketImplementation } from 'nostr-tools/pool'\n` +
    `export * as pure from 'nostr-tools/pure'\n` +
    `export * as nip59 from 'nostr-tools/nip59'\n` +
    `export * as nip44 from 'nostr-tools/nip44'\n` +
    `export { SimplePool } from 'nostr-tools/pool'\n`,
)
const out = join(dir, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [aliasVendor],
  // The entry lives in a temp dir, so point resolution back at the repo.
  nodePaths: [resolve(root, 'node_modules')],
  absWorkingDir: root,
  logLevel: 'warning',
})

const m = await import(`file://${out}`)
const { buildRumor, sealFor, wrapFor, publishWrap, KIND_CHAT, KIND_SEAL, KIND_WRAP } = m
const { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } = m.pure

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// A guest signer, exactly as signers.js builds one.
const senderKey = generateSecretKey()
const senderPubkey = getPublicKey(senderKey)
const signer = {
  kind: 'guest',
  pubkey: senderPubkey,
  signEvent: async (t) => finalizeEvent(t, senderKey),
  nip44Encrypt: async (target, plaintext) =>
    m.nip44.encrypt(plaintext, m.nip44.getConversationKey(senderKey, target)),
}

const recipientKey = generateSecretKey()
const recipientPubkey = getPublicKey(recipientKey)
const strangerKey = generateSecretKey()

const subject = 'A test subject'
const content = 'Hello from the contact form end-to-end test.\n\nReply to: nobody'

const rumor = buildRumor({
  senderPubkey,
  recipients: [{ pubkey: recipientPubkey }],
  subject,
  content,
})

check('rumor is kind 14', rumor.kind === KIND_CHAT)
check('rumor carries an id', /^[0-9a-f]{64}$/.test(rumor.id))
check('rumor is unsigned', rumor.sig === undefined)
check('rumor has a p tag per recipient', rumor.tags.filter((t) => t[0] === 'p').length === 1)
check('rumor carries the subject', rumor.tags.some((t) => t[0] === 'subject' && t[1] === subject))

const seal = await sealFor(signer, rumor, recipientPubkey)
check('seal is kind 13', seal.kind === KIND_SEAL)
check('seal has no tags', Array.isArray(seal.tags) && seal.tags.length === 0)
check('seal is signed by the sender', seal.pubkey === senderPubkey && verifyEvent(seal))
check('seal is backdated', seal.created_at <= Math.floor(Date.now() / 1000))

const { wrap, ephemeralKey } = wrapFor(seal, recipientPubkey, 'wss://relay.example')
check('wrap is kind 1059', wrap.kind === KIND_WRAP)
check('wrap is not signed by the sender', wrap.pubkey !== senderPubkey)
check('wrap is signed by the ephemeral key', wrap.pubkey === getPublicKey(ephemeralKey) && verifyEvent(wrap))
check(
  'wrap is addressed to the recipient with a relay hint',
  wrap.tags.some((t) => t[0] === 'p' && t[1] === recipientPubkey && t[2] === 'wss://relay.example'),
)

// The recipient can open it, and gets back exactly what was written.
const unwrapped = m.nip59.unwrapEvent(wrap, recipientKey)
check('recipient recovers the rumor', unwrapped.id === rumor.id)
check('content survives the round trip', unwrapped.content === content)
check('subject survives the round trip', unwrapped.tags.some((t) => t[0] === 'subject' && t[1] === subject))
check('sender is visible to the recipient only', unwrapped.pubkey === senderPubkey)

// Nobody else can.
let leaked = false
try {
  m.nip59.unwrapEvent(wrap, strangerKey)
  leaked = true
} catch {
  leaked = false
}
check('a third party cannot unwrap it', !leaked)

// A relay that cannot be reached must come back as a reported failure, not as a
// thrown error that loses the other relays' results. This writes to nothing.
//
// Node's WebSocket is swapped for a stub that fails once. Undici re-fires
// `error` when the socket is closed from inside its own error handler, which
// sends nostr-tools into unbounded recursion — a Node quirk, not a browser one,
// and not the thing under test here.
{
  class FailingWebSocket extends EventTarget {
    constructor() {
      super()
      this.readyState = 0
      queueMicrotask(() => this.onerror?.(new Event('error')))
    }
    close() {}
    send() {}
  }
  m.useWebSocketImplementation(FailingWebSocket)

  const pool = new m.SimplePool()
  const results = await publishWrap(pool, ['wss://dead.invalid'], wrap, ephemeralKey, { maxWait: 4000 })
  check('a dead relay yields one result', results.length === 1)
  check('a dead relay is reported, not thrown', results[0] && results[0].ok === false, results[0]?.reason)
  pool.destroy()
  m.useWebSocketImplementation(globalThis.WebSocket)
}

// Publishing for real is opt-in, because it writes to someone else's relay.
//   node tools/contact-bundle/e2e.mjs wss://relay.example
const relayArg = process.argv.slice(2).filter((a) => a.startsWith('wss://'))
if (relayArg.length) {
  const pool = new m.SimplePool()
  const relays = [...relayArg, 'wss://dead.invalid']
  const results = await publishWrap(pool, relays, wrap, ephemeralKey, { maxWait: 8000 })
  for (const r of results) console.log(`     ${r.ok ? 'accepted' : 'refused '} ${r.url}  ${r.reason}`)
  check('at least one relay accepted the wrap', results.some((r) => r.ok))
  pool.destroy()
}

ephemeralKey.fill(0)
await rm(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
