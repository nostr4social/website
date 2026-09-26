// /contact/ — send a private Nostr message from the browser, with no server.
//
// Read top to bottom: this file is the whole flow. It is shipped unminified on
// purpose, because a page that asks you to trust it with a private message
// should be readable by the person deciding whether to.
//
// What leaves your browser: one gift-wrapped event (NIP-59) to the relays the
// recipient publishes for private messages (NIP-17), encrypted in this tab with
// NIP-44 — plus a copy to yourself if you signed in. What never leaves it: your
// key, and the plaintext.
//
// Nobody has to sign in. Unless you do, a key is made when you press send,
// used for that one message, and zero-filled.

import { $ } from './dom.js'
import { config, dev, fmt, query, t } from './config.js'
import { pickRecipient } from './recipients.js'
import { fetchProfileName } from './profiles.js'
import { SimplePool } from './vendor.js'
import {
  bootRecipients,
  createStore,
  initialState,
  noteSend,
  powFor,
  rateLimited,
  retry,
  send,
} from './state.js'
import {
  connectBunker,
  connectNip07,
  createGuestSigner,
  detectNip07,
  SignerError,
  startNostrConnect,
} from './signers.js'
import {
  closeBunkerModal,
  markExtension,
  openBunkerModal,
  receiptText,
  renderAuthUrl,
  renderConnect,
  renderIdentity,
  renderProgress,
  renderRecipients,
  renderResult,
  setError,
  setSendMode,
  setStatus,
  showReceipt,
  TRAVEL,
  wireCopyButtons,
  wireEmailFallback,
} from './ui.js'

const store = createStore(initialState)
let openedAt = Date.now()
let connectAbort = null
let lastSend = null // what the receipt describes; a retry re-publishes from it

const errorCode = (err) => (err instanceof SignerError ? err.code : err?.code || 'unknown')
const sendMode = () => (store.get().signer ? 'signed' : 'guest')

// ── signing as yourself ──────────────────────────────────────────────────────

async function adopt(signer) {
  store.set({ signer, profileName: null, error: null })
  renderIdentity(signer, null)
  setSendMode('signed')
  setError($('#sign-error'), null)
  // A name is nicer than a key. Best effort, after the chip is already up.
  const pool = new SimplePool()
  try {
    const name = await fetchProfileName(pool, signer.pubkey)
    if (store.get().signer === signer && name) {
      store.set({ profileName: name })
      renderIdentity(signer, name)
    }
  } finally {
    pool.destroy()
  }
}

/** The extension puts up its own prompt; this page only waits. */
async function signInExtension() {
  setError($('#sign-error'), null)
  setStatus($('#sign-status'), t('status.connecting_nip07'))
  try {
    await adopt(await connectNip07())
  } catch (err) {
    setError($('#sign-error'), errorCode(err))
  } finally {
    setStatus($('#sign-status'), '')
  }
}

/** The modal: a nostrconnect:// URI as a QR and a link, or a pasted bunker://. */
async function signInBunker() {
  cancelConnect()
  setError($('#sign-error'), null)
  setError($('#bunker-error'), null)
  renderAuthUrl(null)
  openBunkerModal()

  // Held locally as well as globally: cancelling clears the global one, and the
  // rejection that follows must not be reported as a failure the user caused.
  const controller = new AbortController()
  connectAbort = controller

  const { uri, connected } = startNostrConnect({ onauth: renderAuthUrl, signal: controller.signal })
  renderConnect({ uri })

  const timer = setTimeout(() => controller.abort(), config.timeouts.nip46_connect)
  try {
    const signer = await connected
    closeBunkerModal()
    await adopt(signer)
  } catch (err) {
    if (!controller.signal.aborted) setError($('#bunker-error'), errorCode(err))
  } finally {
    clearTimeout(timer)
    if (connectAbort === controller) connectAbort = null
  }
}

async function connectPastedBunker(event) {
  event.preventDefault()
  const input = $('#field-bunker')
  setError($('#bunker-error'), null)
  $('#bunker-status-text').textContent = t('status.connecting_nip46')
  try {
    const signer = await connectBunker(input.value, { onauth: renderAuthUrl })
    input.value = ''
    cancelConnect()
    closeBunkerModal()
    await adopt(signer)
  } catch (err) {
    setError($('#bunker-error'), errorCode(err))
  } finally {
    $('#bunker-status-text').textContent = t('bunker.waiting', '')
  }
}

function cancelConnect() {
  connectAbort?.abort()
  connectAbort = null
  renderAuthUrl(null)
}

function signOut() {
  cancelConnect()
  store.get().signer?.close()
  store.set({ signer: null, profileName: null })
  setSendMode('guest')
}

// ── composing and sending ────────────────────────────────────────────────────

/** Reasons not to send. Returns an error code, or null. */
function validate(form) {
  // An off-screen field no person sees. Anything that fills it is not a person.
  if (form.elements.website.value) return 'honeypot'
  if (Date.now() - openedAt < config.limits.min_seconds * 1000) return 'too_fast'
  if (!store.get().recipient) return 'recipient_missing'

  const message = form.elements.message.value.trim()
  if (message.length < config.limits.message.min) return 'message_short'
  if (message.length > config.limits.message.max) return 'message_long'
  if (form.elements.subject.value.trim().length > config.limits.subject.max) return 'subject_long'
  if (rateLimited(store)) return 'rate_limited'
  return null
}

/**
 * The plaintext, top to bottom: a first line naming the source (it is what an
 * inbox list shows), the subject as a line of its own (most clients ignore the
 * `subject` tag), the message, then how to reply.
 */
function composeContent(form, signer) {
  const subject = form.elements.subject.value.trim()
  const replyTo = signer.kind === 'guest' ? form.elements.replyto.value.trim() : ''
  const lines = [t('compose.header')]
  if (subject) lines.push(fmt(t('compose.subject_line'), { subject }))
  lines.push('', form.elements.message.value.trim(), '')
  if (replyTo) lines.push(fmt(t('compose.footer_reply'), { reply: replyTo }))
  const footer = signer.kind === 'guest' ? t('compose.footer_guest') : t('compose.footer_signed')
  if (footer) lines.push(footer)
  return lines.join('\n').trim()
}

function finish(results, verdict, { signerKind, replyTo }) {
  const { recipient } = store.get()
  lastSend = { results, verdict, recipient, replyTo, signerKind }
  store.set({ results, verdict, phase: 'result' })
  renderResult(lastSend)
  if (verdict === 'failure') TRAVEL.failed()
  else TRAVEL.delivered()
  showReceipt(true)
}

/** What a bot gets: a receipt that looks exactly like a delivered message. */
function pretendSuccess() {
  const { recipient } = store.get()
  const fake = crypto.getRandomValues(new Uint8Array(32))
  const wrapId = Array.from(fake, (b) => b.toString(16).padStart(2, '0')).join('')
  const relays = config.relays.fallback_dm.map((url) => ({ url, ok: true, reason: '' }))
  finish([{ name: recipient?.name, pubkey: recipient?.pubkey, self: false, relays, usedFallback: false, wrapId }], 'success', {
    signerKind: 'guest',
    replyTo: '',
  })
}

async function onSubmit(event) {
  event.preventDefault()
  const form = event.currentTarget
  const problem = validate(form)

  if (problem === 'honeypot') return pretendSuccess()
  if (problem) return setError($('#compose-error'), problem)
  setError($('#compose-error'), null)

  const { recipient } = store.get()
  const signer = store.get().signer || createGuestSigner()
  const replyTo = signer.kind === 'guest' ? form.elements.replyto.value.trim() : ''

  store.set({ phase: 'sending' })
  setSendMode('busy', { signed: signer.kind !== 'guest' })
  renderProgress({ step: 'encrypting' }, signer.kind)

  try {
    const { results, verdict } = await send(store, {
      signer,
      recipient,
      subject: form.elements.subject.value.trim(),
      content: composeContent(form, signer),
      onProgress: (p) => renderProgress(p, signer.kind),
    })
    noteSend(store)
    finish(results, verdict, { signerKind: signer.kind, replyTo })
  } catch (err) {
    store.set({ phase: 'composing' })
    setSendMode(sendMode())
    TRAVEL.rest()
    setError($('#compose-error'), errorCode(err))
  } finally {
    // One message per one-time key. A signed-in signer stays for the next one.
    if (signer.kind === 'guest') signer.close()
  }
}

async function onRetry() {
  if (!lastSend) return
  showReceipt(false)
  setSendMode('busy', { signed: lastSend.signerKind !== 'guest' })
  renderProgress({ step: 'publishing' }, lastSend.signerKind)
  try {
    const { results, verdict } = await retry(store, lastSend.results, {
      pow: powFor(lastSend.signerKind),
      onProgress: (p) => renderProgress(p, lastSend.signerKind),
    })
    finish(results, verdict, lastSend)
  } catch (err) {
    setSendMode(sendMode())
    setError($('#contact-error'), errorCode(err))
    showReceipt(true)
  }
}

function sendAnother() {
  const form = $('#contact-form')
  const to = form.elements.to.value
  form.reset()
  form.elements.to.value = to
  showReceipt(false)
  TRAVEL.rest()
  setSendMode(sendMode())
  openedAt = Date.now()
  store.set({ phase: 'composing', results: null, verdict: null })
  $('#field-message')?.focus()
}

async function copyReceipt() {
  if (!lastSend) return
  try {
    await navigator.clipboard.writeText(receiptText(lastSend))
    const reply = $('#result-reply')
    if (reply) reply.textContent = t('result.copied')
  } catch {
    /* the clipboard is a courtesy; the details are on screen */
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

function prefillSubject() {
  const asked = query.get('subject')
  const field = $('#field-subject')
  if (asked && field) field.value = asked.slice(0, config.limits.subject.max)
}

function chooseRecipient(name) {
  const { recipients } = store.get()
  const recipient = recipients.find((r) => r.name === name) || null
  store.set({ recipient })
}

function wire() {
  $('#contact-form')?.addEventListener('submit', onSubmit)
  $('#field-to')?.addEventListener('change', (e) => chooseRecipient(e.target.value))
  $('#sign-extension')?.addEventListener('click', signInExtension)
  $('#sign-bunker')?.addEventListener('click', signInBunker)
  $('#sign-out')?.addEventListener('click', signOut)
  $('#form-bunker')?.addEventListener('submit', connectPastedBunker)
  $('#bunker-cancel')?.addEventListener('click', closeBunkerModal)
  // Escape, or a click on the backdrop's cancel: either way the attempt ends.
  $('#bunker-modal')?.addEventListener('close', cancelConnect)
  $('#bunker-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#bunker-uri').value)
      $('#bunker-status-text').textContent = t('bunker.copied')
    } catch {
      $('#bunker-uri').select()
    }
  })
  $('#result-retry')?.addEventListener('click', onRetry)
  $('#result-again')?.addEventListener('click', sendAnother)
  $('#result-copy')?.addEventListener('click', copyReceipt)

  // A signer session should not outlive the page.
  window.addEventListener('pagehide', () => {
    cancelConnect()
    store.get().signer?.close()
  })
}

async function boot() {
  if (!$('#contact-form')) return

  wireEmailFallback()
  wireCopyButtons()
  prefillSubject()
  wire()
  setSendMode('guest')
  TRAVEL.rest()

  const hasNip07 = await detectNip07()
  store.set({ hasNip07 })
  markExtension(hasNip07)

  await bootRecipients(store)
  if (store.get().phase === 'unavailable') {
    setError($('#contact-error'), store.get().error)
    $('#contact-form').hidden = true
    $('#panel-unavailable').hidden = false
  } else {
    const { recipients } = store.get()
    const recipient = pickRecipient(recipients, query.get('to'))
    store.set({ recipient })
    renderRecipients(recipients, recipient)
  }

  document.documentElement.dataset.contact = 'ready'
  if (dev.local) console.info('contact: localhost overrides active', dev)
}

boot()
