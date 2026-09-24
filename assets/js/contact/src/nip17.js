// NIP-17 private direct messages, built by hand.
//
// nostr-tools ships helpers for this, but they take the sender's private key —
// which this page does not have when an extension or a remote signer is doing
// the signing. So the three layers are assembled here:
//
//   kind 14   the rumor. Never signed. Carries the message, the subject, and a
//             `p` tag per participant, so a client can thread the conversation.
//   kind 13   a seal. One per recipient. The rumor, encrypted to that recipient
//             with NIP-44, signed by the sender, with no tags and a randomised
//             timestamp so the seal itself leaks nothing but the sender.
//   kind 1059 a gift wrap. One per recipient. The seal, encrypted again under a
//             throwaway key that exists only for this message, so the relay
//             cannot see who sent it.
//
// The throwaway key is generated here rather than inside a helper because the
// relay may demand AUTH before it accepts the wrap, and the reply to that
// challenge has to be signed with the same throwaway key — signing it with the
// sender's key would undo the wrapping.

import { finalizeEvent, generateSecretKey, getConversationKey, getEventHash, getPublicKey, nip44Encrypt } from './vendor.js'
import { minePow } from './pow.js'

export const KIND_CHAT = 14
export const KIND_SEAL = 13
export const KIND_WRAP = 1059

const TWO_DAYS = 2 * 24 * 60 * 60

const now = () => Math.floor(Date.now() / 1000)

/** Seals and wraps are dated up to two days in the past, per NIP-59. */
function jitteredTimestamp() {
  return now() - Math.floor(Math.random() * TWO_DAYS)
}

/**
 * The message itself. Unsigned by design: a rumor that leaked would not be
 * provably yours.
 */
export function buildRumor({ senderPubkey, recipients, subject, content }) {
  const tags = recipients.map((r) => (r.relay ? ['p', r.pubkey, r.relay] : ['p', r.pubkey]))
  if (subject) tags.push(['subject', subject])

  const rumor = {
    pubkey: senderPubkey,
    created_at: now(),
    kind: KIND_CHAT,
    tags,
    content,
  }
  rumor.id = getEventHash(rumor)
  return rumor
}

/** One sealed copy of the rumor, addressed to one pubkey. */
export async function sealFor(signer, rumor, targetPubkey) {
  const content = await signer.nip44Encrypt(targetPubkey, JSON.stringify(rumor))
  return signer.signEvent({
    kind: KIND_SEAL,
    created_at: jitteredTimestamp(),
    tags: [],
    content,
  })
}

/**
 * Wrap a seal under a key that exists for this one event. Returns the wrap and
 * the key that signed it, which the caller needs for relay AUTH and must then
 * zero-fill.
 *
 * With `pow` set, the wrap carries a NIP-13 nonce mined to that many leading
 * zero bits before it is signed. The relay sees the work; nothing else about
 * the wrap changes.
 */
export async function wrapFor(seal, targetPubkey, relayHint, { pow = 0, onProgress } = {}) {
  const ephemeralKey = generateSecretKey()
  const conversationKey = getConversationKey(ephemeralKey, targetPubkey)
  let template = {
    pubkey: getPublicKey(ephemeralKey),
    kind: KIND_WRAP,
    created_at: jitteredTimestamp(),
    tags: [relayHint ? ['p', targetPubkey, relayHint] : ['p', targetPubkey]],
    content: nip44Encrypt(JSON.stringify(seal), conversationKey),
  }
  if (pow > 0) template = await minePow(template, pow, { onProgress })
  const wrap = finalizeEvent(template, ephemeralKey)
  return { wrap, ephemeralKey }
}

/**
 * Publish one wrap to one recipient's relays.
 *
 * pool.publish returns one promise per relay, so allSettled over that array
 * gives a per-relay verdict. A single relay accepting is a delivered message;
 * we report the rest so the sender can see what happened rather than guess.
 */
export async function publishWrap(pool, relays, wrap, ephemeralKey, { maxWait }) {
  const onauth = async (template) => finalizeEvent(template, ephemeralKey)
  const settled = await Promise.allSettled(pool.publish(relays, wrap, { onauth, maxWait }))

  return relays.map((url, i) => {
    const result = settled[i]
    return result.status === 'fulfilled'
      ? { url, ok: true, reason: result.value || '' }
      : { url, ok: false, reason: String(result.reason?.message || result.reason || 'failed') }
  })
}
