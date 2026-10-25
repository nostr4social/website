// The form: reading it into raw inputs, writing inputs back into it, and
// pointing at the field that failed. The field names are the input keys, so
// this is a straight mapping with no table of its own.

import { $, $$ } from '../../shared/src/dom.js'
import { INPUTS } from './inputs.js'

export const CONTACT_KEYS = ['app_name', 'company', 'contact_name', 'email']

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

/**
 * Raw values, as strings and arrays, ready for normalizeInputs. A slider is
 * an answer only once it has been moved or written; one left where it was,
 * or standing on a suggestion, reads as blank.
 */
export function readInputs(form) {
  const out = {}
  for (const [key, spec] of Object.entries(INPUTS)) {
    const slider = $(`input[type="range"][name="${key}"]`, form)
    if (slider) {
      out[key] = slider.dataset.touched && !slider.dataset.suggested ? sliderValue(slider) : ''
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

export function writeContact(form, contact = {}) {
  for (const key of CONTACT_KEYS) if (form.elements[key] && contact[key] != null) form.elements[key].value = String(contact[key])
}

/** Put a set of inputs (raw or clean) into the form. Missing keys are left alone. */
export function writeInputs(form, inputs) {
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (!(key in inputs) || inputs[key] == null) continue
    const v = inputs[key]
    const slider = $(`input[type="range"][name="${key}"]`, form)
    if (slider) {
      setSlider(slider, v)
      answered(slider)
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
 * The form's starting values: the required inputs' defaults (a required
 * choice, like the team size, starts answered) and any optional question
 * with a starting answer of its own (growth starts on Steady).
 */
export function writeDefaults(form) {
  const starting = {}
  for (const [key, spec] of Object.entries(INPUTS)) {
    if (spec.type === 'option' && spec.start != null) starting[key] = spec.start
    else if (spec.type === 'multi' || (spec.type === 'option' && spec.required) || ((spec.type === 'number' || spec.type === 'integer') && spec.default != null)) starting[key] = spec.default
  }
  writeInputs(form, starting)
  for (const slider of $$('input[type="range"]', form)) announceSlider(slider)
}

/** A slider the founder has answered, or a link has set: no longer a suggestion. */
function answered(slider) {
  slider.dataset.touched = '1'
  delete slider.dataset.suggested
  slider.classList.remove('is-suggested')
  slider.closest('.slider-row')?.classList.remove('is-suggested')
}

/**
 * Show what the openers imply: every slider the founder has not touched is
 * put on the band nearest the derived value and drawn as a suggestion. It
 * reads as blank until moved, so a link carries only what was said.
 */
export function suggest(form, effective, derived = {}) {
  for (const key of Object.keys(derived)) {
    const slider = $(`input[type="range"][name="${key}"]`, form)
    if (!slider || slider.dataset.touched) continue
    setSlider(slider, effective[key])
    slider.dataset.suggested = '1'
    slider.classList.add('is-suggested')
    slider.closest('.slider-row')?.classList.add('is-suggested')
  }
}

export function wireSliders(form) {
  for (const slider of $$('input[type="range"]', form)) {
    slider.addEventListener('input', () => {
      answered(slider)
      announceSlider(slider)
    })
  }
}

/**
 * Back to the illustrative app: every answer cleared, every slider untouched
 * again (so the openers' suggestions return), every section folded.
 */
export function resetForm(form) {
  form.reset()
  for (const slider of $$('input[type="range"]', form)) {
    delete slider.dataset.touched
    delete slider.dataset.suggested
    slider.classList.remove('is-suggested')
    slider.closest('.slider-row')?.classList.remove('is-suggested')
    announceSlider(slider)
  }
  writeDefaults(form)
  for (const button of $$('.group__toggle', form)) setDetails(button, false)
  markInvalid(form, null)
}

// ── the sections' details ────────────────────────────────────────────────────

/** "Add more details" on each section shows the questions behind its opener. */
export function wireDetails(form) {
  for (const button of $$('.group__toggle', form)) {
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true'
      setDetails(button, open)
    })
  }
}

function setDetails(button, open) {
  button.setAttribute('aria-expanded', String(open))
  button.textContent = open ? button.dataset.hide : button.dataset.show
  const more = document.getElementById(button.getAttribute('aria-controls'))
  if (more) more.hidden = !open
}

/** Open any section whose hidden questions already carry an answer (from a link or a saved response). */
export function revealDetails(form) {
  for (const button of $$('.group__toggle', form)) {
    const more = document.getElementById(button.getAttribute('aria-controls'))
    if (!more) continue
    const answered = $$('input, select, textarea', more).some((i) => {
      if (i.type === 'range') return !i.dataset.suggested && i.dataset.touched
      if (i.type === 'checkbox' || i.type === 'radio') return i.checked
      return i.value.trim() !== ''
    })
    if (answered) setDetails(button, true)
  }
}

export function markInvalid(form, key) {
  for (const node of $$('.is-invalid', form)) node.classList.remove('is-invalid')
  if (!key) return
  const wrap = $(`#field-${key}`, form)
  if (wrap) wrap.classList.add('is-invalid')
  const input = $(`#f-${key}`, form) || $(`input[name="${key}"]`, form)
  input?.focus({ preventScroll: false })
}
