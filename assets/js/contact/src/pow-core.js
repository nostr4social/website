// NIP-13 proof of work: repeat a hash until the event id begins with enough
// zero bits. Shared by the page (as a fallback) and the worker (the usual
// path). Nothing here touches a key; the event is unsigned until afterwards.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const enc = new TextEncoder()

export function leadingZeroBits(hash) {
  let count = 0
  for (const byte of hash) {
    if (byte === 0) {
      count += 8
      continue
    }
    count += Math.clz32(byte) - 24
    break
  }
  return count
}

/**
 * Mine `event` in place. The nonce tag is appended (or replaced) and the id is
 * set. `start` and `step` let several workers share one search without
 * overlapping: worker i tries start=i, step=N.
 *
 * The serialization is built once around the nonce, so each try is one
 * string concatenation and one hash rather than a JSON.stringify.
 */
export function mineSync(event, difficulty, { start = 1, step = 1, batch = 20000, onBatch } = {}) {
  const marker = `nonce-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  const tag = ['nonce', marker, String(difficulty)]
  event.tags = event.tags.filter((t) => t[0] !== 'nonce')
  event.tags.push(tag)
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const at = serialized.indexOf(marker)
  const prefix = serialized.slice(0, at)
  const suffix = serialized.slice(at + marker.length)

  let n = start
  let tries = 0
  for (;;) {
    const hash = sha256(enc.encode(prefix + n + suffix))
    if (leadingZeroBits(hash) >= difficulty) {
      tag[1] = String(n)
      event.id = bytesToHex(hash)
      return { event, tries: tries + 1 }
    }
    n += step
    if (++tries % batch === 0 && onBatch && onBatch(tries) === false) return null
  }
}
