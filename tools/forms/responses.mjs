// Read the calculator's responses straight from the relays, verify each one,
// and print them. For triage when the formstr dashboard is not enough.
//
//   FORM_SECRET=<hex or nsec> npm run responses -- [--since 7d] [--test]
//
// The form's secret key decrypts the content; it is pasted in locally and
// never stored. Without it the script still lists events, their signature
// check, their proof-of-work difficulty and their age, which is enough to
// see a flood. --test includes rows whose test marker is set.

import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { verifyEvent } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'
import { getConversationKey, decrypt } from 'nostr-tools/nip44'
import { getPow } from 'nostr-tools/nip13'
import { hexToBytes } from '@noble/hashes/utils.js'
import { formAddress, KIND_RESPONSE, readMap, readSnapshot, DEFAULT_RELAYS } from './lib.mjs'

useWebSocketImplementation(WebSocket)

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
const optionLabel = Object.fromEntries(snapshot.fields.flatMap((f) => [...f.options, ...(f.grid?.rows || []), ...(f.grid?.columns || [])].map((o) => [o.id, o.label])))
const testId = map.fields.test?.id

let secret = null
if (process.env.FORM_SECRET) {
  const raw = process.env.FORM_SECRET.trim()
  secret = raw.startsWith('nsec1') ? decode(raw).data : hexToBytes(raw)
}

const relays = [...new Set([...snapshot.relays, ...DEFAULT_RELAYS])]
const pool = new SimplePool()
const filter = { kinds: [KIND_RESPONSE], '#a': [formAddress(snapshot)] }
if (since) filter.since = since
const events = await pool.querySync(relays, filter, { maxWait: 10000 })
pool.destroy()

const seen = new Map()
for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e)
const rows = []
for (const e of seen.values()) {
  const row = { id: e.id.slice(0, 12), at: new Date(e.created_at * 1000).toISOString().slice(0, 16), sig: verifyEvent(e), pow: getPow(e.id), by: e.pubkey.slice(0, 8), test: '', answers: null }
  if (secret) {
    try {
      const key = getConversationKey(secret, e.pubkey)
      const list = JSON.parse(decrypt(e.content, key))
      row.answers = {}
      for (const [, id, value] of list) {
        const label = labelFor[id] || id
        if (value.startsWith('{')) {
          try {
            row.answers[label] = Object.entries(JSON.parse(value)).map(([r, c]) => `${optionLabel[r] || r}: ${optionLabel[c] || c}`).join('; ')
            continue
          } catch { /* fall through */ }
        }
        row.answers[label] = value.split(';').map((v) => optionLabel[v] || v).join(', ')
        if (id === testId) row.test = value
      }
    } catch {
      row.answers = 'undecryptable'
    }
  }
  if (row.test && !includeTest) continue
  rows.push(row)
}
rows.sort((a, b) => (a.at < b.at ? 1 : -1))
console.log(`${rows.length} response(s) for "${snapshot.name}" on ${relays.length} relays${since ? ' since the window' : ''}${secret ? '' : ' (no FORM_SECRET: listing only)'}\n`)
for (const r of rows) {
  console.log(`${r.at}  ${r.id}  sig ${r.sig ? 'ok ' : 'BAD'}  pow ${String(r.pow).padStart(2)}  by ${r.by}${r.test ? '  TEST' : ''}`)
  if (r.answers && typeof r.answers === 'object') for (const [k, v] of Object.entries(r.answers)) console.log(`    ${k}: ${v}`)
  else if (r.answers) console.log(`    ${r.answers}`)
}
