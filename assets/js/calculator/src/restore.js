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
import { formAddress, formSecretFromList, KIND_MY_FORMS, KIND_RESPONSE, readResponses } from '../../shared/src/forms.js'
import { discoveryRelays, normalizeRelay, siteRelays } from '../../shared/src/relays.js'

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

/**
 * Where a response is looked for: the site's own relays, never the hints in
 * the link. A link's author could name any relay, and the page would open
 * a socket to it; an event that is not on our relays is not ours.
 */
function relaysFor() {
  if (dev.local && dev.relays.length) return [...new Set(dev.relays.map(normalizeRelay).filter(Boolean))]
  return siteRelays()
}

export async function fetchResponse(pointer, snapshot) {
  const pool = new SimplePool()
  try {
    const event = await pool.get(relaysFor(), { ids: [pointer.id], kinds: [KIND_RESPONSE] }, { maxWait: config.timeouts.discovery })
    return event || null
  } finally {
    pool.destroy()
  }
}

/** The holder's route: their My Forms list, decrypted by their signer, names the form's secret. */
export async function secretAsHolder(signer, snapshot) {
  const pool = new SimplePool()
  try {
    const relays = discoveryRelays()
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

/** Whether an event is a response to this form: a kind 1069 carrying the form's `a` tag, with encrypted content. Anything else is not ours. */
export function isOurs(event, snapshot) {
  return Boolean(event && event.kind === KIND_RESPONSE && Array.isArray(event.tags) && event.tags.some((tag) => tag[0] === 'a' && tag[1] === formAddress(snapshot)) && typeof event.content === 'string' && event.content.length > 0)
}

/** The decrypted list, if it is well-formed: a JSON array of response tags. */
function parseList(json) {
  const list = JSON.parse(json)
  if (!Array.isArray(list) || !list.every((tag) => Array.isArray(tag) && typeof tag[0] === 'string')) throw new Error('malformed')
  return list
}

/**
 * The response tags, or an error code: `restore_not_ours` for an event
 * that is not a response to this form (a plaintext event among them),
 * `restore_locked` when this signer cannot open it.
 */
export async function openResponse(event, { signer, snapshot, map }) {
  if (!isOurs(event, snapshot)) return { error: 'restore_not_ours' }
  if (signer) {
    if (signer.pubkey === event.pubkey) {
      try {
        const tags = parseList(await signer.nip44Decrypt(snapshot.pubkey, event.content))
        return { tags, values: readResponses(map, tags), how: 'responder' }
      } catch {
        /* not the responder's key after all */
      }
    }
    const secret = await secretAsHolder(signer, snapshot)
    if (secret) {
      try {
        const tags = parseList(nip44Decrypt(event.content, getConversationKey(hexToBytes(secret), event.pubkey)))
        return { tags, values: readResponses(map, tags), how: 'holder' }
      } catch {
        /* a secret that does not fit */
      }
    }
  }
  return { error: 'restore_locked' }
}
