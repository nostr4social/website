// The form: reading it into raw inputs, writing inputs back into it, and
// pointing at the field that failed. The field names are the input keys, so
// this is a straight mapping with no table of its own.

import { $, $$ } from '../../shared/src/dom.js'
import { INPUTS } from './inputs.js'

export const CONTACT_KEYS = ['name', 'company', 'email', 'npub']

/** A slider's bands, from its data attributes. */
function bands(slider) {
  return { values: slider.dataset.values.split(','), labels: slider.dataset.labels.split('|') }
}

/** The band a slider stands on. */
export function sliderValue(slider) {
  return bands(slider).values[Number(slider.value)] ?? ''
}

/** Put a slider on the band with this value; the nearest if none matches exactly. */
export function setSlider(slider, value) {
  const { values } = bands(slider)
  let at = values.indexOf(String(value))
  if (at < 0) {
    const n = Number(value)
    at = 0
    for (let i = 1; i < values.length; i++) if (Math.abs(Number(values[i]) - n) < Math.abs(Number(values[at]) - n)) at = i
  }
  slider.value = String(at)
  announceSlider(slider)
}

/** Name the band in the output beside the slider and for assistive tech. */
export function announceSlider(slider) {
  const label = bands(slider).labels[Number(slider.value)] ?? ''
  slider.setAttribute('aria-valuetext', label)
  const out = slider.closest('.slider-row')?.querySelector('output')
  if (out) out.textContent = label
}

/** Raw values, as strings and arrays, ready for normalizeInputs. */
export function readInputs(form) {
  const out = {}
  for (const [key, spec] of Object.entries(INPUTS)) {
    const slider = $(`input[type="range"][name="${key}"]`, form)
    if (slider) {
      out[key] = sliderValue(slider)
    } else if (spec.type === 'multi') {
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
    const slider = $(`input[type="range"][name="${key}"]`, form)
    if (slider) {
      setSlider(slider, v)
    } else if (spec.type === 'multi') {
      const list = Array.isArray(v) ? v : String(v).split(',')
      for (const box of $$(`input[name="${key}"]`, form)) box.checked = list.includes(box.value)
    } else if (spec.type === 'option') {
      for (const radio of $$(`input[name="${key}"]`, form)) radio.checked = radio.value === String(v)
    } else if (form.elements[key]) {
      form.elements[key].value = String(v)
    }
  }
}

/**
 * The form's starting values: the required inputs' defaults, and each
 * engineering slider on the band nearest the default hours the model would
 * use for a blank row, so what the founder sees is what the model assumes.
 */
export function writeDefaults(form, defaultHours = {}) {
  const starting = {}
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (spec.type === 'multi') starting[key] = spec.default
  }
  for (const [area, hours] of Object.entries(defaultHours)) starting[`eng_${area}`] = hours
  writeInputs(form, starting)
  for (const slider of $$('input[type="range"]', form)) announceSlider(slider)
}

export function wireSliders(form) {
  for (const slider of $$('input[type="range"]', form)) slider.addEventListener('input', () => announceSlider(slider))
}

export function markInvalid(form, key) {
  for (const node of $$('.is-invalid', form)) node.classList.remove('is-invalid')
  if (!key) return
  const wrap = $(`#field-${key}`, form)
  if (wrap) wrap.classList.add('is-invalid')
  const input = $(`#f-${key}`, form) || $(`input[name="${key}"]`, form)
  input?.focus({ preventScroll: false })
}
