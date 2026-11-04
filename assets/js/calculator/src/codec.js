// The results link. Inputs and assumption overrides become query parameters,
// readable and hand-editable; nothing about the person is ever in it.
//
//   ?mau=50000&posts=1000000&eng=3&ts=inhouse&ts_n=2&pay=yes&p2p_volume=20000
//    &stores=apple,google&jur=eu,us&nostr=storage&a.blob_gb_month=0.015&v=1
//
// Encoding writes every input the model used, so a link is complete on its
// own; optional inputs left blank, or standing on the value that means
// "not given", are omitted. Decoding ignores anything it does not recognise.

import { INPUTS } from './inputs.js'
import { isDate } from './model.js'

export const VERSION_KEY = 'v'
export const OVERRIDE_PREFIX = 'a.'
export const TEST_KEY = 'test'
// The date the calculation is as of, so a link opened later shows what the person saw.
export const DATE_KEY = 't'
// Keys an earlier version used, read as the current one: a version-3 link's `rev` is the payment volume.
const RENAMED = { rev: 'p2p_volume' }

export function encode(inputs, overrides = {}, version = 1, today = null) {
  const p = new URLSearchParams()
  for (const [key, spec] of Object.entries(INPUTS)) {
    const v = inputs[key]
    if (v == null || v === '') continue
    if (spec.omit != null && String(v) === spec.omit) continue
    if (spec.type === 'multi') {
      if (v.length) p.set(key, v.join(','))
    } else {
      p.set(key, String(v))
    }
  }
  for (const [key, v] of Object.entries(overrides)) p.set(OVERRIDE_PREFIX + key, String(v))
  p.set(VERSION_KEY, String(version))
  if (isDate(today)) p.set(DATE_KEY, today)
  return p.toString()
}

/** Raw inputs, overrides, version, date and the test marker from a query string. A malformed date is no date. */
export function decode(search) {
  const p = new URLSearchParams(search)
  const inputs = {}
  const overrides = {}
  let present = false
  for (const [key, v] of p.entries()) {
    const name = Object.hasOwn(RENAMED, key) ? RENAMED[key] : key
    if (Object.hasOwn(INPUTS, name)) {
      if (!Object.hasOwn(inputs, name) || name === key) inputs[name] = v
      present = true
    } else if (key.startsWith(OVERRIDE_PREFIX)) {
      overrides[key.slice(OVERRIDE_PREFIX.length)] = v
    }
  }
  const version = p.has(VERSION_KEY) ? Number(p.get(VERSION_KEY)) : null
  const test = p.get(TEST_KEY)
  const today = isDate(p.get(DATE_KEY)) ? p.get(DATE_KEY) : null
  return { inputs, overrides, version, present, test, today }
}
