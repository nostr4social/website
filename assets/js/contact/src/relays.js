// Where a message is delivered.
//
// NIP-17 says a recipient publishes a kind 10050 listing the relays they read
// private messages on. We look it up for each recipient and use exactly that
// list. When someone has not published one we fall back to a public set and
// say so on screen, because a message delivered to a relay the recipient does
// not read is a message that was not delivered.

import { config, dev } from './config.js'

const KIND_DM_RELAYS = 10050
const MAX_RELAYS = 5

export function normalizeRelay(url) {
  try {
    const parsed = new URL(String(url).trim())
    if (parsed.protocol !== 'wss:') return null
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function dedupe(urls) {
  return Array.from(new Set(urls.filter(Boolean)))
}

export async function inboxRelaysFor(pool, pubkey) {
  // Localhost only: send everything to the relays named in the query string,
  // so the whole flow can be exercised without touching public infrastructure.
  if (dev.local && dev.relays.length) {
    const relays = dedupe(dev.relays.map(normalizeRelay)).slice(0, MAX_RELAYS)
    if (relays.length) return { relays, usedFallback: false }
  }

  const fallback = () => ({
    relays: dedupe(config.relays.fallback_dm.map(normalizeRelay)).slice(0, MAX_RELAYS),
    usedFallback: true,
  })

  if (dev.no10050) return fallback()

  let event = null
  try {
    event = await pool.get(
      config.relays.discovery,
      { kinds: [KIND_DM_RELAYS], authors: [pubkey] },
      { maxWait: config.timeouts.discovery },
    )
  } catch {
    return fallback()
  }
  if (!event) return fallback()

  const relays = dedupe(
    event.tags.filter((tag) => tag[0] === 'relay').map((tag) => normalizeRelay(tag[1])),
  ).slice(0, MAX_RELAYS)

  return relays.length ? { relays, usedFallback: false } : fallback()
}
