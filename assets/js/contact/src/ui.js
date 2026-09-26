// The view. Every panel and every word already exists in the page, rendered by
// Jekyll from _data/pages/contact.yml — this module shows the right state and
// fills the parts that are only known at runtime: who the message goes to, who
// is signing it, how far the send has got, which relays took it, and what went
// wrong.

import { $, $$, clear, el, replace, show } from './dom.js'
import { config, fmt, t } from './config.js'
import { qrSvg } from './qr.js'
import { npubEncode } from './vendor.js'

// ── small helpers ────────────────────────────────────────────────────────────

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

/** The display name for a nostr.json entry: a label from the data, else the name. */
export function labelFor(recipient) {
  return t(`recipients.labels.${recipient.name}`) || recipient.name
}

export function nip05For(recipient) {
  return `${recipient.name}@${config.client.name}`
}

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ── the recipient ────────────────────────────────────────────────────────────

export function renderRecipients(recipients, selected) {
  const select = $('#field-to')
  if (!select) return
  clear(select)
  for (const r of recipients) {
    select.append(
      el('option', {
        value: r.name,
        selected: r.name === selected?.name,
        text: `${labelFor(r)} · ${nip05For(r)}`,
      }),
    )
  }
}

// ── the send row: guest | signed | busy ──────────────────────────────────────

export function setSendMode(mode, { signed = mode === 'signed' } = {}) {
  show($('#send-guest'), mode === 'guest')
  show($('#send-signed'), mode === 'signed')
  show($('#send-busy'), mode === 'busy')
  // A signed-in sender gets the reply in their own client; the field is noise.
  show($('#field-reply'), !signed)
  const fields = $('#composer-fields')
  if (fields) fields.classList.toggle('is-locked', mode === 'busy')
  for (const input of $$('#composer-fields input, #composer-fields select, #composer-fields textarea')) {
    input.disabled = mode === 'busy'
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

// ── the travel chain ─────────────────────────────────────────────────────────

/**
 * states: one of rest | active | done | failed per node, in order. The note
 * under each node is swapped from the data attributes Jekyll wrote.
 */
export function setTravel(states, { busy = false, done = false } = {}) {
  const travel = $('#travel')
  if (!travel) return
  travel.classList.toggle('travel--busy', busy)
  travel.classList.toggle('travel--done', done)
  const nodes = $$('.travel__node', travel)
  nodes.forEach((node, i) => {
    // 'active:mining' is the active state with the note for a sub-step.
    const [state, noteKey] = (states[i] || 'rest').split(':')
    node.dataset.state = state
    const note = $('.travel__note', node)
    if (note) note.textContent = note.dataset[noteKey || state] || note.dataset[state] || note.dataset.rest || ''
  })
  // How far up the spine the purple reaches: to the last filled dot.
  const lastDone = states.lastIndexOf('done')
  const lit = lastDone < 0 ? 0 : Math.round(((lastDone + 0.5) / nodes.length) * 100)
  travel.style.setProperty('--lit', `${lit}%`)
}

export const TRAVEL = {
  rest: () => setTravel(['rest', 'rest', 'rest']),
  sealing: () => setTravel(['active', 'rest', 'rest'], { busy: true }),
  mining: () => setTravel(['active:mining', 'rest', 'rest'], { busy: true }),
  publishing: () => setTravel(['done', 'active', 'rest'], { busy: true }),
  delivered: () => setTravel(['done', 'done', 'done'], { done: true }),
  failed: () => setTravel(['done', 'failed', 'rest'], { busy: true }),
}

// ── progress ─────────────────────────────────────────────────────────────────

export function renderProgress({ step, tries, elapsed }, signerKind) {
  const label = $('#progress-label')
  const detail = $('#progress-detail')
  const note = $('#progress-note')
  if (label) label.textContent = t(`sending.${step}`, step)
  if (detail) {
    detail.textContent =
      step === 'mining' && tries
        ? fmt(t('sending.mining_detail'), { hashes: compact(tries), seconds: Math.round((elapsed || 0) / 1000) })
        : ''
  }
  if (note) note.textContent = signerKind === 'guest' ? t('sending.note_guest') : t('sending.note_signed')
  if (step === 'publishing') TRAVEL.publishing()
  else if (step === 'mining') TRAVEL.mining()
  else TRAVEL.sealing()
}

function compact(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`
  return String(n)
}

// ── the receipt ──────────────────────────────────────────────────────────────

export function showReceipt(visible) {
  const form = $('#contact-form')
  if (form) form.classList.toggle('composer--result', visible)
  show($('#panel-result'), visible)
  if (visible) $('#result-title')?.focus({ preventScroll: true })
}

/**
 * results: [{ name, pubkey, self, relays: [{url, ok, reason}], usedFallback, wrapId }]
 * The first non-self result is the recipient; a self copy, if any, is listed
 * under it.
 */
export function renderResult({ results, verdict, recipient, replyTo, signerKind }) {
  const panel = $('#panel-result')
  if (!panel) return
  panel.classList.remove('receipt--success', 'receipt--partial', 'receipt--failure')
  panel.classList.add(`receipt--${verdict}`)

  const main = results.find((r) => !r.self) || results[0]
  const okCount = main ? main.relays.filter((r) => r.ok).length : 0
  const total = main ? main.relays.length : 0
  const name = recipient ? labelFor(recipient) : main?.name || ''
  const vars = { name, ok: okCount, total }

  const title = $('#result-title')
  const body = $('#result-body')
  if (title) title.textContent = t(`result.${verdict}.title`) || t(`result.${verdict === 'partial' ? 'success' : verdict}.title`)
  if (body) {
    const key = verdict === 'failure' ? 'failure' : 'success'
    replace(body, ...boldName(fmt(t(`result.${key}.body`), vars), name))
  }

  // Who it went to.
  const who = $('#result-who')
  if (who) {
    clear(who)
    for (const result of results) {
      const delivered = result.relays.some((relay) => relay.ok)
      const ok = result.relays.filter((relay) => relay.ok).length
      who.append(
        el('li', { class: result.self ? 'who who--self' : 'who' }, [
          el('span', { class: 'who__avatar' }, [faceIcon()]),
          el('span', { class: 'who__name', text: result.self ? t('recipients.self_copy') : name }),
          result.self || !recipient
            ? null
            : el('span', { class: 'who__nip05 code', text: nip05For(recipient) }),
          el('span', {
            class: delivered ? 'badge badge--live' : 'badge badge--soon',
            text: delivered ? t('result.delivered') : t('result.not_delivered'),
          }),
          el('span', {
            class: 'who__meta',
            text: fmt(t('result.relays_count'), { ok, total: result.relays.length }),
          }),
        ]),
      )
    }
  }

  const warning = $('#result-warning')
  if (warning) {
    const fell = results.some((r) => !r.self && r.usedFallback)
    warning.textContent = fell ? t('result.fallback_warning') : ''
    show(warning, fell)
  }

  // Details: every relay, then the wrapper id.
  const relays = $('#result-relays')
  if (relays) {
    clear(relays)
    for (const result of results) {
      for (const relay of result.relays) {
        relays.append(
          el('li', { class: relay.ok ? 'relay is-ok' : 'relay is-failed' }, [
            el('span', { class: 'relay__url', text: relay.url.replace(/^wss:\/\//, '') }),
            el('span', {
              class: 'relay__state',
              text: relay.ok ? t('result.relay_ok') : fmt(t('result.relay_failed'), { reason: relay.reason }),
            }),
          ]),
        )
      }
    }
  }
  const id = $('#result-id')
  if (id && main) {
    replace(
      id,
      el('span', { text: t('result.event_id') }),
      el('span', { class: 'code', text: main.wrapId || '' }),
      el('span', {
        class: 'receipt__meta',
        text: fmt(t('result.sent_at'), {
          time: timeNow(),
          key: signerKind === 'guest' ? t('result.key_guest') : t('result.key_signed'),
        }),
      }),
    )
  }

  const reply = $('#result-reply')
  if (reply) {
    if (signerKind !== 'guest') reply.textContent = t('result.reply_self')
    else if (replyTo) reply.textContent = fmt(t('result.reply_to'), { reply: replyTo })
    else reply.textContent = verdict === 'failure' ? '' : t('result.reply_none')
  }

  show($('#result-retry'), verdict !== 'success')
}

/** Plain text for the clipboard: what went where, and the id to look it up by. */
export function receiptText({ results, recipient }) {
  const main = results.find((r) => !r.self) || results[0]
  if (!main) return ''
  return fmt(t('result.receipt'), {
    name: recipient ? labelFor(recipient) : main.name,
    nip05: recipient ? nip05For(recipient) : '',
    time: new Date().toISOString(),
    relays: main.relays.map((r) => `${r.url} ${r.ok ? 'accepted' : 'refused'}`).join(', '),
    id: main.wrapId,
  })
}

function boldName(text, name) {
  if (!name) return [text]
  const at = text.indexOf(name)
  if (at < 0) return [text]
  return [text.slice(0, at), el('b', { text: name }), text.slice(at + name.length)]
}

function faceIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon')
  // The same glyph the template uses for the identity avatar.
  const tpl = $('.identity__glyph path')
  if (tpl) svg.append(tpl.cloneNode(true))
  return svg
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

// ── the email door ───────────────────────────────────────────────────────────

/**
 * The address is assembled here rather than written into the HTML as a
 * mailto:, so it is not sitting in the page source for a scraper.
 */
export function wireEmailFallback() {
  for (const node of document.querySelectorAll('[data-user][data-domain]')) {
    const address = `${node.dataset.user}@${node.dataset.domain}`
    const subject = node.dataset.subject ? `?subject=${encodeURIComponent(node.dataset.subject)}` : ''
    node.setAttribute('href', `mailto:${address}${subject}`)
    node.textContent = address
  }
}

/** `head…tail` of a long string, for keys that only need to be recognised. */
function middle(s, head, tail) {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

/**
 * Turns every `[data-copy]` line into a click-to-copy button. Without the
 * script the line is plain text; with it the same node is replaced by a
 * button carrying the same children, so nothing is written twice. The status
 * word comes from the data attributes the template set from the copy.
 */
export function wireCopyButtons() {
  for (const node of document.querySelectorAll('[data-copy]')) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = node.className + ' copyable'
    button.setAttribute('aria-label', node.dataset.copyLabel || '')
    button.title = node.dataset.copyLabel || ''
    while (node.firstChild) button.appendChild(node.firstChild)
    // A long key shows its two ends on one line; the whole of it is what gets copied.
    const text = button.querySelector('.ruled-item__code-text')
    if (text && node.dataset.copy.length > 40) text.textContent = middle(node.dataset.copy, 15, 9)
    const status = document.createElement('span')
    status.className = 'copyable__status'
    status.setAttribute('role', 'status')
    node.replaceWith(button, status)
    let timer = null
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(node.dataset.copy)
      } catch {
        return /* the text is on screen and selectable */
      }
      button.classList.add('is-copied')
      status.textContent = node.dataset.copyDone || ''
      clearTimeout(timer)
      timer = setTimeout(() => {
        button.classList.remove('is-copied')
        status.textContent = ''
      }, 1800)
    })
  }
}
