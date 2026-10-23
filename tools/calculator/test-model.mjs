// Tests for the cost model and the results-link codec. Pure Node, no browser.
//
//   npm run test:model

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const data = JSON.parse(await readFile(resolve(root, '_data/assumptions/v1.json'), 'utf8'))
const { calculate, evaluate, resolveAssumptions, LINES, SCENARIOS, normalizeInputs } = await import(resolve(root, 'assets/js/calculator/src/model.js'))
const { encode, decode } = await import(resolve(root, 'assets/js/calculator/src/codec.js'))
const { INPUTS, InputError } = await import(resolve(root, 'assets/js/calculator/src/inputs.js'))
const { compact } = await import(resolve(root, 'assets/js/calculator/src/format.js'))

let failures = 0
const test = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL ${name}\n     ${err.message}`)
  }
}

const base = { mau: 50000, posts_per_user: 20, eng_accounts: '5', eng_content: '25', eng_infra: '25', mod_inhouse: '5', rails: ['apple', 'google', 'processor'], rev: 20000, jur: ['eu', 'uk', 'us'] }
const finite = (r) => {
  for (const s of SCENARIOS) {
    for (const l of LINES) {
      assert.ok(Number.isFinite(r[s].lines[l].custodial), `${s}.${l}.custodial finite`)
      assert.ok(Number.isFinite(r[s].lines[l].noncustodial), `${s}.${l}.noncustodial finite`)
      assert.ok(r[s].lines[l].custodial >= 0 && r[s].lines[l].noncustodial >= 0, `${s}.${l} non-negative`)
    }
    assert.ok(Number.isFinite(r[s].totals.per_mau_custodial))
  }
}

await test('every assumption the model reads exists in the file, and every one in the file is read', async () => {
  const text = await readFile(resolve(root, 'assets/js/calculator/src/model.js'), 'utf8')
  const used = new Set([...text.matchAll(/\bv\.([a-z_0-9]+)/g)].map((m) => m[1]))
  for (const key of used) assert.ok(key in data.assumptions, `assumption ${key} missing from the file`)
  for (const key of Object.keys(data.assumptions)) assert.ok(used.has(key), `assumption ${key} is in the file but never read`)
})

await test('the baseline evaluates to finite, non-negative numbers', () => finite(calculate(base, data)))

await test('low ≤ typical ≤ high on every line and total', () => {
  const r = calculate(base, data)
  for (const l of LINES) {
    assert.ok(r.low.lines[l].custodial <= r.typical.lines[l].custodial + 1e-6, `${l} custodial low ≤ typical`)
    assert.ok(r.typical.lines[l].custodial <= r.high.lines[l].custodial + 1e-6, `${l} custodial typical ≤ high`)
    assert.ok(r.low.lines[l].noncustodial <= r.typical.lines[l].noncustodial + 1e-6, `${l} non-custodial low ≤ typical`)
    assert.ok(r.typical.lines[l].noncustodial <= r.high.lines[l].noncustodial + 1e-6, `${l} non-custodial typical ≤ high`)
  }
  assert.ok(r.low.totals.custodial <= r.typical.totals.custodial && r.typical.totals.custodial <= r.high.totals.custodial)
})

await test('the non-custodial column is never zero where an obligation remains', () => {
  const r = calculate(base, data)
  for (const l of LINES) assert.ok(r.typical.lines[l].noncustodial > 0, `${l} non-custodial > 0`)
  // and in every scenario, including low
  for (const s of SCENARIOS) for (const l of LINES) assert.ok(r[s].lines[l].noncustodial > 0, `${s}.${l} > 0`)
})

await test('payments are zero in both columns only when there are no in-app payments', () => {
  const r = calculate({ ...base, rails: [], rev: 0 }, data)
  assert.equal(r.typical.lines.payments.custodial, 0)
  assert.equal(r.typical.lines.payments.noncustodial, 0)
  assert.equal(r.typical.lines.payments.none, true)
})

await test('compliance stays non-zero with only "other" as jurisdiction', () => {
  const r = calculate({ ...base, jur: ['other'] }, data)
  assert.ok(r.typical.lines.compliance.custodial > 0)
  assert.ok(r.typical.lines.compliance.noncustodial > 0)
})

await test('custodial cost is monotonic in MAU', () => {
  let last = -1
  for (const mau of [1000, 10000, 100000, 1000000, 10000000]) {
    const r = calculate({ ...base, mau }, data)
    assert.ok(r.typical.totals.custodial > last, `mau ${mau}`)
    last = r.typical.totals.custodial
  }
})

await test('custodial exceeds non-custodial for the baseline', () => {
  const r = calculate(base, data)
  assert.ok(r.typical.totals.custodial > r.typical.totals.noncustodial)
  assert.ok(r.typical.totals.saving > 0)
})

await test('store tiers step at the small-business threshold', () => {
  const small = calculate({ ...base, rev: 50000, rails: ['apple'] }, data).typical.lines.payments
  const big = calculate({ ...base, rev: 200000, rails: ['apple'] }, data).typical.lines.payments
  assert.equal(small.parts.find((p) => p.id === 'store_apple').rate, data.assumptions.apple_rate_small.typical)
  assert.equal(big.parts.find((p) => p.id === 'store_apple').rate, data.assumptions.apple_rate_standard.typical)
})

await test('store commission is identical in both columns; processor and reseller fees are not', () => {
  const r = calculate({ ...base, rails: ['apple', 'processor', 'reseller', 'p2p'] }, data).typical.lines.payments
  const apple = r.parts.find((p) => p.id === 'store_apple')
  const web = r.parts.find((p) => p.id === 'processor')
  const mor = r.parts.find((p) => p.id === 'reseller')
  const p2p = r.parts.find((p) => p.id === 'p2p')
  assert.equal(apple.custodial, apple.noncustodial)
  assert.ok(web.noncustodial < web.custodial)
  assert.ok(mor.custodial > web.custodial && mor.noncustodial === web.noncustodial)
  assert.equal(p2p.custodial, p2p.noncustodial)
})

await test('the money-transmitter allowance applies only when balances are held', () => {
  const no = calculate(base, data).typical.lines.payments.parts.find((p) => p.id === 'money_transmitter')
  const yes = calculate({ ...base, balances: ['yes'] }, data).typical.lines.payments.parts.find((p) => p.id === 'money_transmitter')
  assert.equal(no.custodial, 0)
  assert.ok(yes.custodial > 0 && yes.noncustodial > 0 && yes.noncustodial < yes.custodial)
})

await test('"already uses Nostr": Always equals the non-custodial figure, Somewhat is halfway, raw keys cancel the credit', () => {
  const r = calculate({ ...base, n_event_storage: '1', n_media_storage: '1', n_p2p: '1' }, data).typical
  assert.ok(Math.abs(r.lines.storage.custodial - r.lines.storage.noncustodial) < 1e-6)
  assert.ok(Math.abs(r.lines.payments.custodial - r.lines.payments.noncustodial) < 1e-6)
  assert.equal(r.lines.storage.already, true)
  assert.ok(r.lines.accounts.custodial > r.lines.accounts.noncustodial)
  const half = calculate({ ...base, n_keys: '0.5', n_raw_keys: '0' }, data).typical.lines.accounts
  assert.ok(Math.abs(half.custodial - (half.full + half.noncustodial) / 2) < 1e-6)
  assert.equal(half.partly, true)
  const raw = calculate({ ...base, n_keys: '1', n_raw_keys: '1' }, data).typical.lines.accounts
  assert.equal(raw.custodial, raw.full)
  const all = calculate({ ...base, n_keys: '1', n_event_storage: '1', n_media_storage: '1' }, data).typical
  assert.ok(Math.abs(all.lines.compliance.custodial - all.lines.compliance.noncustodial) < 1e-6)
  const nips = calculate({ ...base, n_nips: '1' }, data).typical
  assert.equal(nips.totals.custodial, calculate(base, data).typical.totals.custodial)
})

await test('nobody reviewing content yields an implied, non-zero moderation cost; people and seats add up', () => {
  const r = calculate({ ...base, mod_inhouse: null, mod_vendor: null }, data).typical.lines.moderation
  assert.equal(r.implied, true)
  assert.ok(r.custodial > 0)
  const both = calculate({ ...base, mod_inhouse: '5', mod_vendor: '50' }, data).typical.lines.moderation
  const inhouse = calculate({ ...base, mod_inhouse: '5', mod_vendor: '0' }, data).typical.lines.moderation
  assert.ok(both.custodial > inhouse.custodial && both.implied === false)
})

await test('a blank engineering row uses the default hours; a band overrides it', () => {
  const v = resolveAssumptions(data, 'typical')
  const blank = calculate({ ...base, eng_accounts: null }, data).typical.lines.accounts.parts.find((p) => p.id === 'engineering')
  const band = calculate({ ...base, eng_accounts: '60' }, data).typical.lines.accounts.parts.find((p) => p.id === 'engineering')
  assert.equal(blank.defaulted, true)
  assert.ok(Math.abs(blank.custodial / band.custodial - v.default_hours_accounts / 60) < 1e-9)
})

await test('reported legal spend replaces the program estimates and keeps the content-law floor', () => {
  const est = calculate(base, data).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  const rep = calculate({ ...base, legal_usd: 5000 }, data).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  assert.equal(rep.reported, true)
  assert.equal(rep.custodial, 5000)
  assert.ok(rep.custodial < est.custodial)
  assert.ok(rep.noncustodial > 0 && rep.noncustodial <= rep.custodial)
})

await test('the strictest selected jurisdiction sets the verification share', () => {
  const v = resolveAssumptions(data, 'typical')
  const uk = calculate({ ...base, jur: ['uk', 'us'] }, data).typical.lines.accounts.parts.find((p) => p.id === 'verify')
  assert.equal(uk.rate, Math.max(v.verify_share_uk, v.verify_share_us))
})

await test('an override applies to every scenario and an unknown or negative one is ignored', () => {
  const r = calculate(base, data, { blob_gb_month: 0.5, nonsense: 1, egress_gb: -1 })
  assert.deepEqual(Object.keys(r.overrides), ['blob_gb_month'])
  for (const s of SCENARIOS) {
    const blob = r[s].lines.storage.parts.find((p) => p.id === 'blob').custodial
    assert.ok(Math.abs(blob - (base.mau * 50) / 1024 * 0.5 * 12) < 1e-6, `${s} uses the override`)
  }
})

await test('the results link round-trips inputs and overrides', () => {
  const r = calculate({ ...base, n_feeds: '0.5', mb: 120, balances: ['yes'] }, data, { db_gb_month: 0.2 })
  const q = encode(r.inputs, r.overrides, r.version)
  const back = decode('?' + q + '&test=1&junk=2')
  const again = calculate(back.inputs, data, back.overrides)
  assert.deepEqual(again.inputs, r.inputs)
  assert.deepEqual(again.overrides, r.overrides)
  assert.equal(back.version, 1)
  assert.equal(back.test, '1')
  assert.equal(back.present, true)
  assert.equal(decode('?test=1').present, false)
  const zeros = encode(calculate({ ...base, n_keys: '0', mod_vendor: '0', eng_legal: '0' }, data).inputs, {}, 1)
  assert.ok(!zeros.includes('n_keys=') && !zeros.includes('mod_vendor=') && zeros.includes('eng_legal=0'), zeros)
})

await test('validation names the first bad input', () => {
  assert.throws(() => normalizeInputs({ ...base, mau: 'abc' }), (e) => e instanceof InputError && e.key === 'mau' && e.code === 'not_a_number')
  assert.throws(() => normalizeInputs({ ...base, mau: 0 }), (e) => e.key === 'mau' && e.code === 'too_small')
  assert.throws(() => normalizeInputs({ ...base, jur: [] }), (e) => e.key === 'jur' && e.code === 'required')
  assert.throws(() => normalizeInputs({ ...base, mau: '' }), (e) => e.key === 'mau' && e.code === 'required')
  assert.throws(() => normalizeInputs({ ...base, rails: ['apple'], rev: 0 }), (e) => e.key === 'rev' && e.code === 'required')
  assert.throws(() => normalizeInputs({ ...base, rails: 'apple,steam' }), (e) => e.key === 'rails' && e.code === 'invalid')
  assert.throws(() => normalizeInputs({ ...base, eng_accounts: '7' }), (e) => e.key === 'eng_accounts' && e.code === 'invalid')
  const ok = normalizeInputs({ mau: '1,000', posts_per_user: '', jur: 'us,eu' })
  assert.equal(ok.mau, 1000)
  assert.equal(ok.posts_per_user, 20)
  assert.equal(ok.eng_accounts, null)
  assert.deepEqual(ok.jur, ['eu', 'us'])
  assert.equal(Object.keys(ok).length, Object.keys(INPUTS).length)
})

await test('compact money keeps whole numbers whole and drops only decimal zeros', () => {
  assert.equal(compact(210350), '$210k')
  assert.equal(compact(100000), '$100k')
  assert.equal(compact(1000), '$1k')
  assert.equal(compact(1500000), '$1.5M')
  assert.equal(compact(4990000), '$4.99M')
  assert.equal(compact(20000), '$20k')
  assert.equal(compact(968000), '$968k')
  assert.equal(compact(950), '$950')
  assert.equal(compact(-276000), '-$276k')
})

await test('a baseline printout, for the eye', () => {
  const r = calculate(base, data).typical
  const f = (n) => Math.round(n).toLocaleString('en-US').padStart(12)
  for (const l of LINES) console.log(`     ${l.padEnd(11)} ${f(r.lines[l].custodial)} ${f(r.lines[l].noncustodial)}`)
  console.log(`     ${'total'.padEnd(11)} ${f(r.totals.custodial)} ${f(r.totals.noncustodial)}   per MAU ${r.totals.per_mau_custodial.toFixed(2)} → ${r.totals.per_mau_noncustodial.toFixed(2)}`)
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
