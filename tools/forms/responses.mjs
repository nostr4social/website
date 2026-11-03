// Read the calculator's responses straight from the site's relays, screen
// them by the page's own policy, decrypt what the key allows, and print
// them. For triage when the results page is not to hand.
//
//   FORM_SECRET=<hex or nsec> npm run responses -- [--since 7d] [--test]
//
// The form's secret key decrypts the content; it is pasted in locally and
// never stored. Without it the script still lists the events, their
// signature check, their proof-of-work difficulty and their age, which is
// enough to see a flood. --test includes rows whose test marker is set.
//
// The policy (assets/js/shared/src/policy.js, shared with the results page):
// an event must carry the form's `a` tag and a good signature; a key with a
// published profile is `signed-in`, any other is `unverified` and must carry
// `pow.response` bits; duplicates by content fingerprint are collapsed to
// the newest. What was dropped is printed with its reason.

import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { verifyEvent } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { hexToBytes } from '@noble/hashes/utils.js'
import { formAddress, KIND_RESPONSE, readMap, readSnapshot } from './lib.mjs'
import { discoveryRelays, powConfig, siteRelays } from '../lib/config.mjs'
import { screenResponses } from '../../assets/js/shared/src/policy.js'

class SafeWebSocket extends WebSocket {
  close(...args) {
    if (this.readyState >= WebSocket.CLOSING) return
    super.close(...args)
  }
}
useWebSocketImplementation(SafeWebSocket)
process.on('uncaughtException', (err) => console.error('relay error:', err?.message || err))

const args = process.argv.slice(2)
const since = (() => {
  const at = args.indexOf('--since')
  if (at < 0) return 0
  const m = String(args[at + 1]).match(/^(\d+)([dh])$/)
  if (!m) return 0
  return Math.floor(Date.now() / 1000) - Number(m[1]) * (m[2] === 'd' ? 86400 : 3600)
})()
const includeTest = args.includes('--test')

const snapshot = await readSnapshot()
const map = await readMap()
const labelFor = Object.fromEntries(snapshot.fields.map((f) => [f.id, f.label]))
const optionLabel = Object.fromEntries(snapshot.fields.flatMap((f) => [...f.options, ...(f.rows || []), ...(f.columns || [])].map((o) => [o.id, o.label])))
const testId = map.fields.test?.id
const testOption = map.fields.test?.options?.yes
const pow = powConfig()

let secret = null
if (process.env.FORM_SECRET) {
  const raw = process.env.FORM_SECRET.trim()
  secret = raw.startsWith('nsec1') ? decode(raw).data : hexToBytes(raw)
}

const relays = siteRelays()
const pool = new SimplePool()
const filter = { kinds: [KIND_RESPONSE], '#a': [formAddress(snapshot)] }
if (since) filter.since = since
const events = await pool.querySync(relays, filter, { maxWait: 10000 })

const seen = new Map()
for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e)

// Which authors are signed-in people: those with a published profile.
const authors = [...new Set([...seen.values()].map((e) => e.pubkey))]
const known = new Set()
if (authors.length) {
  const profiles = await pool.querySync(discoveryRelays(), { kinds: [0], authors }, { maxWait: 6000 }).catch(() => [])
  for (const p of profiles) known.add(p.pubkey)
}
pool.destroy()

const rows = [...seen.values()].map((e) => {
  let answers = null
  if (secret) {
    try {
      answers = JSON.parse(decrypt(e.content, getConversationKey(secret, e.pubkey)))
    } catch {
      answers = 'undecryptable'
    }
  }
  return { event: e, answers: Array.isArray(answers) ? answers : null, undecryptable: answers === 'undecryptable' }
})
const { kept, dropped } = screenResponses(rows, { address: formAddress(snapshot), minPow: pow.response, known, verify: verifyEvent, testId, testOption })

const shown = kept.filter((r) => includeTest || !r.test)
console.log(`${shown.length} response(s) for "${snapshot.name}" on ${relays.length} relays${since ? ' since the window' : ''}${secret ? '' : ' (no FORM_SECRET: listing only)'}; ${dropped.length} dropped by policy${kept.length - shown.length ? `, ${kept.length - shown.length} test` : ''}\n`)
for (const r of shown) {
  const e = r.event
  const at = new Date(e.created_at * 1000).toISOString().slice(0, 16)
  console.log(`${at}  ${e.id.slice(0, 12)}  pow ${String(r.pow).padStart(2)}  ${r.label.padEnd(10)} by ${e.pubkey.slice(0, 8)}${r.test ? '  TEST' : ''}`)
  if (r.answers) {
    for (const [, id, value] of r.answers.filter((t) => t[0] === 'response')) {
      const label = labelFor[id] || id
      if (String(value).startsWith('{')) {
        try {
          console.log(`    ${label}: ${Object.entries(JSON.parse(value)).map(([row, col]) => `${optionLabel[row] || row}: ${optionLabel[col] || col}`).join('; ')}`)
          continue
        } catch { /* fall through */ }
      }
      console.log(`    ${label}: ${String(value).split(';').map((v) => optionLabel[v] || v).join(', ')}`)
    }
    const consent = r.answers.find((t) => t[0] === 'consent')
    if (consent) console.log(`    consent: version ${consent[1]} at ${consent[2]}`)
  } else if (rows.find((x) => x.event === e)?.undecryptable) console.log('    undecryptable')
}
if (dropped.length) {
  console.log('\ndropped:')
  for (const d of dropped) console.log(`  ${d.event?.id?.slice(0, 12) || '?'}  ${d.reason}`)
}
