// Three ways to sign, behind one interface.
//
//   { kind, pubkey, signEvent(template), nip44Encrypt(pubkey, plaintext),
//     nip44Decrypt(pubkey, ciphertext), close() }
//
// The page never sees a private key except in guest mode, where it makes one,
// uses it once, and zero-fills it. There is no session persistence anywhere:
// reloading the page signs you out.

import {
  BunkerSigner,
  createNostrConnectURI,
  finalizeEvent,
  generateSecretKey,
  getConversationKey,
  getPublicKey,
  nip44Encrypt as nip44EncryptWithKey,
  nip44Decrypt as nip44DecryptWithKey,
} from './vendor.js'
import { config, dev } from './config.js'

export class SignerError extends Error {
  constructor(code, cause) {
    super(code)
    this.code = code
    this.cause = cause
  }
}

const HEX64 = /^[0-9a-f]{64}$/

function wipe(secretKey) {
  if (secretKey instanceof Uint8Array) secretKey.fill(0)
}

// ── NIP-07: a browser extension ───────────────────────────────────────────────

/** Extensions inject late, so this resolves as soon as one appears. */
export function detectNip07({ timeout = 800 } = {}) {
  if (dev.noNip07) return Promise.resolve(false)
  if (window.nostr) return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = Date.now()
    const poll = () => {
      if (window.nostr) return resolve(true)
      if (Date.now() - started >= timeout) return resolve(false)
      setTimeout(poll, 100)
    }
    setTimeout(poll, 100)
  })
}

export async function connectNip07() {
  if (!window.nostr) throw new SignerError('nip07_missing')

  const nip44 = dev.noNip44 ? null : window.nostr.nip44
  // NIP-04 is deprecated and leaks metadata; a signer without NIP-44 cannot
  // send a private message here, and we say so rather than quietly downgrading.
  if (!nip44 || typeof nip44.encrypt !== 'function') throw new SignerError('nip07_no_nip44')

  let pubkey
  try {
    pubkey = await window.nostr.getPublicKey()
  } catch (err) {
    throw new SignerError('nip07_refused', err)
  }
  if (!HEX64.test(pubkey)) throw new SignerError('nip07_bad_pubkey')

  return {
    kind: 'nip07',
    pubkey,
    signEvent: (template) => window.nostr.signEvent(template),
    nip44Encrypt: (target, plaintext) => nip44.encrypt(target, plaintext),
    nip44Decrypt: (target, ciphertext) => nip44.decrypt(target, ciphertext),
    close() {},
  }
}

// ── NIP-46: a remote signer ───────────────────────────────────────────────────

const PERMS = ['sign_event:13', 'nip44_encrypt']

function bunkerParams(onauth) {
  return { onauth }
}

/**
 * Parse a pasted `bunker://` URI ourselves. nostr-tools' parseBunkerInput also
 * accepts a name@domain NIP-05 identifier, which would mean an HTTP request to
 * a third party from this page. This site makes no third-party requests, so
 * that form is refused with an explanation rather than silently resolved.
 */
export function parseBunkerUri(input) {
  const raw = (input || '').trim()
  if (!raw) throw new SignerError('bunker_empty')
  if (!raw.startsWith('bunker://')) {
    throw new SignerError(raw.includes('@') ? 'bunker_is_nip05' : 'bunker_bad_scheme')
  }
  let url
  try {
    url = new URL(raw)
  } catch (err) {
    throw new SignerError('bunker_unparseable', err)
  }
  const pubkey = url.hostname || url.pathname.replace(/^\/+/, '')
  if (!HEX64.test(pubkey)) throw new SignerError('bunker_bad_pubkey')
  const relays = url.searchParams.getAll('relay').filter(isRelayUrl)
  if (!relays.length) throw new SignerError('bunker_no_relay')
  return { pubkey, relays, secret: url.searchParams.get('secret') }
}

export function isRelayUrl(url) {
  try {
    return new URL(url).protocol === 'wss:'
  } catch {
    return false
  }
}

async function wrapBunker(signer, clientSecretKey) {
  let pubkey
  try {
    pubkey = await signer.getPublicKey()
  } catch (err) {
    wipe(clientSecretKey)
    throw new SignerError('nip46_no_pubkey', err)
  }
  if (!HEX64.test(pubkey)) {
    wipe(clientSecretKey)
    throw new SignerError('nip46_bad_pubkey')
  }
  return {
    kind: 'nip46',
    pubkey,
    signEvent: (template) => signer.signEvent(template),
    nip44Encrypt: (target, plaintext) => signer.nip44Encrypt(target, plaintext),
    nip44Decrypt: (target, ciphertext) => signer.nip44Decrypt(target, ciphertext),
    async close() {
      try {
        await signer.close()
      } finally {
        wipe(clientSecretKey)
      }
    },
  }
}

/** We hand the signer a URI; the signer scans or opens it and connects back. */
export function startNostrConnect({ onauth, signal } = {}) {
  const clientSecretKey = generateSecretKey()
  const clientPubkey = getPublicKey(clientSecretKey)
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const relays = config.relays.nip46

  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret,
    perms: PERMS,
    name: config.client.name,
    url: location.origin,
  })

  const connected = BunkerSigner.fromURI(clientSecretKey, uri, bunkerParams(onauth), signal)
    .then((signer) => wrapBunker(signer, clientSecretKey))
    .catch((err) => {
      wipe(clientSecretKey)
      throw err instanceof SignerError ? err : new SignerError('nip46_connect_failed', err)
    })

  return { uri, connected }
}

/** The signer hands us a URI; we connect to it. */
export async function connectBunker(input, { onauth } = {}) {
  const pointer = parseBunkerUri(input)
  const clientSecretKey = generateSecretKey()
  try {
    const signer = BunkerSigner.fromBunker(clientSecretKey, pointer, bunkerParams(onauth))
    await signer.connect({ name: config.client.name, url: location.origin })
    return await wrapBunker(signer, clientSecretKey)
  } catch (err) {
    wipe(clientSecretKey)
    throw err instanceof SignerError ? err : new SignerError('nip46_connect_failed', err)
  }
}

// ── Guest: a key that exists for one message ─────────────────────────────────

export function createGuestSigner() {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  let open = true

  const assertOpen = () => {
    if (!open) throw new SignerError('guest_closed')
  }

  return {
    kind: 'guest',
    pubkey,
    async signEvent(template) {
      assertOpen()
      return finalizeEvent(template, secretKey)
    },
    async nip44Encrypt(target, plaintext) {
      assertOpen()
      return nip44EncryptWithKey(plaintext, getConversationKey(secretKey, target))
    },
    async nip44Decrypt(target, ciphertext) {
      assertOpen()
      return nip44DecryptWithKey(ciphertext, getConversationKey(secretKey, target))
    },
    close() {
      open = false
      wipe(secretKey)
    },
  }
}

// ── Session: a disposable key that lives as long as the tab ──────────────────

/**
 * A key made once per tab and kept in sessionStorage, so every save from
 * this tab comes from the same author and a reload does not change it.
 * Closing the tab forgets it. It is never wiped on close(), because the
 * next save needs it; `forget()` removes it.
 */
/** Is there a session key in this tab already? (Reading it makes none.) */
export function hasSessionKey(storageKey = 'nostr4.session-key') {
  try {
    return /^[0-9a-f]{64}$/.test(sessionStorage.getItem(storageKey) || '')
  } catch {
    return false
  }
}

export function createSessionSigner(storageKey = 'nostr4.session-key') {
  let secretKey = null
  try {
    const hex = sessionStorage.getItem(storageKey)
    if (hex && /^[0-9a-f]{64}$/.test(hex)) secretKey = hexToBytes(hex)
  } catch {
    /* no storage: a fresh key for this page */
  }
  if (!secretKey) {
    secretKey = generateSecretKey()
    try {
      sessionStorage.setItem(storageKey, bytesToHex(secretKey))
    } catch {
      /* kept in memory only */
    }
  }
  const pubkey = getPublicKey(secretKey)
  return {
    kind: 'session',
    pubkey,
    async signEvent(template) {
      return finalizeEvent(template, secretKey)
    },
    async nip44Encrypt(target, plaintext) {
      return nip44EncryptWithKey(plaintext, getConversationKey(secretKey, target))
    },
    async nip44Decrypt(target, ciphertext) {
      return nip44DecryptWithKey(ciphertext, getConversationKey(secretKey, target))
    },
    close() {},
    forget() {
      try {
        sessionStorage.removeItem(storageKey)
      } catch {
        /* nothing to remove */
      }
      wipe(secretKey)
    },
  }
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
