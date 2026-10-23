// /calculator/ — the Cost of Custody Calculator.
//
// Read top to bottom: this file is the whole flow. Inputs come from the form
// or from a results link; the model (model.js) turns them into six lines in
// three scenarios; ui.js puts the numbers into the page. Nothing here is a
// literal the visitor reads: the words are in the page's JSON blocks and in
// the published form's own text.
//
// Estimated Cost is the page's front and recomputes quietly whenever it is
// opened after a change. Nothing on the tabs publishes. Save & Share opens a
// modal; Save to Nostr is the one act that publishes (submit.js), signed by
// the visitor's own key or by a disposable key that lives only in this tab,
// and it tells hello by encrypted message. Share Template copies the results
// link and is for visitors signed in with their own key.

import { $, $$ } from '../../shared/src/dom.js'
import { config, dev, fmt, readJson, t } from '../../shared/src/config.js'
import { createSessionSigner, detectNip07, hasSessionKey } from '../../shared/src/signers.js'
import { neventEncode } from '../../shared/src/vendor.js'
import { createSignIn } from '../../shared/src/signin.js'
import { loadRecipients, pickRecipient } from '../../shared/src/recipients.js'
import { calculate, cleanOverrides, normalizeInputs } from './model.js'
import { wireCharts } from './chart.js'
import { decode, encode } from './codec.js'
import { GRIDS, InputError } from './inputs.js'
import { CONTACT_KEYS, markInvalid, readContact, readInputs, wireSliders, writeContact, writeDefaults, writeInputs } from './form.js'
import { decodePointer, fetchResponse, openResponse } from './restore.js'
import { compact } from './format.js'
import { composeLead, prepareForm, sendLead, submitResponse } from './submit.js'
import {
  activateTab,
  markChanged,
  readOverrides,
  renderResults,
  setError,
  setStatus,
  showResults,
  wireTabs,
  wireToggles,
  writeOverrides,
} from './ui.js'

const assumptions = readJson('page-assumptions')
const snapshot = readJson('page-form')
const map = readJson('page-map')
const form = prepareForm(snapshot, map)

let current = null // the last result shown
let dirty = false // the form or an assumption changed since the last calculation
let test = null // the hidden test marker, from the URL only
let openedAt = Date.now()
let sends = [] // timestamps, for the per-tab rate limit
let lastLead = '' // what hello was last told, so an unchanged lead is not sent twice
let signIn = null
let session = null // the disposable signer, made on first use
let pendingSave = false // Save pressed; waiting for a signer to be chosen
let pendingOpen = null // a response to open once a signer is chosen
let syncTimer = null

/** A question's words, from the form itself, for an error that names it. */
function labelFor(key) {
  const node = document.querySelector(`#field-${key} .field__label, label[for="f-${key}"]`)
  return node ? node.textContent.replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim() : key
}

// ── calculating ──────────────────────────────────────────────────────────────

function run(raw, overrides, { focus = true } = {}) {
  let result
  try {
    result = calculate(raw, assumptions, overrides)
  } catch (err) {
    if (err instanceof InputError) {
      activateTab('app')
      markInvalid($('#calc-form'), err.key)
      setError(err.code, labelFor(err.key))
      return null
    }
    setError('unknown')
    throw err
  }
  markInvalid($('#calc-form'), null)
  setError(null)
  current = result
  dirty = false
  renderResults(result, { own: !sameAsDefaults(result.inputs) })

  const query = encode(result.inputs, result.overrides, result.version)
  result.link = `${location.origin}${location.pathname}?${query}`
  history.replaceState(null, '', `?${query}${test ? `&test=${encodeURIComponent(test)}` : ''}`)

  const contact = $('#r-contact')
  if (contact) contact.href = `${config.contact_href}?${new URLSearchParams({ subject: t('contact_subject'), calc: query })}`

  showResults(true, { focus })
  return result
}

let starting = '' // the form's starting answers, clean: the illustrative app

/** Whether these inputs are the illustrative app's, so the page says so. */
function sameAsDefaults(inputs) {
  return JSON.stringify(inputs) === starting
}

/** The form's current answers, calculated, whether or not anything changed. */
function fresh() {
  return dirty || !current ? run(readInputs($('#calc-form')), readOverrides(), { focus: false }) : current
}

function onCalculate(event) {
  event.preventDefault()
  run(readInputs(event.currentTarget), readOverrides())
}

/** Recalculate: the form's answers with the edited assumptions. */
function onRecalculate() {
  markChanged()
  run(readInputs($('#calc-form')), readOverrides(), { focus: true })
}

/** Opening Estimated Cost after a change recomputes, quietly. */
function onTab(name, opts) {
  if (name === 'cost' && dirty) run(readInputs($('#calc-form')), readOverrides(), { focus: false })
  activateTab(name, opts)
}

function onDirty() {
  dirty = true
  syncUrl()
}

/** The query for the form as it stands now, or null while an answer is incomplete. */
function currentQuery() {
  try {
    const inputs = normalizeInputs(readInputs($('#calc-form')))
    return encode(inputs, cleanOverrides(assumptions, readOverrides()), assumptions.version) + (test ? `&test=${encodeURIComponent(test)}` : '')
  } catch {
    return null
  }
}

/** The address bar follows the form: every change rewrites the query. */
function syncUrl() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    const query = currentQuery()
    if (query) history.replaceState(null, '', `?${query}`)
  }, 120)
}

// ── Save & Share ─────────────────────────────────────────────────────────────

const modal = () => $('#save-modal')

/** The questions in the modal the form marks required, by key. */
function requiredKeys() {
  return CONTACT_KEYS.filter((key) => snapshot?.fields?.some((f) => f.id === map.fields[key]?.id && f.required))
}

/**
 * Reasons the modal's buttons stay off: a required answer missing, or an
 * email given without consent to use it.
 */
function missing(formEl) {
  const out = []
  for (const key of requiredKeys()) if (!formEl.elements[key]?.value.trim()) out.push(key)
  if (formEl.elements.email?.value.trim() && !formEl.elements.consent?.checked) out.push('consent')
  return out
}

function gate() {
  const formEl = $('#calc-form')
  if (!formEl || !modal()) return
  const lacking = missing(formEl)
  const own = Boolean(signIn?.current())
  const save = $('#save-submit')
  if (save) save.disabled = lacking.length > 0
  const needed = $('#save-needed')
  if (needed) {
    needed.textContent = lacking.length
      ? fmt(t('modal.needed'), { list: lacking.map((k) => (k === 'consent' ? t('modal.consent_name') : labelFor(k))).join(', ') })
      : ''
  }
  const signedNote = $('#identity-note')
  if (signedNote && own) signedNote.textContent = t('modal.signed')
}

const signDialog = () => $('#sign-modal')

function openSign() {
  const dialog = signDialog()
  if (dialog && !dialog.open) dialog.showModal()
}

function closeSign() {
  const dialog = signDialog()
  if (dialog?.open) dialog.close()
}

function openSave() {
  const dialog = modal()
  if (!dialog) return
  setStatus('')
  $('#save-status').textContent = ''
  gate()
  if (!dialog.open) dialog.showModal()
}

function closeSave() {
  const dialog = modal()
  if (dialog?.open) dialog.close()
}

/** Reasons not to save. */
function withhold(formEl) {
  if (formEl.elements.website.value) return 'honeypot'
  if (Date.now() - openedAt < config.limits.min_seconds * 1000) return 'too_fast'
  const cutoff = Date.now() - config.limits.rate.window
  sends = sends.filter((at) => at > cutoff)
  if (sends.length >= config.limits.rate.max) return 'rate_limited'
  return null
}

function valuesFor(result, contact) {
  const T = result.typical.totals
  const i = result.inputs
  const grid = (name, prefix) => {
    const cells = {}
    for (const key of GRIDS[name]) if (i[key] != null) cells[key.slice(prefix.length)] = i[key]
    return cells
  }
  return {
    mau: i.mau,
    posts_per_user: i.posts_per_user,
    mb: i.mb,
    engineering: grid('engineering', 'eng_'),
    moderation: grid('moderation', 'mod_'),
    legal_usd: i.legal_usd ?? '',
    rails: i.rails,
    rev: i.rev,
    balances: i.balances,
    distribution: i.distribution,
    jur: i.jur,
    growth: i.growth ?? '',
    nostr: grid('nostr', 'n_'),
    result_custodial: Math.round(T.custodial),
    result_noncustodial: Math.round(T.noncustodial),
    link: result.link,
    overrides: Object.keys(result.overrides).length ? JSON.stringify(result.overrides) : '',
    version: String(result.version),
    ...contact,
    test: test || '',
  }
}

/** The signer a save uses: the visitor's own, else the tab's disposable key. */
function signerForSave() {
  const own = signIn?.current()
  if (own) return own
  if (!session) session = createSessionSigner()
  return session
}

/** Save to Nostr: with a key already chosen, save; otherwise ask how to sign first. */
function onSave() {
  const formEl = $('#calc-form')
  const error = $('#save-error')
  if (!form || !formEl) return
  error.hidden = true
  if (missing(formEl).length) return gate()
  const problem = withhold(formEl)
  // A bot that filled the trap gets a receipt that looks like a save.
  if (problem === 'honeypot') {
    $('#save-status').textContent = fmt(t('modal.saved'), { ok: 1, total: 1, id: 'ok' })
    return
  }
  if (problem) {
    error.textContent = t(`errors.${problem}`) || t('errors.unknown')
    error.hidden = false
    return
  }
  if (signIn?.current()) return save(signIn.current())
  pendingSave = true
  openSign()
}

/** The third door: no key of your own, a disposable one for this tab. */
function onSession() {
  closeSign()
  if (pendingOpen) {
    // A fresh disposable key cannot open anything; only the one that saved it could.
    const pointer = pendingOpen
    pendingOpen = null
    if (hasSessionKey()) return restore(pointer, signerForSave())
    setStatus(t('errors.restore_locked'))
    return
  }
  if (!pendingSave) return
  pendingSave = false
  save(signerForSave())
}

/** A signer arrived from the extension or the bunker; a pending save or open goes ahead. */
function onSigner(signer) {
  gate()
  if (!signer) return
  closeSign()
  if (pendingOpen) {
    const pointer = pendingOpen
    pendingOpen = null
    return restore(pointer, signer)
  }
  if (!pendingSave) return
  pendingSave = false
  save(signer)
}

async function save(signer) {
  const formEl = $('#calc-form')
  const status = $('#save-status')
  const result = fresh()
  if (!result) return closeSave()
  const contact = readContact(formEl)
  const pow = dev.noPow ? 0 : signer.kind === 'session' ? config.pow.response : config.pow.signed

  $('#save-submit').disabled = true
  status.textContent = t('status.saving')
  try {
    const { event, ok, relays } = await submitResponse(form, {
      signer,
      values: valuesFor(result, contact),
      pow,
      onProgress: ({ tries }) => (status.textContent = fmt(t('status.mining'), { hashes: tries })),
    })
    sends.push(Date.now())
    status.textContent = ok ? fmt(t('modal.saved'), { ok, total: relays.length, id: event.id.slice(0, 12) }) : t('status.failed')
    setStatus(status.textContent)
    if (ok) {
      const hint = relays.find((r) => r.ok)?.url
      const nevent = neventEncode({ id: event.id, relays: hint ? [hint] : [], author: event.pubkey })
      await tell(signer, result, contact, `${location.origin}${location.pathname}?nevent=${nevent}`)
    }
  } catch (err) {
    console.warn('calculator: could not save', err)
    status.textContent = t('status.failed')
  } finally {
    gate()
  }
}

/** A lead goes to hello's inbox as an encrypted message, once per distinct set of details. */
async function tell(signer, result, contact, open) {
  const fingerprint = JSON.stringify([contact, result.link])
  if (fingerprint === lastLead) return
  let recipient
  try {
    recipient = pickRecipient(await loadRecipients(), config.lead_recipient)
  } catch {
    return
  }
  if (!recipient) return
  const content = composeLead({
    inputs: result.inputs,
    result: {
      custodial: compact(result.typical.totals.custodial),
      noncustodial: compact(result.typical.totals.noncustodial),
      five_year: compact(result.typical.totals.five_year),
      floor: compact(result.low.totals.five_year),
    },
    link: result.link,
    contact,
    fieldLabels: Object.fromEntries([...Object.keys(result.inputs), ...Object.keys(contact)].map((k) => [k, { label: labelFor(k) }])),
    open,
  })
  try {
    await sendLead({ signer, recipient, subject: t('compose.subject'), content, pow: dev.noPow ? 0 : signer.kind === 'session' ? config.pow.anonymous : config.pow.signed })
    lastLead = fingerprint
  } catch (err) {
    console.warn('calculator: could not notify', err)
  }
}

let copyTimer = null
async function onCopyUrl() {
  const button = $('#save-copy')
  const query = currentQuery()
  const url = query ? `${location.origin}${location.pathname}?${query}` : location.href
  try {
    await navigator.clipboard.writeText(url)
  } catch {
    $('#save-status').textContent = url
    return
  }
  button.classList.add('is-copied')
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => button.classList.remove('is-copied'), 1800)
}

// ── opening a saved response ─────────────────────────────────────────────────

/** Fetch, decrypt with this signer, and show. */
async function restore(pointer, signer) {
  setStatus(t('status.opening'))
  const event = await fetchResponse(pointer, snapshot)
  if (!event) return setStatus(t('errors.restore_missing'))
  const opened = await openResponse(event, { signer, snapshot, map })
  if (opened.error) return setStatus(t(`errors.${opened.error}`))
  const v = opened.values
  const inputs = { mau: v.mau, posts_per_user: v.posts_per_user, mb: v.mb, legal_usd: v.legal_usd, rev: v.rev, rails: v.rails, balances: v.balances, distribution: v.distribution, jur: v.jur, growth: Array.isArray(v.growth) ? v.growth[0] : v.growth }
  for (const [area, hours] of Object.entries(v.engineering || {})) inputs[`eng_${area}`] = hours
  for (const [row, n] of Object.entries(v.moderation || {})) inputs[`mod_${row}`] = n
  for (const [row, share] of Object.entries(v.nostr || {})) inputs[`n_${row}`] = share
  let overrides = {}
  try {
    overrides = v.overrides ? JSON.parse(v.overrides) : {}
  } catch {
    overrides = {}
  }
  const formEl = $('#calc-form')
  writeInputs(formEl, inputs)
  writeOverrides(overrides)
  writeContact(formEl, Object.fromEntries(CONTACT_KEYS.map((k) => [k, v[k]])))
  if (v.test) test = v.test
  const result = run(inputs, overrides, { focus: false })
  if (result) setStatus(fmt(t('status.opened'), { when: new Date(event.created_at * 1000).toLocaleString(), how: t(`status.opened_${opened.how}`) }))
}

/** ?nevent= on load: open with the tab's key if it has one, else ask for a signer. */
function openFromLink(pointer) {
  if (!form) return setStatus(t('errors.restore_missing'))
  if (hasSessionKey()) return restore(pointer, signerForSave())
  pendingOpen = pointer
  setStatus(t('errors.restore_locked'))
  openSign()
}

function onEdit() {
  activateTab('app', { focus: true })
}

// ── boot ─────────────────────────────────────────────────────────────────────

function wire() {
  $('#calc-form')?.addEventListener('submit', onCalculate)
  $('#r-edit')?.addEventListener('click', onEdit)
  $('#r-whose-link')?.addEventListener('click', onEdit)
  wireCharts()
  $('#a-reset')?.addEventListener('click', onReset)
  $('#a-recalc')?.addEventListener('click', onRecalculate)
  for (const input of $$('.assume-input')) {
    input.addEventListener('change', markChanged)
    input.addEventListener('change', onDirty)
  }
  $('#calc-form')?.addEventListener('input', onDirty)
  $('#calc-form')?.addEventListener('change', onDirty)
  $('#save-open')?.addEventListener('click', openSave)
  $('#save-close')?.addEventListener('click', closeSave)
  $('#save-submit')?.addEventListener('click', onSave)
  $('#save-copy')?.addEventListener('click', onCopyUrl)
  $('#save-modal')?.addEventListener('input', gate)
  $('#save-modal')?.addEventListener('change', gate)
  $('#sign-session')?.addEventListener('click', onSession)
  $('#sign-cancel')?.addEventListener('click', () => {
    pendingSave = false
    pendingOpen = null
    closeSign()
  })
  $('#sign-modal')?.addEventListener('close', () => {
    pendingSave = false
    pendingOpen = null
  })
  wireTabs(onTab)
  wireToggles()
}

function onReset() {
  writeOverrides({})
  markChanged()
  dirty = true
}

async function boot() {
  const formEl = $('#calc-form')
  if (!formEl) return
  wire()
  wireSliders(formEl)
  const A = assumptions.assumptions
  writeDefaults(formEl, {
    accounts: A.default_hours_accounts.typical,
    content: A.default_hours_content.typical,
    infra: A.default_hours_infra.typical,
    legal: A.default_hours_legal.typical,
  })
  try {
    starting = JSON.stringify(normalizeInputs(readInputs(formEl)))
  } catch {
    starting = ''
  }

  // Estimated Cost is the page's front: a fresh page shows the defaults'
  // result, a results link shows its own. Neither publishes anything.
  const opened = decode(location.search)
  test = opened.test
  const pointer = decodePointer(new URLSearchParams(location.search).get('nevent'))
  if (pointer) {
    // The response's own answers win; a results link in the same address fills first.
    if (opened.present) {
      writeInputs(formEl, opened.inputs)
      writeOverrides(opened.overrides)
    }
    run(readInputs(formEl), readOverrides(), { focus: false })
  } else if (opened.present) {
    writeInputs(formEl, opened.inputs)
    writeOverrides(opened.overrides)
    const result = run(opened.inputs, opened.overrides, { focus: false })
    if (result) setStatus(t('status.shared'))
    else activateTab('app')
  } else {
    const result = run(readInputs(formEl), readOverrides(), { focus: false })
    if (result) history.replaceState(null, '', location.pathname)
  }

  if (form) {
    const open = $('#save-open')
    if (open) open.hidden = false
    signIn = createSignIn({ onChange: onSigner })
    signIn.wire()
    signIn.markExtension(await detectNip07())
    if (pointer) openFromLink(pointer)
  }
  document.documentElement.dataset.calculator = 'ready'
  document.documentElement.dataset.calculatorForm = form ? 'ready' : 'none'
  if (dev.local) console.info('calculator: localhost overrides active', dev)
}

boot()
