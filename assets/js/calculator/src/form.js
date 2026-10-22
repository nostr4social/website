// The form: reading it into raw inputs, writing inputs back into it, and
// pointing at the field that failed. The field names are the input keys, so
// this is a straight mapping with no table of its own.

import { $, $$ } from '../../shared/src/dom.js'
import { INPUTS } from './inputs.js'

export const CONTACT_KEYS = ['name', 'company', 'email', 'npub']

/** Raw values, as strings and arrays, ready for normalizeInputs. */
export function readInputs(form) {
  const out = {}
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (spec.type === 'multi') {
      out[key] = $$(`input[name="${key}"]:checked`, form).map((i) => i.value)
    } else if (spec.type === 'option') {
      out[key] = $(`input[name="${key}"]:checked`, form)?.value ?? ''
    } else {
      out[key] = form.elements[key]?.value.trim() ?? ''
    }
  }
  return out
}

export function readContact(form) {
  const out = {}
  for (const key of CONTACT_KEYS) {
    const v = form.elements[key]?.value.trim()
    if (v) out[key] = v
  }
  return out
}

/** Put a set of inputs (raw or clean) into the form. Missing keys are left alone. */
export function writeInputs(form, inputs) {
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (!(key in inputs) || inputs[key] == null) continue
    const v = inputs[key]
    if (spec.type === 'multi') {
      const list = Array.isArray(v) ? v : String(v).split(',')
      for (const box of $$(`input[name="${key}"]`, form)) box.checked = list.includes(box.value)
    } else if (spec.type === 'option') {
      for (const radio of $$(`input[name="${key}"]`, form)) radio.checked = radio.value === String(v)
    } else if (form.elements[key]) {
      form.elements[key].value = String(v)
    }
  }
}

/** The form's starting values: the required inputs' defaults, nothing else. */
export function writeDefaults(form) {
  const starting = {}
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (spec.type === 'option' || spec.type === 'multi') starting[key] = spec.default
  }
  writeInputs(form, starting)
}

export function markInvalid(form, key) {
  for (const node of $$('.is-invalid', form)) node.classList.remove('is-invalid')
  if (!key) return
  const wrap = $(`#field-${key}`, form)
  if (wrap) wrap.classList.add('is-invalid')
  const input = $(`#f-${key}`, form) || $(`input[name="${key}"]`, form)
  input?.focus({ preventScroll: false })
}
