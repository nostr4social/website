// /calculator/ — the Cost of Custody Calculator.
//
// Read top to bottom: this file is the whole flow. Inputs come from the form
// or from a results link; the model (model.js) turns them into six lines in
// three scenarios; ui.js puts the numbers into the page. Nothing here is a
// literal the visitor reads: the words are in the page's JSON blocks.
//
// A calculation never waits on the network. Saving the inputs as a Nostr
// form response (submit.js) happens after the results are on screen, and a
// link that opens results submits nothing. Nobody has to sign in: a one-time
// key signs the response unless the visitor signed in first.

import { $ } from '../../shared/src/dom.js'
import { config, dev, fmt, readJson, t } from '../../shared/src/config.js'
import { createGuestSigner, detectNip07 } from '../../shared/src/signers.js'
import { createSignIn } from '../../shared/src/signin.js'
import { loadRecipients, pickRecipient } from '../../shared/src/recipients.js'
import { calculate } from './model.js'
import { decode, encode } from './codec.js'
import { GRIDS, InputError } from './inputs.js'
import { markInvalid, readContact, readInputs, wireSliders, writeDefaults, writeInputs } from './form.js'
import { compact } from './format.js'
import { composeLead, prepareForm, sendLead, submitResponse } from './submit.js'
import {
  activateTab,
  markChanged,
  readOverrides,
  renderResults,
  setError,
  setLink,
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

/** A question's words, from the form itself, for an error that names it. */
function labelFor(key) {
  const node = document.querySelector(`#field-${key} .field__label, label[for="f-${key}"]`)
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : key
}

let current = null // the last result shown
let test = null // the hidden test marker, from the URL only
let openedAt = Date.now()
let sends = [] // timestamps, for the per-tab rate limit
let signIn = null

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
  renderResults(result)

  const query = encode(result.inputs, result.overrides, result.version)
  result.link = `${location.origin}${location.pathname}?${query}`
  setLink(result.link)
  history.replaceState(null, '', `?${query}${test ? `&test=${encodeURIComponent(test)}` : ''}`)

  const contact = $('#r-contact')
  if (contact) contact.href = `${config.contact_href}?${new URLSearchParams({ subject: t('contact_subject'), calc: query })}`

  showResults(true, { focus })
  return result
}

// ── saving ───────────────────────────────────────────────────────────────────

/** Reasons not to save. The results show regardless; only the submission is withheld. */
function withhold(formEl) {
  if (formEl.elements.website.value) return 'honeypot'
  if (Date.now() - openedAt < config.limits.min_seconds * 1000) return 'too_fast'
  const cutoff = Date.now() - config.limits.rate.window
  sends = sends.filter((at) => at > cutoff)
  if (sends.length >= config.limits.rate.max) return 'rate_limited'
  return null
}

/** The submission's values, keyed like the id map: grids fold their rows into one answer. */
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

async function save(result, contact) {
  if (!form) return
  const own = signIn?.current()
  const signer = own || createGuestSigner()
  const pow = dev.noPow ? 0 : own ? config.pow.signed : config.pow.response
  setStatus(t('status.saving'))
  try {
    const { ok, relays } = await submitResponse(form, {
      signer,
      values: valuesFor(result, contact),
      pow,
      onProgress: ({ tries }) => setStatus(fmt(t('status.mining'), { hashes: tries })),
    })
    sends.push(Date.now())
    setStatus(ok ? fmt(t('status.saved'), { ok, total: relays.length }) : t('status.failed'))
    if (ok && Object.keys(contact).length) await tell(signer, result, contact)
  } catch (err) {
    console.warn('calculator: could not save', err)
    setStatus(t('status.failed'))
  } finally {
    if (!own) signer.close()
  }
}

/** A lead goes to hello's inbox as an encrypted message, in addition to the response. */
async function tell(signer, result, contact) {
  let recipient
  try {
    recipient = pickRecipient(await loadRecipients(), config.lead_recipient)
  } catch {
    return
  }
  if (!recipient) return
  const content = composeLead({
    inputs: result.inputs,
    result: { custodial: compact(result.typical.totals.custodial), noncustodial: compact(result.typical.totals.noncustodial) },
    link: result.link,
    contact,
    fieldLabels: Object.fromEntries(Object.keys(result.inputs).map((k) => [k, { label: labelFor(k) }])),
  })
  try {
    await sendLead({ signer, recipient, subject: t('compose.subject'), content, pow: dev.noPow ? 0 : signer.kind === 'guest' ? config.pow.anonymous : config.pow.signed })
  } catch (err) {
    console.warn('calculator: could not notify', err)
  }
}

function onSubmit(event) {
  event.preventDefault()
  const formEl = event.currentTarget
  const result = run(readInputs(formEl), readOverrides())
  if (!result) return
  if (withhold(formEl)) return
  void save(result, readContact(formEl))
}

/** Recalculate: the form's answers with the edited assumptions; never submits. */
function onRecalculate() {
  markChanged()
  run(readInputs($('#calc-form')), readOverrides(), { focus: true })
}

function onReset() {
  writeOverrides({})
  markChanged()
}

async function onShare() {
  const link = $('#r-link')
  if (!link) return
  try {
    await navigator.clipboard.writeText(link.value)
    setStatus(t('share_done'))
  } catch {
    link.select()
  }
}

function onEdit() {
  activateTab('app', { focus: true })
}

// ── boot ─────────────────────────────────────────────────────────────────────

function wire() {
  $('#calc-form')?.addEventListener('submit', onSubmit)
  $('#r-share')?.addEventListener('click', onShare)
  $('#r-edit')?.addEventListener('click', onEdit)
  $('#a-reset')?.addEventListener('click', onReset)
  $('#a-recalc')?.addEventListener('click', onRecalculate)
  for (const input of document.querySelectorAll('.assume-input')) input.addEventListener('change', markChanged)
  wireTabs((name, opts) => activateTab(name, opts))
  wireToggles()
}

async function boot() {
  const formEl = $('#calc-form')
  if (!formEl) return
  wire()
  activateTab('app')
  wireSliders(formEl)
  const A = assumptions.assumptions
  writeDefaults(formEl, {
    accounts: A.default_hours_accounts.typical,
    content: A.default_hours_content.typical,
    infra: A.default_hours_infra.typical,
    legal: A.default_hours_legal.typical,
  })

  const opened = decode(location.search)
  test = opened.test
  if (opened.present) {
    writeInputs(formEl, opened.inputs)
    writeOverrides(opened.overrides)
    const result = run(opened.inputs, opened.overrides, { focus: false })
    if (result) setStatus(t('status.shared'))
  }

  if (form) {
    const row = $('#sign-row')
    if (row) row.hidden = false
    signIn = createSignIn()
    signIn.wire()
    signIn.markExtension(await detectNip07())
  }
  document.documentElement.dataset.calculator = 'ready'
  document.documentElement.dataset.calculatorForm = form ? 'ready' : 'none'
  if (dev.local) console.info('calculator: localhost overrides active', dev)
}

boot()
