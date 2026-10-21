// Who a message can go to: every name in this site's own /.well-known/nostr.json,
// in the order the file lists them. Same origin, no third party, no hardcoded
// keys in the script — change the file and the form follows.
//
// One message goes to one of them. `?to=<name>` preselects; the dropdown can
// change it.

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

export function toPubkey(value) {
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
  // On localhost only, `?to=<npub|hex>` sends to a throwaway test key instead
  // of anyone real. A `?to=` that is a name is handled by pickRecipient.
  if (dev.local && dev.to && (dev.to.startsWith('npub1') || HEX64.test(dev.to))) {
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

/** The recipient a `?to=<name>` asks for, or the first in the file. */
export function pickRecipient(recipients, wanted) {
  const name = (wanted || '').trim().toLowerCase()
  return recipients.find((r) => r.name.toLowerCase() === name) || recipients[0]
}
