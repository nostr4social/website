// Saving a calculation as a Nostr form response, and telling hello about a
// lead. Both happen after the results are on screen and neither can delay
// them.
//
// The response is a kind 1069 event: the answers as a JSON list of response
// tags, NIP-44 encrypted to the form's pubkey, signed by the one-time key
// (or the visitor's own key if they signed in), carrying a NIP-13 nonce so a
// flood costs something, published to the relays the form names. A relay
// that asks for AUTH gets a challenge signed by the same key.
//
// The DM is the contact form's NIP-17 pipeline with a different plaintext,
// sent only when the visitor left contact details.

import { config, dev, fmt, t } from '../../shared/src/config.js'
import { SimplePool } from '../../shared/src/vendor.js'
import { minePow } from '../../shared/src/pow.js'
import { buildResponses, checkMap, formAddress, KIND_RESPONSE } from '../../shared/src/forms.js'
import { buildRumor, publishWrap, sealFor, wrapFor } from '../../shared/src/nip17.js'
import { inboxRelaysFor, normalizeRelay, siteRelays } from '../../shared/src/relays.js'

const now = () => Math.floor(Date.now() / 1000)

/** The form as the page was built against it, with the id map checked against it once. */
export function prepareForm(snapshot, map) {
  if (!snapshot || !snapshot.pubkey || !snapshot.d || !map?.fields) return null
  const missing = checkMap(snapshot, map)
  if (missing.length) {
    console.warn('calculator form: the id map does not fit the snapshot', missing)
    return null
  }
  return { snapshot, mapping: map }
}

/**
 * Relays a response goes to: the site's own list, unless localhost
 * overrides them. Not the form's relay hints: those are the builder's
 * guess, and the readers look only at the site's list.
 */
export function responseRelays() {
  if (dev.local && dev.relays.length) return dev.relays.map(normalizeRelay).filter(Boolean)
  return siteRelays()
}

/**
 * Build, encrypt, mine, sign and publish one response.
 * values: { key: value } keyed like the id map. Returns the per-relay verdict.
 */
export async function submitResponse(form, { signer, values, pow = 0, onProgress }) {
  const responses = buildResponses(form.mapping, values)
  // Consent to email travels inside the encrypted list, as its own tag: the
  // consent text's version and the time it was given, so there is a trail.
  if (values.consent) responses.push(['consent', String(values.consent), new Date().toISOString()])
  const content = await signer.nip44Encrypt(form.snapshot.pubkey, JSON.stringify(responses))
  let template = {
    pubkey: signer.pubkey,
    kind: KIND_RESPONSE,
    created_at: now(),
    tags: [['a', formAddress(form.snapshot)]],
    content,
  }
  if (pow > 0) template = await minePow(template, pow, { onProgress })
  const event = await signer.signEvent(template)

  const relays = responseRelays()
  const pool = new SimplePool()
  try {
    const onauth = (challenge) => signer.signEvent(challenge)
    const settled = await Promise.allSettled(pool.publish(relays, event, { onauth, maxWait: config.timeouts.publish }))
    const results = relays.map((url, i) =>
      settled[i].status === 'fulfilled'
        ? { url, ok: true, reason: settled[i].value || '' }
        : { url, ok: false, reason: String(settled[i].reason?.message || settled[i].reason || 'failed') },
    )
    return { event, relays: results, ok: results.filter((r) => r.ok).length }
  } finally {
    pool.destroy()
  }
}

/** The plaintext hello reads: the source line, the inputs, the date, the headline, the breach line, the link, the contact. Every figure rounded as the page rounds it. */
export function composeLead({ inputs, result, link, contact, fieldLabels, open }) {
  const lines = [t('compose.header'), '']
  for (const [key, v] of Object.entries(inputs)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue
    lines.push(`${fieldLabels[key]?.label || key}: ${Array.isArray(v) ? v.join(', ') : v}`)
  }
  lines.push('')
  if (result.date) lines.push(fmt(t('compose.date'), { date: result.date }))
  lines.push(fmt(t('compose.results'), { custodial: result.custodial, noncustodial: result.noncustodial }))
  if (result.estimated) lines.push(fmt(t('compose.estimated'), { amount: result.estimated, low: result.low, high: result.high }))
  if (result.fees) lines.push(fmt(t('compose.fees'), { amount: result.fees }))
  if (result.breach) lines.push(fmt(t('compose.breach'), { amount: result.breach }))
  lines.push(fmt(t('compose.link'), { link }))
  if (open) lines.push(fmt(t('compose.open'), { link: open }))
  lines.push('')
  for (const key of ['app_name', 'company', 'contact_name', 'email']) if (contact[key]) lines.push(`${fieldLabels[key]?.label || key}: ${contact[key]}`)
  return lines.join('\n').trim()
}

/** The lead's subject: marked [TEST] while the calculator is in test mode, or the response is flagged test. */
export function leadSubject({ mode, test }) {
  return `${mode === 'test' || test ? t('compose.subject_test') : ''}${t('compose.subject')}`
}

/** One NIP-17 message to one recipient, as the contact form sends it. */
export async function sendLead({ signer, recipient, subject, content, pow = 0, onProgress }) {
  const pool = new SimplePool()
  try {
    const rumor = buildRumor({ senderPubkey: signer.pubkey, recipients: [{ pubkey: recipient.pubkey }], subject, content })
    const { relays, usedFallback } = await inboxRelaysFor(pool, recipient.pubkey)
    const seal = await sealFor(signer, rumor, recipient.pubkey)
    const { wrap, ephemeralKey } = await wrapFor(seal, recipient.pubkey, relays[0], { pow, onProgress })
    try {
      const results = await publishWrap(pool, relays, wrap, ephemeralKey, { maxWait: config.timeouts.publish })
      return { relays: results, usedFallback, ok: results.filter((r) => r.ok).length }
    } finally {
      ephemeralKey.fill(0)
    }
  } finally {
    pool.destroy()
  }
}
