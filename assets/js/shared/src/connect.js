// The sign-in view, shared by every page that offers "sign as yourself":
// the identity chip, the remote-signer modal, and the two small helpers
// that put an error or a status line on screen.

import { $, clear, el, replace, show } from './dom.js'
import { config, t } from './config.js'
import { qrSvg } from './qr.js'
import { npubEncode } from './vendor.js'

export function setError(node, code) {
  if (!node) return
  const message = code ? t(`errors.${code}`) || t('errors.unknown') : ''
  node.textContent = message
  show(node, Boolean(message))
}

export function setStatus(node, message) {
  if (!node) return
  node.textContent = message || ''
  show(node, Boolean(message))
}

export function shortNpub(hex) {
  try {
    const npub = npubEncode(hex)
    return `${npub.slice(0, 9)}…${npub.slice(-4)}`
  } catch {
    return `${hex.slice(0, 8)}…${hex.slice(-4)}`
  }
}

export function renderIdentity(signer, profileName) {
  const name = $('#identity-name')
  const key = $('#identity-key')
  const note = $('#identity-note')
  if (!signer) return
  if (name) name.textContent = profileName || t('identity.unnamed')
  if (key) key.textContent = shortNpub(signer.pubkey)
  if (note) note.textContent = t(`identity.${signer.kind}`)
}

export function markExtension(available) {
  const button = $('#sign-extension')
  if (button) button.classList.toggle('is-missing', !available)
}

// ── the remote-signer modal ──────────────────────────────────────────────────

export function openBunkerModal() {
  const dialog = $('#bunker-modal')
  if (dialog && !dialog.open) dialog.showModal()
}

export function closeBunkerModal() {
  const dialog = $('#bunker-modal')
  if (dialog?.open) dialog.close()
}

export function renderConnect({ uri }) {
  const qrHost = $('#bunker-qr')
  if (qrHost) replace(qrHost, qrSvg(uri, { label: t('bunker.qr_alt') }))

  const uriField = $('#bunker-uri')
  if (uriField) uriField.value = uri

  const links = $('#bunker-signers')
  if (links) {
    clear(links)
    for (const signer of config.nip46.signers) {
      links.append(
        el('a', {
          class: 'btn btn--secondary btn--compact',
          href: signer.nostrconnect_url.replace('{uri}', encodeURIComponent(uri)),
          target: '_blank',
          rel: 'noopener',
          text: signer.label,
        }),
      )
    }
  }
}

/** A remote signer can ask the user to approve in a browser tab. */
export function renderAuthUrl(url) {
  const host = $('#bunker-auth')
  if (!host) return
  if (!url) return show(host, false)
  replace(
    host,
    el('p', { class: 'contact__note', text: t('bunker.auth_note') }),
    el('a', { class: 'btn btn--primary btn--compact', href: url, target: '_blank', rel: 'noopener', text: t('bunker.auth_open') }),
  )
  show(host, true)
}
