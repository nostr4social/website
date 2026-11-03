// Open every relay in the site's list, time the handshake and the first
// reply, and fail on any that does not answer. Run before trimming the
// list, and in the report.
//
//   npm run check:relays                       # the list in _data/blocks/nostr_config.yml
//   npm run check:relays -- wss://x wss://y    # those too, reported but not required
//
// A raw socket, not the pool: a relay that refuses the connection makes
// Node's WebSocket re-fire onerror from close(), which the pool turns into
// a recursion. Here close() is guarded and each relay gets one REQ.

import { discoveryRelays, siteRelays } from '../lib/config.mjs'

const TIMEOUT = 8000
const extra = process.argv.slice(2).filter((a) => /^wss?:\/\//.test(a))
const required = new Set(siteRelays())
const relays = [...new Set([...required, ...discoveryRelays(), ...extra])]

function probe(url) {
  return new Promise((resolve) => {
    const started = Date.now()
    let opened = null
    let settled = false
    let ws = null
    const finish = (ok, why) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (ws && ws.readyState < WebSocket.CLOSING) ws.close()
      } catch { /* closing is best effort */ }
      resolve({ url, ok, why, open: opened == null ? null : opened - started, reply: Date.now() - started })
    }
    const timer = setTimeout(() => finish(false, 'no reply in 8 s'), TIMEOUT)
    try {
      ws = new WebSocket(url)
    } catch (err) {
      return finish(false, err.message)
    }
    ws.onopen = () => {
      opened = Date.now()
      ws.send(JSON.stringify(['REQ', 'check', { kinds: [1069], limit: 1 }]))
    }
    ws.onmessage = (m) => {
      let msg
      try {
        msg = JSON.parse(m.data)
      } catch {
        return
      }
      if (msg[0] === 'EVENT' || msg[0] === 'EOSE') finish(true, msg[0] === 'EVENT' ? 'answered with an event' : 'answered (eose)')
      else if (msg[0] === 'CLOSED' || msg[0] === 'NOTICE') finish(false, `${msg[0].toLowerCase()}: ${msg[2] || msg[1] || ''}`)
    }
    ws.onerror = (e) => finish(false, e?.message || 'connection error')
    ws.onclose = () => finish(false, 'closed before answering')
  })
}

const results = await Promise.all(relays.map(probe))
let failed = 0
for (const r of results) {
  const need = required.has(r.url)
  if (!r.ok && need) failed++
  const ms = r.open == null ? '   -   ' : `${String(r.open).padStart(4)} ms`
  console.log(`${r.ok ? 'ok  ' : need ? 'FAIL' : 'down'} ${r.url.padEnd(34)} open ${ms}  reply ${String(r.reply).padStart(4)} ms  ${r.why}${need ? '' : '  (not in the site list)'}`)
}
console.log(failed ? `\n${failed} of the site's ${required.size} relays did not answer` : `\nall ${required.size} relays in the site list answered`)
process.exit(failed ? 1 : 0)
