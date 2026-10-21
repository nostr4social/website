// The results link. Inputs and assumption overrides become query parameters,
// readable and hand-editable; nothing about the person is ever in it.
//
//   ?mau=50000&posts=1000000&eng=3&ts=inhouse&ts_n=2&pay=yes&rev=20000
//    &stores=apple,google&jur=eu,us&nostr=storage&a.blob_gb_month=0.015&v=1
//
// Encoding writes every input the model used, so a link is complete on its
// own; optional inputs left blank are omitted. Decoding ignores anything it
// does not recognise.

import { INPUTS } from './inputs.js'

export const VERSION_KEY = 'v'
export const OVERRIDE_PREFIX = 'a.'
export const TEST_KEY = 'test'

export function encode(inputs, overrides = {}, version = 1) {
  const p = new URLSearchParams()
  for (const [key, spec] of Object.entries(INPUTS)) {
    const v = inputs[key]
    if (v == null || v === '') continue
    if (spec.type === 'multi') {
      if (v.length) p.set(key, v.join(','))
    } else {
      p.set(key, String(v))
    }
  }
  for (const [key, v] of Object.entries(overrides)) p.set(OVERRIDE_PREFIX + key, String(v))
  p.set(VERSION_KEY, String(version))
  return p.toString()
}

/** Raw inputs, overrides, version and the test marker from a query string. */
export function decode(search) {
  const p = new URLSearchParams(search)
  const inputs = {}
  const overrides = {}
  let present = false
  for (const [key, v] of p.entries()) {
    if (key in INPUTS) {
      inputs[key] = v
      present = true
    } else if (key.startsWith(OVERRIDE_PREFIX)) {
      overrides[key.slice(OVERRIDE_PREFIX.length)] = v
    }
  }
  const version = p.has(VERSION_KEY) ? Number(p.get(VERSION_KEY)) : null
  const test = p.get(TEST_KEY)
  return { inputs, overrides, version, present, test }
}
