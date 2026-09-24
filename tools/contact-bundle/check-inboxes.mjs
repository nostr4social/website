// Read-only: does each recipient in .well-known/nostr.json have a kind 10050
// inbox-relay list (NIP-17) and a kind 0 profile? Without a 10050 the contact
// form falls back to public relays the recipient may never read.
//
//   npm run check:inboxes
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'

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
import { readFileSync } from 'node:fs'
const names = JSON.parse(readFileSync(new URL('../../.well-known/nostr.json', import.meta.url), 'utf8')).names
const relays = ['wss://purplepag.es', 'wss://relay.nostr.band', 'wss://relay.damus.io', 'wss://nos.lol']
const pool = new SimplePool()
for (const [name, pubkey] of Object.entries(names)) {
  const dm = await pool.get(relays, { kinds: [10050], authors: [pubkey] }, { maxWait: 6000 }).catch(() => null)
  const meta = await pool.get(relays, { kinds: [0], authors: [pubkey] }, { maxWait: 6000 }).catch(() => null)
  let n = null; try { n = JSON.parse(meta?.content || '{}'); } catch {}
  console.log(`${name}: kind0=${meta ? (n?.display_name || n?.name || 'unnamed') : 'none'}  kind10050=${dm ? dm.tags.filter(t => t[0] === 'relay').map(t => t[1]).join(' ') : 'NONE — fallback relays would be used'}`)
}
pool.destroy(); process.exit(0)
