// Read-only: does each recipient in .well-known/nostr.json have a kind 10050
// inbox-relay list (NIP-17) and a kind 0 profile? Without a 10050 the contact
// form falls back to the site's relays, which the recipient may never read.
//
//   npm run check:inboxes            # profiles and inbox lists
//   npm run check:inboxes -- --wraps # also count the gift wraps waiting in each inbox
//
// With --wraps the wraps addressed to each recipient on their inbox relays
// (or the site's, without a 10050) are screened by the page's own policy
// (assets/js/shared/src/policy.js): a wrap below `pow.anonymous` bits is
// dropped and said so. Nothing is decrypted here; that takes the key.
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { verifyEvent } from 'nostr-tools/pure'
import { readFileSync } from 'node:fs'
import { discoveryRelays, powConfig, siteRelays } from '../lib/config.mjs'
import { screenWraps } from '../../assets/js/shared/src/policy.js'

// Node's WebSocket re-fires onerror from close(); nostr-tools calls close()
// from onerror. A relay that refuses the connection would recurse forever.
class SafeWebSocket extends WebSocket {
  close(...args) {
    if (this.readyState >= WebSocket.CLOSING) return
    super.close(...args)
  }
}
useWebSocketImplementation(SafeWebSocket)
process.on('uncaughtException', (err) => console.error('relay error:', err?.message || err))

const wraps = process.argv.includes('--wraps')
const names = JSON.parse(readFileSync(new URL('../../.well-known/nostr.json', import.meta.url), 'utf8')).names
const relays = discoveryRelays()
const pow = powConfig()
const pool = new SimplePool()
for (const [name, pubkey] of Object.entries(names)) {
  const dm = await pool.get(relays, { kinds: [10050], authors: [pubkey] }, { maxWait: 6000 }).catch(() => null)
  const meta = await pool.get(relays, { kinds: [0], authors: [pubkey] }, { maxWait: 6000 }).catch(() => null)
  let n = null
  try { n = JSON.parse(meta?.content || '{}') } catch {}
  const inbox = dm ? dm.tags.filter((t) => t[0] === 'relay').map((t) => t[1]) : []
  console.log(`${name}: kind0=${meta ? (n?.display_name || n?.name || 'unnamed') : 'none'}  kind10050=${inbox.length ? inbox.join(' ') : 'NONE — the site\'s relays would be used'}`)
  if (!wraps) continue
  const where = inbox.length ? inbox : siteRelays()
  const events = await pool.querySync(where, { kinds: [1059], '#p': [pubkey] }, { maxWait: 8000 }).catch(() => [])
  const seen = new Map()
  for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e)
  const { kept, dropped } = screenWraps([...seen.values()], { minPow: pow.anonymous, verify: verifyEvent })
  console.log(`    ${kept.length} wrap(s) pass ${pow.anonymous} bits; ${dropped.length} dropped`)
  for (const d of dropped) console.log(`    dropped ${d.event?.id?.slice(0, 12) || '?'}: ${d.reason}`)
}
pool.destroy()
process.exit(0)
