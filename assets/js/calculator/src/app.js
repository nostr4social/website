// /calculator/ — the Cost of Custody Calculator.
//
// Read top to bottom: this file is the whole flow. Inputs come from the form
// or from a results link; the model (model.js) turns them into six lines in
// three scenarios; ui.js puts the numbers into the page. Nothing here is a
// literal the visitor reads: the words are in the page's JSON blocks.
//
// A calculation never waits on the network. Saving the inputs as a Nostr
// form response (submit.js) happens after the results are on screen, and a
// link that opens results submits nothing.

import { $ } from '../../shared/src/dom.js'
import { config, readJson, t } from '../../shared/src/config.js'
import { calculate } from './model.js'
import { decode, encode } from './codec.js'
import { InputError } from './inputs.js'
import { markInvalid, readContact, readInputs, writeDefaults, writeInputs } from './form.js'
import {
  markChanged,
  readOverrides,
  renderResults,
  setError,
  setLink,
  setStatus,
  showResults,
  wireToggles,
  writeOverrides,
} from './ui.js'

const assumptions = readJson('page-assumptions')
const fields = readJson('page-fields')

let current = null // the last result shown
let test = null // the hidden test marker, from the URL only

// ── calculating ──────────────────────────────────────────────────────────────

function run(raw, overrides, { submit = false, focus = true } = {}) {
  let result
  try {
    result = calculate(raw, assumptions, overrides)
  } catch (err) {
    if (err instanceof InputError) {
      markInvalid($('#calc-form'), err.key)
      setError(err.code, fields[err.key]?.label || err.key)
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
  const url = `${location.origin}${location.pathname}?${query}`
  setLink(url)
  history.replaceState(null, '', `?${query}${test ? `&test=${encodeURIComponent(test)}` : ''}`)

  const contact = $('#r-contact')
  if (contact) {
    const p = new URLSearchParams({ subject: t('contact_subject'), calc: query })
    contact.href = `${config.contact_href}?${p.toString()}`
  }

  showResults(true, { focus })
  if (submit) submitResponse(result)
  return result
}

/** Saving the inputs as a kind 1069 response: wired in the next step. */
function submitResponse(result) {
  if (!config.form) return
  setStatus(t('status.saving'))
  void result
}

function onSubmit(event) {
  event.preventDefault()
  const form = event.currentTarget
  const raw = readInputs(form)
  // Contact details are read here and only ever travel with the submission.
  readContact(form)
  run(raw, readOverrides(), { submit: true })
}

/** An assumption edit recomputes what is on screen; it never submits. */
function onAssumptionChange() {
  markChanged()
  if (!current) return
  run(readInputs($('#calc-form')), readOverrides(), { submit: false, focus: false })
}

function onReset() {
  writeOverrides({})
  onAssumptionChange()
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
  $('#calc-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  $('#f-mau')?.focus({ preventScroll: true })
}

// ── boot ─────────────────────────────────────────────────────────────────────

function wire() {
  $('#calc-form')?.addEventListener('submit', onSubmit)
  $('#r-share')?.addEventListener('click', onShare)
  $('#r-edit')?.addEventListener('click', onEdit)
  $('#a-reset')?.addEventListener('click', onReset)
  for (const input of document.querySelectorAll('.assume-input')) input.addEventListener('change', onAssumptionChange)
  wireToggles()
}

function boot() {
  const form = $('#calc-form')
  if (!form) return
  wire()
  writeDefaults(form)

  const opened = decode(location.search)
  test = opened.test
  if (opened.present) {
    writeInputs(form, opened.inputs)
    writeOverrides(opened.overrides)
    const result = run(opened.inputs, opened.overrides, { submit: false, focus: false })
    if (result) setStatus(t('status.shared'))
  }
  document.documentElement.dataset.calculator = 'ready'
}

boot()
