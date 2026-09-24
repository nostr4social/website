// The state the page is in, and the pipeline that moves it.
//
//   boot → loading_recipients → composing
//        ⇄ connecting_nip07 | connecting_nip46      (optional: sign as yourself)
//        → sending → result → composing
//
// Composing needs no sign-in: a one-time key is made at send time unless the
// visitor signed in first.
//
// Everything the view needs is in one object; the view re-renders on change.

import { SimplePool } from './vendor.js'
import { config, dev, t } from './config.js'
import { loadRecipients } from './recipients.js'
import { inboxRelaysFor } from './relays.js'
import { buildRumor, publishWrap, sealFor, wrapFor } from './nip17.js'

export function createStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch }
      for (const listener of listeners) listener(state)
    },
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const initialState = {
  phase: 'boot',
  hasNip07: false,
  recipients: [],
  recipient: null, // the one this message goes to
  signer: null, // null until someone signs in; a guest key is made per send
  profileName: null, // a signed-in sender's kind 0 name, when one was found
  error: null,
  connect: null, // { uri, authUrl }
  progress: null, // { done, total, label }
  results: null, // [{ name, pubkey, relays: [{url, ok, reason}], usedFallback, wrapId }]
  verdict: null, // success | partial | failure
  sends: [], // timestamps, for the per-tab rate limit
}

export async function bootRecipients(store) {
  store.set({ phase: 'loading_recipients', error: null })
  try {
    const recipients = await loadRecipients()
    store.set({ recipients, phase: 'composing' })
  } catch (err) {
    store.set({ phase: 'unavailable', error: err.code || 'recipients_unavailable' })
  }
}

/** Per-tab throttle. Relays and DM clients are the real control; this is manners. */
export function rateLimited(store) {
  const { window: windowMs, max } = config.limits.rate
  const cutoff = Date.now() - windowMs
  const recent = store.get().sends.filter((t) => t > cutoff)
  store.set({ sends: recent })
  return recent.length >= max
}

export function noteSend(store) {
  store.set({ sends: [...store.get().sends, Date.now()] })
}

/**
 * Compose, encrypt and publish. One sealed, wrapped copy to the chosen
 * recipient, plus one addressed back to the sender when they are signed in, so
 * the conversation appears in their own client too.
 *
 * Returns per-target results; the caller decides what to say about them.
 */
/** How much work a wrap from this signer carries: a one-time key has no history, so it pays. */
export function powFor(signerKind) {
  if (dev.noPow) return 0
  return signerKind === 'guest' ? config.pow?.anonymous || 0 : config.pow?.signed || 0
}

export async function send(store, { signer, recipient, subject, content, onProgress }) {
  const pool = new SimplePool()
  const pow = powFor(signer.kind)

  const targets = [{ ...recipient, self: false }]
  // A guest's key is discarded after sending, so a self-copy would be unreadable.
  if (signer.kind !== 'guest' && recipient.pubkey !== signer.pubkey) {
    targets.push({ name: t('recipients.self_copy', 'you'), pubkey: signer.pubkey, self: true })
  }

  const rumor = buildRumor({
    senderPubkey: signer.pubkey,
    recipients: [{ pubkey: recipient.pubkey }],
    subject,
    content,
  })

  const results = []
  try {
    for (const [index, target] of targets.entries()) {
      onProgress?.({ step: 'resolving', index, total: targets.length, name: target.name })
      const { relays, usedFallback } = await inboxRelaysFor(pool, target.pubkey)

      onProgress?.({ step: 'encrypting', index, total: targets.length, name: target.name })
      const seal = await sealFor(signer, rumor, target.pubkey)
      const { wrap, ephemeralKey } = await wrapFor(seal, target.pubkey, relays[0], {
        pow,
        onProgress: (p) => onProgress?.({ step: 'mining', index, total: targets.length, name: target.name, ...p }),
      })

      onProgress?.({ step: 'publishing', index, total: targets.length, name: target.name })
      let relayResults
      try {
        relayResults = await publishWrap(pool, relays, wrap, ephemeralKey, {
          maxWait: config.timeouts.publish,
        })
      } finally {
        ephemeralKey.fill(0)
      }

      results.push({
        name: target.name,
        pubkey: target.pubkey,
        self: target.self,
        relays: relayResults,
        usedFallback,
        wrapId: wrap.id,
        // Kept so a retry can re-wrap and re-publish without asking the signer
        // to approve anything a second time. The seal is already signed; only
        // the throwaway wrapping key is made again.
        seal,
      })
    }
  } finally {
    pool.destroy()
  }

  return { results, verdict: verdictFor(results) }
}

/** Delivered means at least one relay took it, for every recipient who is not us. */
export function verdictFor(results) {
  const real = results.filter((r) => !r.self)
  const delivered = real.filter((r) => r.relays.some((relay) => relay.ok))
  if (!real.length || delivered.length === real.length) return 'success'
  return delivered.length ? 'partial' : 'failure'
}

/**
 * Re-send to the recipients that no relay accepted. The seal is reused, so the
 * signer is not prompted again; only the throwaway wrapping key is new.
 */
export async function retry(store, previous, { onProgress, pow = 0 } = {}) {
  const pool = new SimplePool()
  const results = previous.map((r) => ({ ...r }))
  try {
    for (const [index, result] of results.entries()) {
      if (result.relays.some((relay) => relay.ok)) continue
      onProgress?.({ step: 'publishing', index, total: results.length, name: result.name })

      const { relays, usedFallback } = await inboxRelaysFor(pool, result.pubkey)
      const { wrap, ephemeralKey } = await wrapFor(result.seal, result.pubkey, relays[0], {
        pow,
        onProgress: (p) => onProgress?.({ step: 'mining', index, total: results.length, name: result.name, ...p }),
      })
      onProgress?.({ step: 'publishing', index, total: results.length, name: result.name })
      try {
        result.relays = await publishWrap(pool, relays, wrap, ephemeralKey, {
          maxWait: config.timeouts.publish,
        })
      } finally {
        ephemeralKey.fill(0)
      }
      result.usedFallback = usedFallback
      result.wrapId = wrap.id
    }
  } finally {
    pool.destroy()
  }
  return { results, verdict: verdictFor(results) }
}
