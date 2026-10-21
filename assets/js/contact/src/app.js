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

import { $ } from '../../shared/src/dom.js'
import { config, dev, fmt, query, t } from '../../shared/src/config.js'
import { pickRecipient } from '../../shared/src/recipients.js'
import { createSignIn } from '../../shared/src/signin.js'
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
import { createGuestSigner, detectNip07, SignerError } from '../../shared/src/signers.js'
import {
  receiptText,
  renderProgress,
  renderRecipients,
  renderResult,
  setError,
  setSendMode,
  showReceipt,
  TRAVEL,
  wireCopyButtons,
  wireEmailFallback,
} from './ui.js'

const store = createStore(initialState)
let openedAt = Date.now()
let lastSend = null // what the receipt describes; a retry re-publishes from it

const errorCode = (err) => (err instanceof SignerError ? err.code : err?.code || 'unknown')
const sendMode = () => (store.get().signer ? 'signed' : 'guest')

// Signing as yourself is the shared flow; the page only learns the outcome.
const signIn = createSignIn({
  onChange(signer) {
    store.set({ signer, profileName: null, error: null })
    setSendMode(signer ? 'signed' : 'guest')
  },
})

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

/**
 * `?calc=<query>` arrives from the calculator's "sanity-check this number"
 * door: the inputs as the results link's own query string. They are laid out
 * as lines the reader can edit, with the link that reopens the results.
 */
function prefillCalc() {
  const calc = query.get('calc')
  const field = $('#field-message')
  if (!calc || !field || field.value) return
  const params = new URLSearchParams(calc)
  const lines = [t('compose.calc_intro')]
  for (const [key, value] of params.entries()) {
    if (key === 'v' || key === 'test') continue
    lines.push(fmt(t('compose.calc_line'), { key, value }))
  }
  lines.push('', fmt(t('compose.calc_link'), { link: `${location.origin}${config.calculator_href}?${calc}` }), '')
  field.value = lines.join('\n').slice(0, config.limits.message.max)
}

function chooseRecipient(name) {
  const { recipients } = store.get()
  const recipient = recipients.find((r) => r.name === name) || null
  store.set({ recipient })
}

function wire() {
  $('#contact-form')?.addEventListener('submit', onSubmit)
  $('#field-to')?.addEventListener('change', (e) => chooseRecipient(e.target.value))
  signIn.wire()
  $('#result-retry')?.addEventListener('click', onRetry)
  $('#result-again')?.addEventListener('click', sendAnother)
  $('#result-copy')?.addEventListener('click', copyReceipt)

}

async function boot() {
  if (!$('#contact-form')) return

  wireEmailFallback()
  wireCopyButtons()
  prefillSubject()
  prefillCalc()
  wire()
  setSendMode('guest')
  TRAVEL.rest()

  const hasNip07 = await detectNip07()
  store.set({ hasNip07 })
  signIn.markExtension(hasNip07)

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
