// A name for a pubkey: the newest kind 0 the discovery relays hold. Best
// effort — a signed-in sender is shown by npub if nothing comes back. No
// picture is fetched: this page loads images from nowhere but itself.

import { config } from './config.js'

const KIND_PROFILE = 0
const MAX_NAME = 40

export async function fetchProfileName(pool, pubkey) {
  let event = null
  try {
    event = await pool.get(
      config.relays.discovery,
      { kinds: [KIND_PROFILE], authors: [pubkey] },
      { maxWait: config.timeouts.profile },
    )
  } catch {
    return null
  }
  if (!event) return null
  try {
    const meta = JSON.parse(event.content)
    const name = [meta.display_name, meta.name, meta.username].find(
      (v) => typeof v === 'string' && v.trim(),
    )
    return name ? name.trim().slice(0, MAX_NAME) : null
  } catch {
    return null
  }
}
