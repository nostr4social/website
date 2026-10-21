// "Sign as yourself", shared by every page that offers it. Wires the two
// sign-in doors (#sign-extension, #sign-bunker), the modal, and sign-out
// (#sign-out); holds the signer; tells the page when it changes.
//
//   const signIn = createSignIn({ onChange(signer) })
//   signIn.wire()
//   signIn.current()   // the signer, or null for a one-time key
//
// There is no session persistence: reloading the page signs you out.

import { $ } from './dom.js'
import { config, t } from './config.js'
import { fetchProfileName } from './profiles.js'
import { SimplePool } from './vendor.js'
import { connectBunker, connectNip07, SignerError, startNostrConnect } from './signers.js'
import {
  closeBunkerModal,
  markExtension,
  openBunkerModal,
  renderAuthUrl,
  renderConnect,
  renderIdentity,
  setError,
  setStatus,
} from './connect.js'

const errorCode = (err) => (err instanceof SignerError ? err.code : err?.code || 'unknown')

export function createSignIn({ onChange } = {}) {
  let signer = null
  let profileName = null
  let connectAbort = null

  function show(mode) {
    const guest = $('#sign-guest')
    const signed = $('#sign-signed')
    if (guest) guest.hidden = mode !== 'guest'
    if (signed) signed.hidden = mode !== 'signed'
  }

  async function adopt(next) {
    signer = next
    profileName = null
    renderIdentity(signer, null)
    show('signed')
    setError($('#sign-error'), null)
    onChange?.(signer)
    // A name is nicer than a key. Best effort, after the chip is already up.
    const pool = new SimplePool()
    try {
      const name = await fetchProfileName(pool, next.pubkey)
      if (signer === next && name) {
        profileName = name
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

    const controller = new AbortController()
    connectAbort = controller
    const { uri, connected } = startNostrConnect({ onauth: renderAuthUrl, signal: controller.signal })
    renderConnect({ uri })

    const timer = setTimeout(() => controller.abort(), config.timeouts.nip46_connect)
    try {
      const next = await connected
      closeBunkerModal()
      await adopt(next)
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
      const next = await connectBunker(input.value, { onauth: renderAuthUrl })
      input.value = ''
      cancelConnect()
      closeBunkerModal()
      await adopt(next)
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
    signer?.close()
    signer = null
    profileName = null
    show('guest')
    onChange?.(null)
  }

  function wire() {
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
    // A signer session should not outlive the page.
    window.addEventListener('pagehide', () => {
      cancelConnect()
      signer?.close()
    })
    show('guest')
  }

  return {
    wire,
    markExtension,
    signOut,
    current: () => signer,
    profileName: () => profileName,
  }
}
