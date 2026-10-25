// Tests for the cost model and the results-link codec. Pure Node, no browser.
//
//   npm run test:model

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const data = JSON.parse(await readFile(resolve(root, '_data/assumptions/v2.json'), 'utf8'))
const { calculate, evaluate, resolveAssumptions, varyingKeys, jurShares, ccpaApplies, calendarYear, project, rampShare, nudge, deriveInputs, applyKind, LINE_FUNCTIONS, PART_ASSUMPTIONS, LINES, SCENARIOS, JURISDICTIONS, YEARS, MARKER_YEAR, normalizeInputs } = await import(resolve(root, 'assets/js/calculator/src/model.js'))
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

const base = { mau: 50000, posts_per_user: 20, team: 'ten', eng_accounts: '5', eng_content: '25', eng_infra: '25', mod_who: 'team', mod_heads: '3', rails: ['apple', 'google', 'processor'], rev: 20000, jur: ['eu', 'uk', 'us'] }
const min = (extra = {}) => ({ mau: 50000, jur: ['us'], team: 'ten', ...extra })
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

await test('low is the smaller saving: the custodial column is the same in every scenario, the Nostr column falls from low to high', () => {
  const r = calculate(base, data)
  for (const l of LINES) {
    assert.ok(Math.abs(r.low.lines[l].custodial - r.typical.lines[l].custodial) < 1e-6, `${l} custodial low = typical`)
    assert.ok(Math.abs(r.high.lines[l].custodial - r.typical.lines[l].custodial) < 1e-6, `${l} custodial high = typical`)
    assert.ok(r.low.lines[l].noncustodial >= r.typical.lines[l].noncustodial - 1e-6, `${l} non-custodial low ≥ typical`)
    assert.ok(r.typical.lines[l].noncustodial >= r.high.lines[l].noncustodial - 1e-6, `${l} non-custodial typical ≥ high`)
    assert.ok(r.low.lines[l].at_scale <= r.typical.lines[l].at_scale + 1e-6 && r.typical.lines[l].at_scale <= r.high.lines[l].at_scale + 1e-6, `${l} saving low ≤ typical ≤ high`)
  }
  assert.ok(Math.abs(r.low.totals.custodial - r.typical.totals.custodial) < 1e-6 && Math.abs(r.high.totals.custodial - r.typical.totals.custodial) < 1e-6)
  assert.ok(r.low.totals.saving <= r.typical.totals.saving && r.typical.totals.saving <= r.high.totals.saving)
  assert.ok(r.low.totals.at_scale <= r.typical.totals.at_scale && r.typical.totals.at_scale <= r.high.totals.at_scale)
})

await test('only the thesis varies across scenarios: no custodial-side assumption moves, and every varying one is at-scale or Nostr-native', () => {
  const vary = varyingKeys(data)
  assert.ok(vary.length >= 15, `${vary.length} varying keys`)
  const thesis = /^(scale_months|.*_remains_share|media_sponsor_share|retained_data_share|.*_per_mau_year|relay_floor_year|lightning_rate)$/
  for (const key of vary) assert.ok(thesis.test(key), `${key} varies but is not a thesis key`)
  // The custodial side's own rates never vary, whatever the file says in its low and high columns.
  for (const key of ['eng_base_salary', 'egress_gb', 'blob_gb_month', 'dsar_cost', 'dsar_rate_per_mau_year', 'breach_prob_year', 'verify_share_us', 'gdpr_program_year', 'apple_rate_standard', 'growth_default', 'growth_decay', 'compute_per_mau_year', 'auth_per_mau_month']) {
    assert.ok(!vary.includes(key), `${key} must not vary`)
  }
  const resolved = Object.fromEntries(SCENARIOS.map((s) => [s, resolveAssumptions(data, s)]))
  for (const key of Object.keys(data.assumptions)) {
    if (vary.includes(key)) continue
    assert.equal(resolved.low[key], resolved.typical[key], `${key} low`)
    assert.equal(resolved.high[key], resolved.typical[key], `${key} high`)
  }
  for (const key of vary) {
    assert.equal(resolved.low[key], data.assumptions[key].low, `${key} low`)
    assert.equal(resolved.high[key], data.assumptions[key].high, `${key} high`)
  }
  // Every varying key's low is the smaller saving: a larger remains share, a larger fee, a slower ramp.
  for (const key of vary) {
    const a = data.assumptions[key]
    assert.ok(a.low >= a.typical && a.typical >= a.high, `${key}: low ${a.low} ≥ typical ${a.typical} ≥ high ${a.high}`)
  }
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

await test('nobody reviewing content yields an implied, non-zero moderation cost; a team or a vendor is priced by head', () => {
  const r = calculate({ ...base, mod_who: 'nobody', mod_heads: null }, data).typical.lines.moderation
  assert.equal(r.implied, true)
  assert.ok(r.custodial > 0)
  const unsaid = calculate({ ...base, mod_who: null, mod_heads: null }, data).typical.lines.moderation
  assert.equal(unsaid.implied, true)
  const team = calculate({ ...base, mod_who: 'team', mod_heads: '15' }, data).typical.lines.moderation
  const vendor = calculate({ ...base, mod_who: 'vendor', mod_heads: '15' }, data).typical.lines.moderation
  assert.ok(team.custodial > vendor.custodial && team.implied === false && vendor.implied === false, 'a loaded employee costs more than a vendor seat')
  const few = calculate({ ...base, mod_who: 'team', mod_heads: '3' }, data).typical.lines.moderation
  assert.ok(team.custodial > few.custodial)
})

await test('the openers set the defaults; what was derived is listed and stays out of the inputs; the team size is never assumed', () => {
  const v = resolveAssumptions(data, 'typical')
  assert.throws(() => normalizeInputs({ mau: 50000, jur: ['us'] }), (e) => e instanceof InputError && e.key === 'team' && e.code === 'required', 'the team is a required opener')
  const minimal = normalizeInputs(min())
  const eff = deriveInputs(minimal, v)
  assert.equal(eff.posts_per_user, v.posts_default)
  assert.equal(eff.mb, v.mb_default)
  assert.ok(Math.abs(eff.eng_content - v.default_hours_content * v.team_factor_ten) < 1e-9, 'the default hours follow the team size given')
  assert.equal(eff.team, 'ten')
  assert.equal(eff.nostr_now, '0')
  assert.equal(eff.growth, String(v.growth_default))
  assert.equal(v.growth_default, 0, 'an app that does not say is held flat')
  const derivedKeys = Object.keys(eff.derived).sort()
  assert.deepEqual(derivedKeys.filter((k) => !/^n_/.test(k)), ['eng_accounts', 'eng_content', 'eng_infra', 'eng_legal', 'growth', 'mb', 'nostr_now', 'posts_per_user'])
  assert.equal(eff.derived.eng_content, 'team')
  assert.equal(derivedKeys.filter((k) => /^n_/.test(k)).length, 10, 'the whole grid follows the blank opener')
  assert.equal(minimal.posts_per_user, null, 'the clean inputs still say nothing')
  assert.equal(minimal.team, 'ten')

  const kind = deriveInputs(normalizeInputs(min({ kind: 'messaging' })), v)
  assert.equal(kind.posts_per_user, v.kind_messaging_posts)
  assert.equal(kind.mb, v.kind_messaging_mb)
  assert.equal(kind.derived.posts_per_user, 'kind')

  const team = deriveInputs(normalizeInputs(min({ team: 'fifty', eng_infra: '60' })), v)
  assert.ok(Math.abs(team.eng_content - v.default_hours_content * v.team_factor_fifty) < 1e-9)
  assert.equal(team.eng_infra, '60', 'a given band is kept')
  assert.equal(team.derived.eng_content, 'team')
  assert.equal(team.derived.eng_infra, undefined)

  const heads = deriveInputs(normalizeInputs(min({ mod_who: 'vendor' })), v)
  assert.equal(heads.mod_heads, v.mod_heads_default)
  const nobody = deriveInputs(normalizeInputs(min({ mod_who: 'nobody' })), v)
  assert.equal(nobody.mod_heads, null)

  const rails = deriveInputs(normalizeInputs(min({ rev: 5000, distribution: ['apple', 'web'] })), v)
  assert.deepEqual(rails.rails, ['apple', 'processor'])
  const everywhere = deriveInputs(normalizeInputs(min({ rev: 5000 })), v)
  assert.deepEqual(everywhere.rails, ['apple', 'google', 'processor'])
  const none = deriveInputs(normalizeInputs(min({ rev: 0 })), v)
  assert.deepEqual(none.rails, [])

  const nostr = deriveInputs(normalizeInputs(min({ nostr_now: '1', n_feeds: '0.5' })), v)
  assert.equal(nostr.n_keys, '1')
  assert.equal(nostr.n_raw_keys, '0', 'a Nostr app is assumed not to handle raw keys')
  assert.equal(nostr.n_feeds, '0.5', 'a given row is kept')
  assert.equal(nostr.derived.n_keys, 'nostr_now')
  assert.equal(nostr.derived.nostr_now, undefined, 'the opener was answered')

  // The result echoes the clean inputs; only what was said travels in a link.
  const r = calculate(min({ team: 'one', kind: 'feed' }), data)
  const q = encode(r.inputs, {}, data.version)
  assert.ok(q.includes('team=one') && q.includes('kind=feed') && !q.includes('eng_') && !q.includes('posts_per_user=') && q.endsWith('v=2'), q)
  assert.equal(r.typical.effective.derived.eng_accounts, 'team')
  assert.ok(r.typical.totals.custodial > 0)
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

await test('the regions chosen are weighted by their users; the verification share is the weighted mean, not the strictest', () => {
  const v = resolveAssumptions(data, 'typical')
  const one = jurShares(normalizeInputs(min()), v)
  assert.deepEqual(one, { eu: 0, uk: 0, us: 1, other: 0 })
  const two = jurShares(normalizeInputs(min({ jur: ['uk', 'us'] })), v)
  assert.ok(Math.abs(two.uk - v.jur_weight_uk / (v.jur_weight_uk + v.jur_weight_us)) < 1e-9)
  assert.ok(Math.abs(two.uk + two.us - 1) < 1e-9 && two.eu === 0 && two.other === 0)
  const all = jurShares(normalizeInputs(min({ jur: JURISDICTIONS })), v)
  assert.ok(Math.abs(JURISDICTIONS.reduce((a, j) => a + all[j], 0) - 1) < 1e-9)
  const uk = calculate({ ...base, jur: ['uk', 'us'] }, data).typical.lines.accounts.parts.find((p) => p.id === 'verify')
  const expected = two.uk * v.verify_share_uk + two.us * v.verify_share_us
  assert.ok(Math.abs(uk.rate - expected) < 1e-9, `${uk.rate} vs ${expected}`)
  assert.ok(uk.rate < Math.max(v.verify_share_uk, v.verify_share_us) && uk.rate > Math.min(v.verify_share_uk, v.verify_share_us))
  // Adding a region with a lower rate lowers the share; the old max() could never do that.
  const more = calculate({ ...base, jur: ['uk', 'us', 'other'] }, data).typical.lines.accounts.parts.find((p) => p.id === 'verify')
  assert.ok(more.rate < uk.rate)
  // Weights are not scenarios: the same in low and high.
  for (const s of SCENARIOS) assert.deepEqual(jurShares(normalizeInputs(min({ jur: ['uk', 'us'] })), resolveAssumptions(data, s)), two)
})

await test('the CCPA threshold counts California consumers: US users times the Californian share, not total MAU', () => {
  const v = resolveAssumptions(data, 'typical')
  const at = Math.ceil(v.ccpa_consumer_threshold / v.ca_share_of_us_users)
  assert.ok(at > 800000 && at < 900000, `a US-only app crosses at about ${at} users`)
  const below = calculate(min({ mau: at - 1 }), data).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  const above = calculate(min({ mau: at }), data).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  assert.equal(below.us_tier, 'small')
  assert.equal(above.us_tier, 'large')
  assert.equal(below.usp, v.us_privacy_year_small)
  assert.equal(above.usp, v.us_privacy_year_large)
  assert.equal(calculate(min({ mau: 100000 }), data).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs').us_tier, 'small', '100k total users is not 100k Californians')
  // With the EU and the UK in the mix the US share of users is smaller, so the threshold sits higher.
  assert.equal(ccpaApplies(normalizeInputs(min({ mau: at })), v), true)
  assert.equal(ccpaApplies(normalizeInputs(min({ mau: at, jur: ['eu', 'us'] })), v), false)
  assert.equal(ccpaApplies(normalizeInputs(min({ mau: 10000000, jur: ['eu'] })), v), false, 'no US users, no CCPA')
})

await test('access requests come from EU and UK users always, from US users only once the CCPA applies, and fall with the data retained', () => {
  const v = resolveAssumptions(data, 'typical')
  const dsar = (inputs) => calculate(inputs, data).typical.lines.compliance.parts.find((p) => p.id === 'dsar')
  const usSmall = dsar(min({ mau: 50000 }))
  assert.equal(usSmall.custodial, 0, 'a US-only app below the threshold serves no requests')
  assert.equal(usSmall.noncustodial, 0)
  const usLarge = dsar(min({ mau: 1000000 }))
  assert.ok(Math.abs(usLarge.custodial - 1000000 * v.dsar_rate_per_mau_year * v.dsar_cost) < 1e-6)
  assert.ok(Math.abs(usLarge.noncustodial - usLarge.custodial * v.retained_data_share) < 1e-6, 'at scale the requests fall with the data retained, not to zero')
  const eu = dsar(min({ mau: 50000, jur: ['eu'] }))
  assert.ok(Math.abs(eu.custodial - 50000 * v.dsar_rate_per_mau_year * v.dsar_cost) < 1e-6, 'every EU user is under the GDPR')
  const mixed = dsar(min({ mau: 50000, jur: ['eu', 'us'] }))
  const shares = jurShares(normalizeInputs(min({ mau: 50000, jur: ['eu', 'us'] })), v)
  assert.ok(Math.abs(mixed.users - 50000 * shares.eu) < 1e-6, 'only the EU share counts while the US is below the threshold')
  assert.equal(dsar(min({ mau: 50000, jur: ['other'] })).custodial, 0)
})

await test('an override applies to every scenario and an unknown or negative one is ignored', () => {
  const r = calculate({ ...base, mb: 50 }, data, { blob_gb_month: 0.5, nonsense: 1, egress_gb: -1 })
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
  assert.equal(back.version, 2)
  assert.equal(back.test, '1')
  assert.equal(back.present, true)
  assert.equal(decode('?test=1').present, false)
  const zeros = encode(calculate({ ...base, n_keys: '0', eng_legal: '0' }, data).inputs, {}, data.version)
  assert.ok(!zeros.includes('n_keys=') && zeros.includes('eng_legal=0'), zeros)
  // A version-1 link: its overrides for keys that no longer exist are dropped, and it runs under the current file.
  const old = decode('?mau=50000&jur=us&team=ten&a.migration_months=6&a.relay_cost_year=100&a.blob_gb_month=0.5&v=1')
  assert.equal(old.version, 1)
  const under = calculate(old.inputs, data, old.overrides)
  assert.deepEqual(Object.keys(under.overrides), ['blob_gb_month'])
  assert.equal(under.version, 2)
})

await test('validation names the first bad input', () => {
  assert.throws(() => normalizeInputs({ ...base, mau: 'abc' }), (e) => e instanceof InputError && e.key === 'mau' && e.code === 'not_a_number')
  assert.throws(() => normalizeInputs({ ...base, mau: 0 }), (e) => e.key === 'mau' && e.code === 'too_small')
  assert.throws(() => normalizeInputs({ ...base, jur: [] }), (e) => e.key === 'jur' && e.code === 'required')
  assert.throws(() => normalizeInputs({ ...base, mau: '' }), (e) => e.key === 'mau' && e.code === 'required')
  assert.throws(() => normalizeInputs({ ...base, rails: 'apple,steam' }), (e) => e.key === 'rails' && e.code === 'invalid')
  assert.throws(() => normalizeInputs({ ...base, eng_accounts: '7' }), (e) => e.key === 'eng_accounts' && e.code === 'invalid')
  assert.throws(() => normalizeInputs({ ...base, team: '' }), (e) => e.key === 'team' && e.code === 'required')
  const ok = normalizeInputs({ mau: '1,000', posts_per_user: '', jur: 'us,eu', team: 'ten' })
  assert.equal(ok.mau, 1000)
  assert.equal(ok.posts_per_user, null, 'blank until the model derives it')
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
  const v = typicalV({ scale_months: 0 })
  const p = project(inputs, v)
  const annual = evaluate(inputs, v).totals.saving
  assert.equal(p.length, YEARS + 1)
  for (let y = 0; y <= YEARS; y++) {
    assert.equal(p[y].users, inputs.mau)
    assert.ok(Math.abs(p[y].cumulative - annual * y) < 1e-6, `year ${y}`)
  }
})

await test('the ramp is front-loaded: over thirty-six months it realises about 30%, 74% and 96% of the three years, and all of the fourth', () => {
  assert.ok(Math.abs(rampShare(1, 36) - 0.296) < 0.01, String(rampShare(1, 36)))
  assert.ok(Math.abs(rampShare(2, 36) - 0.741) < 0.01, String(rampShare(2, 36)))
  assert.ok(Math.abs(rampShare(3, 36) - 0.963) < 0.01, String(rampShare(3, 36)))
  assert.equal(rampShare(4, 36), 1)
  assert.ok(rampShare(1, 48) < rampShare(1, 36) && rampShare(1, 24) > rampShare(1, 36), 'slower is the smaller saving')
  assert.ok(rampShare(1, 36) > 1 / 6, 'more than a linear ramp would')
  assert.ok(Math.abs(rampShare(1, 12) - 2 / 3) < 0.01, String(rampShare(1, 12)))
  assert.equal(rampShare(2, 12), 1)
  assert.equal(rampShare(1, 0), 1)
  assert.equal(rampShare(3, 6), 1)
  assert.equal(data.assumptions.scale_months.typical, 36, "Nostr4's estimate: three years to Nostr at scale")
  assert.ok(data.assumptions.scale_months.low > 36 && data.assumptions.scale_months.high < 36, 'slower is the smaller saving')
})

await test('the calendar: year 0 is the start, the first yearly mark is 2028 and Nostr is at scale in 2030', () => {
  const r = calculate(base, data)
  assert.equal(r.start_year, 2027)
  assert.deepEqual([1, 2, 3, 4, 5].map((y) => calendarYear(r.start_year, y)), [2028, 2029, 2030, 2031, 2032])
  assert.equal(MARKER_YEAR, 3)
  assert.equal(calendarYear(r.start_year, MARKER_YEAR), 2030)
  assert.equal(r.typical.projection[MARKER_YEAR].year, MARKER_YEAR)
})

await test('"at scale" is the marker year\'s column: the saving between the two costs that year, and the lines and their parts add up to it', () => {
  const r = calculate({ ...base, growth: '0.25' }, data)
  for (const s of SCENARIOS) {
    const T = r[s].totals
    const at = r[s].projection[MARKER_YEAR]
    assert.equal(T.at_scale, at.realised)
    assert.equal(T.scale_custodial, at.custodial)
    assert.equal(T.scale_nostr, at.path)
    assert.equal(T.scale_users, at.users)
    assert.ok(Math.abs(T.at_scale - (T.scale_custodial - T.scale_nostr)) < 1e-6, 'the figure is the gap between the two dots')
    assert.ok(Math.abs(T.scale_per_mau_custodial - at.custodial / at.users) < 1e-9 && Math.abs(T.scale_per_mau_nostr - at.path / at.users) < 1e-9, 'per user that year, at that year\'s users')
    const sum = LINES.reduce((acc, l) => acc + r[s].lines[l].at_scale, 0)
    assert.ok(Math.abs(sum - T.at_scale) < 1e-6, `${s}: ${sum} vs ${T.at_scale}`)
    for (const l of LINES) {
      const line = r[s].lines[l]
      assert.ok(line.at_scale >= -1e-6, `${l} never negative`)
      const parts = line.parts.reduce((acc, p) => acc + p.scale_custodial - p.scale_noncustodial, 0)
      assert.ok(Math.abs(parts - line.at_scale) < 1e-6, `${s}.${l}: parts ${parts} vs ${line.at_scale}`)
      assert.ok(Math.abs(line.scale_custodial - line.scale_noncustodial - line.at_scale) < 1e-6)
    }
  }
  // With growth, the at-scale figure is the saving at year three's users, not today's.
  assert.ok(r.typical.totals.at_scale > r.typical.totals.saving)
  // Flat, it is that year's share of the ramp (almost all of it) times today's saving.
  const flat = calculate({ ...base, growth: '0' }, data).typical.totals
  assert.ok(Math.abs(flat.at_scale - rampShare(MARKER_YEAR, data.assumptions.scale_months.typical) * flat.saving) < 1e-6)
  assert.ok(flat.at_scale > 0.95 * flat.saving && flat.at_scale < flat.saving)
  assert.ok(r.low.totals.at_scale <= r.typical.totals.at_scale && r.typical.totals.at_scale <= r.high.totals.at_scale)
  assert.ok(r.low.totals.scale_nostr >= r.typical.totals.scale_nostr && r.typical.totals.scale_nostr >= r.high.totals.scale_nostr, 'the Nostr cost at scale is largest in the low case')
})

await test('growth compounds and decays; users are whole', () => {
  const inputs = normalizeInputs({ ...base, growth: '1' })
  const p = project(inputs, typicalV({ growth_decay: 0.5 }))
  assert.equal(p[1].users, 100000)
  assert.equal(p[2].users, 150000)
  assert.equal(p[3].users, 187500)
  for (const q of p) assert.ok(Number.isInteger(q.users))
})

await test('a flat app saves the same each year once the network is at scale, so its curve bends only at the start', () => {
  const inputs = normalizeInputs({ ...base, growth: '0' })
  const p = project(inputs, typicalV({ scale_months: 12 }))
  assert.ok(p[1].realised < p[2].realised - 1)
  for (let y = 3; y <= YEARS; y++) assert.ok(Math.abs(p[y].realised - p[2].realised) < 1e-6)
  const slow = project(inputs, typicalV())
  assert.ok(slow[1].realised < slow[2].realised && slow[2].realised < slow[3].realised && slow[3].realised < slow[4].realised - 1)
  assert.ok(Math.abs(slow[5].realised - slow[4].realised) < 1e-6, 'at scale from the fourth year on')
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
  assert.ok(p[1].path < p[0].path, 'the path falls as the network scales')
  assert.ok(p[4].path <= p[4].noncustodial + 1e-6 && p[4].path >= p[4].noncustodial - 1e-6, 'once at scale, the path is the non-custodial cost')
  assert.ok(p[3].path > p[3].noncustodial && p[3].path - p[3].noncustodial < 0.05 * p[3].saving, 'the marker year is within a few percent of it')
  let gaps = 0
  for (const q of p) gaps += q.custodial - q.path
  assert.ok(Math.abs(gaps - r.totals.five_year) < 1e-6)
})

await test('the lines\' five-year savings add up to the five-year total, in every scenario', () => {
  const r = calculate({ ...base, growth: '0.25' }, data)
  for (const s of SCENARIOS) {
    const sum = LINES.reduce((acc, l) => acc + r[s].lines[l].five_year, 0)
    assert.ok(Math.abs(sum - r[s].totals.five_year) < 1e-6, `${s}: ${sum} vs ${r[s].totals.five_year}`)
    for (const l of LINES) assert.ok(r[s].lines[l].five_year >= -1e-6, `${l} never negative`)
  }
})

await test('a payments line on store rails alone gets a peer-to-peer nudge; one with a p2p rail does not', () => {
  const stores = calculate({ ...base, rails: ['apple', 'google'], rev: 10000 }, data).typical
  assert.ok(stores.lines.payments.nudge && stores.lines.payments.nudge.id === 'p2p' && stores.lines.payments.nudge.amount > 0, JSON.stringify(stores.lines.payments.nudge))
  assert.ok(stores.lines.payments.at_scale < 1, 'the line itself saves nothing')
  const p2p = calculate({ ...base, rails: ['apple', 'p2p'], rev: 10000 }, data).typical
  assert.equal(p2p.lines.payments.nudge, null)
  const none = calculate({ ...base, rails: [], rev: 0 }, data).typical
  assert.equal(none.lines.payments.nudge, null)
  const processor = calculate({ ...base, rails: ['processor'], rev: 10000 }, data).typical
  assert.equal(processor.lines.payments.nudge, null, 'a processor rail already saves')
  assert.equal(nudge('accounts', normalizeInputs(base), resolveAssumptions(data, 'typical'), stores.lines.accounts), null)
})

await test('what remains on Nostr follows what the app hosts: age checks, moderation, tooling and content law keep only a share', () => {
  const v = resolveAssumptions(data, 'typical')
  const r = evaluate(normalizeInputs({ ...base, jur: ['uk', 'us'], mod_who: 'team', mod_heads: '3' }), v)
  const verify = r.lines.accounts.parts.find((p) => p.id === 'verify')
  assert.ok(Math.abs(verify.noncustodial - verify.custodial * v.verify_remains_share) < 1e-6)
  const tooling = r.lines.moderation.parts.find((p) => p.id === 'tooling')
  assert.ok(Math.abs(tooling.noncustodial - tooling.custodial * v.tooling_remains_share) < 1e-6)
  const labels = r.lines.moderation.parts.find((p) => p.id === 'labels')
  assert.equal(labels.custodial, 0)
  assert.ok(labels.noncustodial > 0, 'a label provider is the Nostr-native cost')
  const programs = r.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  const contentLaw = v.uk_osa_year
  assert.ok(Math.abs(programs.noncustodial - (contentLaw * v.content_law_remains_share + (v.gdpr_program_year + v.us_privacy_year_small) * v.privacy_remains_share)) < 1e-6)
  // In the high scenario no age check remains, yet the accounts line still costs something on Nostr.
  const high = evaluate(normalizeInputs({ ...base, jur: ['uk'] }), resolveAssumptions(data, 'high'))
  assert.equal(high.lines.accounts.parts.find((p) => p.id === 'verify').noncustodial, 0)
  assert.ok(high.lines.accounts.noncustodial > 0)
  // Engineering on accounts and infrastructure keeps a share: a Nostr app still builds signer login and relay handling.
  const acc = r.lines.accounts.parts.find((p) => p.id === 'engineering')
  assert.ok(Math.abs(acc.noncustodial - acc.custodial * v.accounts_eng_remains_share) < 1e-6 && acc.noncustodial > 0)
  const infra = r.lines.storage.parts.find((p) => p.id === 'engineering')
  assert.ok(Math.abs(infra.noncustodial - infra.custodial * v.infra_eng_remains_share) < 1e-6 && infra.noncustodial > 0)
})

await test('relays of your own scale with users, never below the floor', () => {
  const v = resolveAssumptions(data, 'typical')
  const relay = (mau) => calculate(min({ mau }), data).typical.lines.storage.parts.find((p) => p.id === 'relay')
  const small = relay(1000)
  assert.equal(small.noncustodial, v.relay_floor_year)
  assert.equal(small.floor, true)
  const big = relay(1000000)
  assert.ok(Math.abs(big.noncustodial - 1000000 * v.relay_per_mau_year) < 1e-6)
  assert.equal(big.floor, false)
  assert.equal(small.custodial, 0)
})

await test('the expected breach loss is marked as risk, apart from the cash costs', () => {
  const r = calculate(base, data).typical.lines.compliance
  const breach = r.parts.find((p) => p.id === 'breach')
  assert.equal(breach.kind, 'risk')
  assert.ok(r.parts.filter((p) => p.kind === 'risk').length === 1 && r.parts.filter((p) => p.kind !== 'risk').length === 4)
  for (const l of LINES) if (l !== 'compliance') for (const p of calculate(base, data).typical.lines[l].parts) assert.notEqual(p.kind, 'risk')
})

await test('the kind of app sets egress and compute per user, unless the visitor overrode them', () => {
  const v = resolveAssumptions(data, 'typical')
  const feed = applyKind(v, 'feed')
  assert.equal(feed.values.egress_gb_per_mau_month, v.kind_feed_egress_gb)
  assert.equal(feed.values.compute_per_mau_year, v.kind_feed_compute)
  assert.deepEqual(feed.set, { egress_gb_per_mau_month: 'kind', compute_per_mau_year: 'kind' })
  const none = applyKind(v, null)
  assert.equal(none.values.egress_gb_per_mau_month, v.egress_gb_per_mau_month)
  assert.deepEqual(none.set, {})
  const kept = applyKind(v, 'feed', { egress_gb_per_mau_month: 9 })
  assert.equal(kept.values.egress_gb_per_mau_month, v.egress_gb_per_mau_month, 'the override is applied by resolveAssumptions; the kind leaves it alone')
  assert.deepEqual(Object.keys(kept.set), ['compute_per_mau_year'])

  const messaging = calculate(min({ kind: 'messaging' }), data).typical
  const media = calculate(min({ kind: 'feed' }), data).typical
  assert.ok(media.lines.storage.custodial > messaging.lines.storage.custodial * 1.5, `a media feed costs far more to serve: ${media.lines.storage.custodial} vs ${messaging.lines.storage.custodial}`)
  assert.ok(media.totals.five_year > messaging.totals.five_year * 1.1, 'and it shows in the five-year figure')
  assert.equal(media.derived.egress_gb_per_mau_month, 'kind')
  assert.equal(media.values.egress_gb_per_mau_month, v.kind_feed_egress_gb)
})

await test('the part → assumptions map says exactly which assumptions each line reads', () => {
  // Inputs that walk every branch: all regions, every rail, balances held, given and defaulted bands, reported spend or not, above and below the CCPA threshold.
  const variants = [
    normalizeInputs({ ...base, jur: ['eu', 'uk', 'us', 'other'], rails: ['p2p', 'apple', 'google', 'processor', 'reseller'], rev: 50000, balances: ['yes'], mod_who: 'team', mod_heads: '15' }),
    normalizeInputs({ ...base, mod_who: 'vendor', mod_heads: '3' }),
    normalizeInputs({ mau: 10000000, jur: ['us'], team: 'more', rails: ['apple'], rev: 200000, legal_usd: 50000 }),
    normalizeInputs({ mau: 1000, jur: ['other'], team: 'one' }),
    normalizeInputs({ mau: 1000, jur: ['other'], team: 'one', rails: ['google'], rev: 200000 }),
  ]
  const v = resolveAssumptions(data, 'typical')
  for (const line of LINES) {
    const read = new Set()
    const recorder = new Proxy(v, { get: (target, key) => { if (typeof key === 'string') read.add(key); return target[key] } })
    for (const inputs of variants) LINE_FUNCTIONS[line](inputs, recorder)
    const listed = new Set(Object.entries(PART_ASSUMPTIONS).filter(([k]) => k.startsWith(`${line}.`)).flatMap(([, keys]) => keys))
    for (const key of read) assert.ok(listed.has(key), `${line} reads ${key} but no part lists it`)
    for (const key of listed) assert.ok(read.has(key), `${line} lists ${key} but never reads it`)
    for (const key of listed) assert.ok(key in data.assumptions, `${line} lists ${key}, which is not in the file`)
  }
  // Every part that can appear has an entry.
  const r = calculate(variants[0], data).typical
  for (const line of LINES) for (const p of r.lines[line].parts) assert.ok(PART_ASSUMPTIONS[`${line}.${p.id}`], `${line}.${p.id} has no entry`)
})

await test('growth is a band, starts on Steady on the form, and an unknown band is refused', () => {
  assert.equal(normalizeInputs({ ...base, growth: '0.25' }).growth, '0.25')
  assert.equal(normalizeInputs(base).growth, null, 'blank until answered: the model holds an unanswered app flat')
  assert.equal(INPUTS.growth.start, '0.25', "the form's starting answer is Steady")
  assert.equal(INPUTS.growth.default, null)
  assert.equal(INPUTS.growth.required, false)
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
