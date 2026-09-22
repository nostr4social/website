// The view. Every panel and every word already exists in the page, rendered by
// Jekyll from _data/pages/contact.yml — this module shows the right panel and
// fills the parts that are only known at runtime: who you signed in as, which
// relays took the message, and what went wrong.

import { $, clear, el, replace, show } from './dom.js'
import { config, t } from './config.js'
import { qrSvg } from './qr.js'

const PANELS = ['methods', 'nip46', 'compose', 'sending', 'result', 'unavailable']

export function panels() {
  const found = {}
  for (const name of PANELS) found[name] = $(`#panel-${name}`)
  return found
}

export function showPanel(name) {
  for (const panel of PANELS) {
    const node = $(`#panel-${panel}`)
    if (node) show(node, panel === name)
  }
  const heading = $(`#panel-${name} h2`)
  if (heading) heading.setAttribute('tabindex', '-1'), heading.focus({ preventScroll: true })
}

export function setStatus(message, { tone = 'info' } = {}) {
  const node = $('#contact-status')
  if (!node) return
  node.textContent = message || ''
  node.dataset.tone = tone
  show(node, Boolean(message))
}

export function setError(node, code) {
  if (!node) return
  const message = code ? t(`errors.${code}`) || t('errors.unknown') : ''
  node.textContent = message
  show(node, Boolean(message))
}

/** The line that says who you are signing as. */
export function renderIdentity(signer) {
  const node = $('#contact-identity')
  if (!node) return
  if (!signer) return show(node, false)
  const label = t(`methods.${signer.kind}.identity`, signer.kind)
  replace(
    node,
    el('span', { class: 'identity__label', text: label }),
    el('code', { class: 'identity__key code', text: shortKey(signer.pubkey) }),
  )
  show(node, true)
}

export function shortKey(hex) {
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`
}

// ── NIP-46 connect panel ─────────────────────────────────────────────────────

export function renderConnect({ uri }) {
  const qrHost = $('#nip46-qr')
  if (qrHost) replace(qrHost, qrSvg(uri, { label: t('nip46.qr_alt') }))

  const uriField = $('#nip46-uri')
  if (uriField) uriField.value = uri

  const links = $('#nip46-signers')
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
  const host = $('#nip46-auth')
  if (!host) return
  if (!url) return show(host, false)
  replace(
    host,
    el('p', { class: 'note', text: t('nip46.auth_note') }),
    el('a', { class: 'btn btn--primary btn--compact', href: url, target: '_blank', rel: 'noopener', text: t('nip46.auth_open') }),
  )
  show(host, true)
}

// ── sending and result ───────────────────────────────────────────────────────

export function renderProgress({ step, index, total, name }) {
  const node = $('#sending-progress')
  if (!node) return
  const label = t(`sending.${step}`, step)
  node.textContent = `${label} — ${name} (${index + 1}/${total})`
}

export function renderResult({ results, verdict }) {
  const head = $('#result-head')
  if (head) {
    replace(
      head,
      el('h2', { text: t(`result.${verdict}.title`) }),
      el('p', { class: 'lede', text: t(`result.${verdict}.body`) }),
    )
  }

  const list = $('#result-list')
  if (!list) return
  clear(list)

  for (const result of results) {
    const relays = el('ul', { class: 'result__relays' })
    for (const relay of result.relays) {
      relays.append(
        el('li', { class: relay.ok ? 'result__relay is-ok' : 'result__relay is-failed' }, [
          el('span', { class: 'result__relay-url code', text: relay.url }),
          el('span', {
            class: 'result__relay-state',
            text: relay.ok ? t('result.relay_ok') : `${t('result.relay_failed')}: ${relay.reason}`,
          }),
        ]),
      )
    }

    const delivered = result.relays.some((relay) => relay.ok)
    list.append(
      el('li', { class: 'result__item' }, [
        el('div', { class: 'result__who' }, [
          el('span', { class: 'result__name', text: result.self ? t('result.self_copy') : result.name }),
          el('span', {
            class: delivered ? 'badge badge--live' : 'badge badge--soon',
            text: delivered ? t('result.delivered') : t('result.not_delivered'),
          }),
        ]),
        result.usedFallback ? el('p', { class: 'result__warning', text: t('result.fallback_warning') }) : null,
        relays,
        el('p', { class: 'result__id' }, [
          el('span', { text: t('result.event_id') }),
          el('code', { class: 'code', text: result.wrapId }),
        ]),
      ]),
    )
  }
}

// ── the email fallback ───────────────────────────────────────────────────────

/**
 * The address is assembled here rather than written into the HTML, so it is not
 * sitting in the page source for a scraper. <noscript> spells it out for anyone
 * without JavaScript.
 */
export function wireEmailFallback() {
  for (const node of document.querySelectorAll('[data-user][data-domain]')) {
    const address = `${node.dataset.user}@${node.dataset.domain}`
    const subject = node.dataset.subject ? `?subject=${encodeURIComponent(node.dataset.subject)}` : ''
    node.setAttribute('href', `mailto:${address}${subject}`)
    if (node.dataset.fill === 'address') node.textContent = address
  }
}
