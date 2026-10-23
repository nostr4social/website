// Opening a saved response: ?nevent=<nevent or id> on the page.
//
// A response (kind 1069) is encrypted with NIP-44 between the responder's
// key and the form's key, so two parties can open it: the responder, with
// the key that saved it (the tab's disposable key, or their own), and the
// form's holder, whose formstr "My Forms" list (kind 14083, encrypted to
// themselves) carries the form's secret. Both paths are tried in that order.

import { config, dev } from '../../shared/src/config.js'
import { SimplePool, decodeNip19, getConversationKey, nip44Decrypt } from '../../shared/src/vendor.js'
import { hexToBytes } from '../../shared/src/signers.js'
import { formSecretFromList, KIND_MY_FORMS, KIND_RESPONSE, readResponses } from '../../shared/src/forms.js'
import { normalizeRelay } from '../../shared/src/relays.js'

const HEX64 = /^[0-9a-f]{64}$/

/** { id, relays, author } from an nevent, a note id, or nothing. */
export function decodePointer(value) {
  const v = (value || '').trim()
  if (!v) return null
  if (HEX64.test(v)) return { id: v, relays: [], author: null }
  try {
    const { type, data } = decodeNip19(v)
    if (type === 'nevent') return { id: data.id, relays: data.relays || [], author: data.author || null }
    if (type === 'note') return { id: data, relays: [], author: null }
  } catch {
    return null
  }
  return null
}

function relaysFor(pointer, snapshot) {
  const list = dev.local && dev.relays.length ? dev.relays : [...(pointer.relays || []), ...(snapshot?.relays || []), ...config.relays.fallback_dm]
  return [...new Set(list.map(normalizeRelay).filter(Boolean))].slice(0, 8)
}

export async function fetchResponse(pointer, snapshot) {
  const pool = new SimplePool()
  try {
    const event = await pool.get(relaysFor(pointer, snapshot), { ids: [pointer.id], kinds: [KIND_RESPONSE] }, { maxWait: config.timeouts.discovery })
    return event || null
  } finally {
    pool.destroy()
  }
}

/** The holder's route: their My Forms list, decrypted by their signer, names the form's secret. */
async function secretAsHolder(signer, snapshot) {
  const pool = new SimplePool()
  try {
    const relays = [...new Set([...config.relays.discovery, ...(snapshot.relays || [])].map(normalizeRelay).filter(Boolean))]
    const list = await pool.get(relays, { kinds: [KIND_MY_FORMS], authors: [signer.pubkey] }, { maxWait: config.timeouts.discovery })
    if (!list) return null
    const json = JSON.parse(await signer.nip44Decrypt(signer.pubkey, list.content))
    return formSecretFromList(json, snapshot)
  } catch {
    return null
  } finally {
    pool.destroy()
  }
}

/**
 * The response tags, or an error code: `restore_locked` when this signer
 * cannot open it. Plaintext responses need no key.
 */
export async function openResponse(event, { signer, snapshot, map }) {
  if (!event.content) return { tags: event.tags, values: readResponses(map, event.tags), how: 'plain' }
  if (signer) {
    if (signer.pubkey === event.pubkey) {
      try {
        const tags = JSON.parse(await signer.nip44Decrypt(snapshot.pubkey, event.content))
        return { tags, values: readResponses(map, tags), how: 'responder' }
      } catch {
        /* not the responder's key after all */
      }
    }
    const secret = await secretAsHolder(signer, snapshot)
    if (secret) {
      try {
        const tags = JSON.parse(nip44Decrypt(event.content, getConversationKey(hexToBytes(secret), event.pubkey)))
        return { tags, values: readResponses(map, tags), how: 'holder' }
      } catch {
        /* a secret that does not fit */
      }
    }
  }
  return { error: 'restore_locked' }
}
