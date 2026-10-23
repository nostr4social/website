// Tests for the cost model and the results-link codec. Pure Node, no browser.
//
//   npm run test:model

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const data = JSON.parse(await readFile(resolve(root, '_data/assumptions/v1.json'), 'utf8'))
const { calculate, evaluate, resolveAssumptions, project, rampShare, LINES, SCENARIOS, YEARS, MARKER_YEAR, normalizeInputs } = await import(resolve(root, 'assets/js/calculator/src/model.js'))
const { encode, decode } = await import(resolve(root, 'assets/js/calculator/src/codec.js'))
const { INPUTS, InputError } = await import(resolve(root, 'assets/js/calculator/src/inputs.js'))
const { compact, compactNumber } = await import(resolve(root, 'assets/js/calculator/src/format.js'))

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
  assert.equal(compactNumber(50000), '50k')
  assert.equal(compactNumber(62500), '62.5k')
  assert.equal(compactNumber(1200000), '1.2M')
  assert.equal(compactNumber(950), '950')
})

// ── the projection ───────────────────────────────────────────────────────────

const typicalV = (over = {}) => ({ ...resolveAssumptions(data, 'typical'), ...over })

await test('with no growth and no ramp, the saving cumulates in a straight line', () => {
  const inputs = normalizeInputs({ ...base, growth: '0' })
  const v = typicalV({ migration_months: 0 })
  const p = project(inputs, v)
  const annual = evaluate(inputs, v).totals.saving
  assert.equal(p.length, YEARS + 1)
  for (let y = 0; y <= YEARS; y++) {
    assert.equal(p[y].users, inputs.mau)
    assert.ok(Math.abs(p[y].cumulative - annual * y) < 1e-6, `year ${y}`)
  }
})

await test('the ramp is front-loaded: a twelve-month one realises two thirds of the first year and all of the second', () => {
  assert.ok(Math.abs(rampShare(1, 12) - 2 / 3) < 0.01, String(rampShare(1, 12)))
  assert.equal(rampShare(2, 12), 1)
  assert.ok(Math.abs(rampShare(1, 24) - 0.4167) < 0.01, String(rampShare(1, 24)))
  assert.ok(Math.abs(rampShare(2, 24) - 0.9167) < 0.01, String(rampShare(2, 24)))
  assert.ok(rampShare(1, 24) > 0.25, 'more than a linear ramp would')
  assert.equal(rampShare(1, 0), 1)
  assert.equal(rampShare(3, 6), 1)
})

await test('growth compounds and decays; users are whole', () => {
  const inputs = normalizeInputs({ ...base, growth: '1' })
  const p = project(inputs, typicalV({ growth_decay: 0.5 }))
  assert.equal(p[1].users, 100000)
  assert.equal(p[2].users, 150000)
  assert.equal(p[3].users, 187500)
  for (const q of p) assert.ok(Number.isInteger(q.users))
})

await test('a flat app saves the same each year after the ramp, so its curve bends only at the start', () => {
  const inputs = normalizeInputs({ ...base, growth: '0' })
  const p = project(inputs, typicalV({ migration_months: 12 }))
  assert.ok(p[1].realised < p[2].realised - 1)
  for (let y = 3; y <= YEARS; y++) assert.ok(Math.abs(p[y].realised - p[2].realised) < 1e-6)
})

await test('fixed program fees do not scale with users; per-user costs do', () => {
  const inputs = normalizeInputs({ ...base, growth: '1', jur: ['uk'] })
  const v = typicalV({ growth_decay: 1 })
  const now = evaluate(inputs, v)
  const later = evaluate({ ...inputs, mau: inputs.mau * 2, rev: inputs.rev * 2 }, v)
  const osaNow = now.lines.compliance.parts.find((x) => x.id === 'privacy_programs').custodial
  const osaLater = later.lines.compliance.parts.find((x) => x.id === 'privacy_programs').custodial
  assert.equal(osaNow, osaLater)
  const authNow = now.lines.accounts.parts.find((x) => x.id === 'auth').custodial
  const authLater = later.lines.accounts.parts.find((x) => x.id === 'auth').custodial
  assert.ok(Math.abs(authLater - 2 * authNow) < 1e-6)
})

await test('the growth default applies only when growth is not given', () => {
  const given = project(normalizeInputs({ ...base, growth: '0.5' }), typicalV({ growth_default: 0 }))
  const blank = project(normalizeInputs(base), typicalV({ growth_default: 0 }))
  assert.ok(given[1].users > blank[1].users)
  assert.equal(blank[1].users, base.mau)
})

await test('calculate carries the projection and the five- and three-year totals, low ≤ typical ≤ high', () => {
  const r = calculate({ ...base, growth: '0.25' }, data)
  for (const s of SCENARIOS) {
    assert.equal(r[s].projection.length, YEARS + 1)
    assert.equal(r[s].totals.five_year, r[s].projection[YEARS].cumulative)
    assert.equal(r[s].totals.marker_year, r[s].projection[MARKER_YEAR].cumulative)
    assert.ok(r[s].projection[YEARS].cumulative > r[s].projection[MARKER_YEAR].cumulative)
    let sum = 0
    for (const p of r[s].projection) {
      sum += p.realised
      assert.ok(Math.abs(p.cumulative - sum) < 1e-6)
    }
  }
  assert.ok(r.low.totals.five_year <= r.typical.totals.five_year && r.typical.totals.five_year <= r.high.totals.five_year)
  assert.ok(r.low.totals.five_year > 0, 'even the low case saves something')
})

await test('the Nostr path starts at today\'s cost and the gaps add up to the cumulative', () => {
  const r = calculate({ ...base, growth: '0.25' }, data).typical
  const p = r.projection
  assert.equal(p[0].path, p[0].custodial)
  assert.ok(p[1].path < p[0].path, 'the path falls during migration')
  assert.ok(p[2].path <= p[2].noncustodial + 1e-6 && p[2].path >= p[2].noncustodial - 1e-6, 'once migrated, the path is the non-custodial cost')
  let gaps = 0
  for (const q of p) gaps += q.custodial - q.path
  assert.ok(Math.abs(gaps - r.totals.five_year) < 1e-6)
})

await test('growth is a band, and an unknown band is refused', () => {
  assert.equal(normalizeInputs({ ...base, growth: '0.25' }).growth, '0.25')
  assert.equal(normalizeInputs(base).growth, null)
  assert.throws(() => normalizeInputs({ ...base, growth: '0.3' }), (e) => e instanceof InputError && e.key === 'growth')
  const q = encode(normalizeInputs({ ...base, growth: '0' }))
  assert.ok(q.includes('growth=0'), q)
  assert.equal(decode(`?${q}`).inputs.growth, '0')
})

await test('a baseline printout, for the eye', () => {
  const r = calculate(base, data).typical
  const f = (n) => Math.round(n).toLocaleString('en-US').padStart(12)
  for (const l of LINES) console.log(`     ${l.padEnd(11)} ${f(r.lines[l].custodial)} ${f(r.lines[l].noncustodial)}`)
  console.log(`     ${'total'.padEnd(11)} ${f(r.totals.custodial)} ${f(r.totals.noncustodial)}   per MAU ${r.totals.per_mau_custodial.toFixed(2)} → ${r.totals.per_mau_noncustodial.toFixed(2)}`)
  for (const p of r.projection) console.log(`     year ${p.year}  ${String(p.users).padStart(9)} users  saved ${f(p.realised)}  so far ${f(p.cumulative)}`)
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
