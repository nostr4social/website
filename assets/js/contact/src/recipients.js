// Who a message goes to: every name in this site's own /.well-known/nostr.json.
// Same origin, no third party, no hardcoded keys in the script — change the
// file and the form follows.

import { decodeNip19 } from './vendor.js'
import { dev } from './config.js'

const HEX64 = /^[0-9a-f]{64}$/

export class RecipientError extends Error {
  constructor(code, cause) {
    super(code)
    this.code = code
    this.cause = cause
  }
}

function toPubkey(value) {
  if (HEX64.test(value)) return value
  if (typeof value === 'string' && value.startsWith('npub1')) {
    try {
      const { type, data } = decodeNip19(value)
      if (type === 'npub' && HEX64.test(data)) return data
    } catch {
      return null
    }
  }
  return null
}

export async function loadRecipients() {
  // On localhost only, `?to=<npub|hex>` sends to a throwaway test key instead.
  if (dev.local && dev.to) {
    const pubkey = toPubkey(dev.to.trim())
    if (!pubkey) throw new RecipientError('recipients_bad_override')
    return [{ name: 'test', pubkey }]
  }

  let json
  try {
    const res = await fetch('/.well-known/nostr.json', { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    json = await res.json()
  } catch (err) {
    throw new RecipientError('recipients_unavailable', err)
  }

  const names = json && typeof json.names === 'object' ? json.names : null
  if (!names) throw new RecipientError('recipients_malformed')

  const recipients = []
  for (const [name, value] of Object.entries(names)) {
    const pubkey = toPubkey(String(value).trim())
    if (pubkey) recipients.push({ name, pubkey })
  }
  if (!recipients.length) throw new RecipientError('recipients_empty')
  return recipients
}
