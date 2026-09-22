// /contact/ — send a private Nostr message from the browser, with no server.
//
// Read top to bottom: this file is the whole flow. It is shipped unminified on
// purpose, because a page that asks you to trust it with a private message
// should be readable by the person deciding whether to.
//
// What leaves your browser: gift-wrapped events (NIP-59) to the relays each
// recipient publishes for private messages (NIP-17), encrypted in this tab with
// NIP-44. What never leaves it: your key, and the plaintext.

import { $ } from './dom.js'
import { config, dev, t } from './config.js'
import {
  bootRecipients,
  createStore,
  initialState,
  noteSend,
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
  panels,
  renderAuthUrl,
  renderConnect,
  renderIdentity,
  renderProgress,
  renderResult,
  setError,
  setStatus,
  showPanel,
  wireEmailFallback,
} from './ui.js'

const store = createStore(initialState)
let openedAt = Date.now()
let connectAbort = null

const errorCode = (err) => (err instanceof SignerError ? err.code : err?.code || 'unknown')

function fail(err, { panel } = {}) {
  const code = errorCode(err)
  setError($('#contact-error'), code)
  if (panel) showPanel(panel)
  return code
}

// ── sign-in ──────────────────────────────────────────────────────────────────

function adopt(signer) {
  store.set({ signer, phase: 'composing', error: null })
  renderIdentity(signer)
  showPanel('compose')
  openedAt = Date.now()
  $('#field-message')?.focus()
}

async function signInNip07() {
  setStatus(t('status.connecting_nip07'))
  try {
    adopt(await connectNip07())
  } catch (err) {
    fail(err, { panel: 'methods' })
  } finally {
    setStatus('')
  }
}

function signInGuest() {
  adopt(createGuestSigner())
}

async function signInNostrConnect() {
  cancelConnect()
  showPanel('nip46')
  setError($('#contact-error'), null)
  renderAuthUrl(null)

  // Held locally as well as globally: cancelling clears the global one, and the
  // rejection that follows must not be reported as a failure the user caused.
  const controller = new AbortController()
  connectAbort = controller

  const { uri, connected } = startNostrConnect({
    onauth: renderAuthUrl,
    signal: controller.signal,
  })
  renderConnect({ uri })

  const timer = setTimeout(() => controller.abort(), config.timeouts.nip46_connect)
  try {
    adopt(await connected)
  } catch (err) {
    if (!controller.signal.aborted) fail(err, { panel: 'nip46' })
  } finally {
    clearTimeout(timer)
    if (connectAbort === controller) connectAbort = null
  }
}

async function signInBunker(event) {
  event.preventDefault()
  const input = $('#field-bunker')
  setStatus(t('status.connecting_nip46'))
  try {
    const signer = await connectBunker(input.value, { onauth: renderAuthUrl })
    input.value = ''
    adopt(signer)
  } catch (err) {
    fail(err, { panel: 'nip46' })
  } finally {
    setStatus('')
  }
}

function cancelConnect() {
  connectAbort?.abort()
  connectAbort = null
  renderAuthUrl(null)
  setError($('#contact-error'), null)
}

function signOut() {
  cancelConnect()
  store.get().signer?.close()
  store.set({ signer: null, phase: 'choose_method', results: null, verdict: null })
  renderIdentity(null)
  showPanel('methods')
}

// ── composing and sending ────────────────────────────────────────────────────

/** Reasons not to send. Returns an error code, or null. */
function validate(form) {
  // An off-screen field no person sees. Anything that fills it is not a person.
  if (form.elements.website.value) return 'honeypot'
  if (Date.now() - openedAt < config.limits.min_seconds * 1000) return 'too_fast'

  const message = form.elements.message.value.trim()
  if (message.length < config.limits.message.min) return 'message_short'
  if (message.length > config.limits.message.max) return 'message_long'
  if (form.elements.subject.value.trim().length > config.limits.subject.max) return 'subject_long'
  if (rateLimited(store)) return 'rate_limited'
  return null
}

function composeContent(form) {
  const signer = store.get().signer
  const lines = [form.elements.message.value.trim()]
  const replyTo = form.elements.replyto.value.trim()

  lines.push('')
  if (replyTo) lines.push(`${t('compose.footer_reply')} ${replyTo}`)
  lines.push(signer.kind === 'guest' ? t('compose.footer_guest') : t('compose.footer_signed'))
  return lines.join('\n')
}

async function onSubmit(event) {
  event.preventDefault()
  const form = event.currentTarget
  const problem = validate(form)

  if (problem === 'honeypot') {
    // Say nothing useful. From here it looks exactly like a delivered message.
    store.set({ results: [], verdict: 'success' })
    renderResult({ results: [], verdict: 'success' })
    return showPanel('result')
  }
  if (problem) return setError($('#compose-error'), problem)
  setError($('#compose-error'), null)

  showPanel('sending')
  store.set({ phase: 'sending' })

  try {
    const { results, verdict } = await send(store, {
      subject: form.elements.subject.value.trim(),
      content: composeContent(form),
      onProgress: renderProgress,
    })
    noteSend(store)
    store.set({ results, verdict, phase: 'result' })
    renderResult({ results, verdict })
    showPanel('result')
    form.reset()
  } catch (err) {
    store.set({ phase: 'composing' })
    fail(err, { panel: 'compose' })
    setError($('#compose-error'), errorCode(err))
  }
}

async function onRetry() {
  const previous = store.get().results
  if (!previous) return
  showPanel('sending')
  try {
    const { results, verdict } = await retry(store, previous, { onProgress: renderProgress })
    store.set({ results, verdict })
    renderResult({ results, verdict })
  } catch (err) {
    setError($('#contact-error'), errorCode(err))
  } finally {
    showPanel('result')
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

function prefillSubject() {
  const asked = new URLSearchParams(location.search).get('subject')
  const field = $('#field-subject')
  if (asked && field) field.value = asked.slice(0, config.limits.subject.max)
}

function wire() {
  $('#method-nip07')?.addEventListener('click', signInNip07)
  $('#method-nip46')?.addEventListener('click', signInNostrConnect)
  $('#method-guest')?.addEventListener('click', signInGuest)
  $('#form-bunker')?.addEventListener('submit', signInBunker)
  $('#nip46-cancel')?.addEventListener('click', () => (cancelConnect(), showPanel('methods')))
  $('#nip46-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#nip46-uri').value)
      setStatus(t('nip46.copied'))
    } catch {
      $('#nip46-uri').select()
    }
  })
  $('#contact-form')?.addEventListener('submit', onSubmit)
  $('#result-retry')?.addEventListener('click', onRetry)
  $('#result-again')?.addEventListener('click', () => showPanel('compose'))
  $('#sign-out')?.addEventListener('click', signOut)

  // A signer session should not outlive the page.
  window.addEventListener('pagehide', () => {
    cancelConnect()
    store.get().signer?.close()
  })
}

async function boot() {
  const found = panels()
  if (!found.methods) return

  wireEmailFallback()
  prefillSubject()
  wire()

  document.documentElement.dataset.contact = 'ready'
  showPanel('methods')

  const hasNip07 = await detectNip07()
  store.set({ hasNip07 })
  const button = $('#method-nip07')
  if (button) {
    button.disabled = !hasNip07
    button.setAttribute('aria-disabled', String(!hasNip07))
  }
  const missing = $('#nip07-missing')
  if (missing) missing.hidden = hasNip07

  await bootRecipients(store)
  if (store.get().phase === 'unavailable') {
    setError($('#contact-error'), store.get().error)
    showPanel('unavailable')
  }

  if (dev.local) console.info('contact: localhost overrides active', dev)
}

boot()
