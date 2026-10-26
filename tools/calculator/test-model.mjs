// Tests for the cost model and the results-link codec. Pure Node, no browser.
//
//   npm run test:model

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const data = JSON.parse(await readFile(resolve(root, '_data/assumptions/v3.json'), 'utf8'))
const { calculate, evaluate, resolveAssumptions, varyingKeys, jurShares, ccpaApplies, caConsumers, calendarYear, project, rampShare, networkShare, integration, deriveInputs, applyKind, LINE_FUNCTIONS, PART_ASSUMPTIONS, INTEGRATION_ASSUMPTIONS, LINES, SCENARIOS, JURISDICTIONS, YEARS, MONTHS, MARKER_YEAR, normalizeInputs } = await import(resolve(root, 'assets/js/calculator/src/model.js'))
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
// The illustrative app the page opens on: the form's starting answers.
const illustrative = { mau: 50000, jur: ['us'], team: 'ten', growth: '0.25' }
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
  assert.equal(data.version, 3)
  assert.ok(!('key_support_per_mau_year' in data.assumptions), 'key support is replaced by the hand-off derivation')
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
  assert.ok(r.low.totals.today_if_integrated <= r.typical.totals.today_if_integrated && r.typical.totals.today_if_integrated <= r.high.totals.today_if_integrated)
})

await test('only the thesis varies across scenarios: no custodial-side assumption moves, and every varying one is at-scale, Nostr-native or the integration', () => {
  const vary = varyingKeys(data)
  assert.equal(vary.length, 31, `${vary.length} varying keys`)
  const thesis = /^(scale_months|scale_progress_today|integ_weeks_\w+|integ_overlap_months|integ_engineers|.*_remains_share|media_sponsor_share|retained_data_share|.*_per_mau_year|relay_floor_year|relay_sponsored_share|key_handoff_live_share|lightning_rate)$/
  for (const key of vary) assert.ok(thesis.test(key), `${key} varies but is not a thesis key`)
  // The custodial side's own rates never vary, whatever the file says in its low and high columns.
  for (const key of ['eng_base_salary', 'egress_gb', 'blob_gb_month', 'dsar_cost', 'dsar_rate_per_mau_year', 'breach_prob_year', 'verify_share_us', 'gdpr_program_year', 'apple_rate_standard', 'growth_default', 'growth_decay', 'compute_per_mau_year', 'auth_per_mau_month', 'annual_users_per_mau', 'support_self_service_contact', 'support_live_contact', 'reset_rate_per_mau_year']) {
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
  // Every varying key runs one way from low to high through typical: a larger remains share, a larger fee, a slower ramp,
  // more weeks, or, where more is better (today's progress, engineers on the job), the smaller value in the low case.
  for (const key of vary) {
    const a = data.assumptions[key]
    const down = a.low >= a.typical && a.typical >= a.high
    const up = a.low <= a.typical && a.typical <= a.high
    assert.ok(down || up, `${key}: low ${a.low}, typical ${a.typical}, high ${a.high} are not in order`)
    assert.equal(up && !down, ['scale_progress_today', 'integ_engineers'].includes(key), `${key} runs the wrong way`)
  }
  // The thesis section opens with where the network is today, then the contested store commission, then how long to scale.
  assert.deepEqual(vary.slice(0, 3), ['scale_progress_today', 'p2p_store_fee_remains_share', 'scale_months'])
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

await test('on Nostr a store rail keeps only the commission the precedent leaves plus the user\'s rail; processor and reseller fees fall to the rail; peer to peer is unchanged', () => {
  const v = resolveAssumptions(data, 'typical')
  const r = calculate({ ...base, rails: ['apple', 'processor', 'reseller', 'p2p'] }, data).typical.lines.payments
  const apple = r.parts.find((p) => p.id === 'store_apple')
  const web = r.parts.find((p) => p.id === 'processor')
  const mor = r.parts.find((p) => p.id === 'reseller')
  const p2p = r.parts.find((p) => p.id === 'p2p')
  assert.ok(Math.abs(apple.noncustodial - (apple.custodial * v.p2p_store_fee_remains_share + apple.revenue * v.lightning_rate)) < 1e-6)
  assert.ok(apple.noncustodial < apple.custodial)
  assert.ok(web.noncustodial < web.custodial && Math.abs(web.noncustodial - web.revenue * v.lightning_rate) < 1e-6)
  assert.ok(mor.custodial > web.custodial && mor.noncustodial === web.noncustodial)
  assert.equal(p2p.custodial, p2p.noncustodial)
  for (const p of r.parts) assert.equal(p.kind, 'fees', `${p.id} is a fee`)
})

await test('payments are the fee stack on in-app volume: a feed app at 500k users with 50,000 a month on Apple and Google', () => {
  const inputs = { mau: 500000, kind: 'feed', jur: ['us'], team: 'ten', rev: 50000, rails: ['apple', 'google'] }
  const r = calculate(inputs, data)
  const volume = 50000 * 12
  for (const [s, remains, commission] of [['typical', 0.5, 45000], ['low', 1, 90000], ['high', 0.1, 9000]]) {
    const line = r[s].lines.payments
    const v = r[s].values
    assert.equal(v.p2p_store_fee_remains_share, remains)
    assert.ok(Math.abs(line.custodial - 90000) < 1e-6, `${s}: custodial ${line.custodial}`)
    assert.ok(Math.abs(line.noncustodial - (commission + volume * v.lightning_rate)) < 1e-6, `${s}: non-custodial ${line.noncustodial} vs ${commission} plus ${volume * v.lightning_rate}`)
    for (const p of line.parts) assert.equal(p.kind, 'fees')
    assert.equal(line.saving_cash, 0, 'the payments line contributes nothing to the cash saving')
    assert.ok(Math.abs(line.saving_fees - line.saving) < 1e-6)
  }
  // Each store's tier is by the proceeds through that store: 300k each, the small-business rate.
  for (const id of ['store_apple', 'store_google']) assert.equal(r.typical.lines.payments.parts.find((p) => p.id === id).tier, 'small')
  // A web rail alone: the user's rail carries the volume.
  const web = calculate({ ...inputs, rails: ['processor'] }, data).typical
  assert.ok(Math.abs(web.lines.payments.noncustodial - volume * web.values.lightning_rate) < 1e-6)
  // Peer to peer alone: nothing to save.
  const p2p = calculate({ ...inputs, rails: ['p2p'] }, data).typical
  assert.ok(Math.abs(p2p.lines.payments.custodial - p2p.lines.payments.noncustodial) < 1e-6)
  assert.ok(Math.abs(p2p.lines.payments.at_scale) < 1e-6)
  // A version-2 link carries the same volume under the same key.
  const link = decode('?mau=500000&rev=50000&rails=apple%2Cgoogle&jur=us&team=ten&v=2')
  assert.equal(link.version, 2)
  assert.equal(calculate(link.inputs, data).inputs.rev, 50000)
  // The store commission row is read by the Apple and Google parts, and by no other.
  for (const [key, keys] of Object.entries(PART_ASSUMPTIONS)) assert.equal(keys.includes('p2p_store_fee_remains_share'), key === 'payments.store_apple' || key === 'payments.store_google', key)
  const proxyRead = (inputsRaw) => {
    const read = new Set()
    const recorder = new Proxy(resolveAssumptions(data, 'typical'), { get: (target, k) => { if (typeof k === 'string') read.add(k); return target[k] } })
    for (const line of LINES) LINE_FUNCTIONS[line](normalizeInputs(inputsRaw), recorder)
    return read
  }
  assert.ok(proxyRead(inputs).has('p2p_store_fee_remains_share'))
  assert.ok(!proxyRead({ ...inputs, rails: ['processor', 'p2p'] }).has('p2p_store_fee_remains_share'), 'only a store rail reads it')
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

await test('three moderation states: unanswered bills the benchmark, a team or a vendor is priced by head, and "nobody" bills nothing on either side but carries the benchmark', () => {
  const v = resolveAssumptions(data, 'typical')
  const unsaid = calculate({ ...base, mod_who: null, mod_heads: null }, data).typical.lines.moderation
  assert.equal(unsaid.implied, true)
  assert.equal(unsaid.nobody, false)
  assert.ok(unsaid.custodial > 0 && unsaid.noncustodial > 0)
  const labour = unsaid.parts.find((p) => p.id === 'labour')
  assert.ok(Math.abs(labour.people - (base.mau / 1e6) * v.mods_per_million_mau) < 1e-9, 'the implied count is the benchmark')
  assert.equal(labour.benchmark, undefined, 'the implied line is its own benchmark')
  const nobody = calculate({ ...base, mod_who: 'nobody', mod_heads: null }, data).typical.lines.moderation
  assert.equal(nobody.nobody, true)
  assert.equal(nobody.implied, false)
  assert.equal(nobody.custodial, 0)
  assert.equal(nobody.noncustodial, 0)
  assert.equal(nobody.at_scale, 0, 'no saving is claimed where nothing is spent')
  for (const p of nobody.parts) assert.ok(p.custodial === 0 && p.noncustodial === 0, `${p.id} is zero on both sides`)
  const none = nobody.parts.find((p) => p.id === 'labour')
  assert.ok(none.benchmark && Math.abs(none.benchmark.people - labour.people) < 1e-9 && Math.abs(none.benchmark.cost - labour.custodial) < 1e-6, 'the benchmark is what the implied case bills')
  assert.ok(Math.abs(none.benchmark.loaded - labour.loaded) < 1e-6)
  const eff = deriveInputs(normalizeInputs({ ...base, mod_who: null }), v)
  assert.equal(eff.mod_who, null, 'deriveInputs keeps an unanswered question unanswered')
  assert.equal(deriveInputs(normalizeInputs({ ...base, mod_who: 'nobody' }), v).mod_who, 'nobody')
  const team = calculate({ ...base, mod_who: 'team', mod_heads: '15' }, data).typical.lines.moderation
  const vendor = calculate({ ...base, mod_who: 'vendor', mod_heads: '15' }, data).typical.lines.moderation
  assert.ok(team.custodial > vendor.custodial && team.implied === false && vendor.implied === false, 'a loaded employee costs more than a vendor seat')
  const few = calculate({ ...base, mod_who: 'team', mod_heads: '3' }, data).typical.lines.moderation
  assert.ok(team.custodial > few.custodial)
  // The six lines still add up with the moderation line at zero, in every scenario.
  const r = calculate({ ...base, mod_who: 'nobody', mod_heads: null }, data)
  for (const s of SCENARIOS) {
    const sum = LINES.reduce((acc, l) => acc + r[s].lines[l].at_scale, 0)
    assert.ok(Math.abs(sum - r[s].totals.at_scale) < 1e-6, `${s}: ${sum} vs ${r[s].totals.at_scale}`)
  }
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
  assert.ok(q.includes('team=one') && q.includes('kind=feed') && !q.includes('eng_') && !q.includes('posts_per_user=') && q.endsWith('v=3'), q)
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

await test('reported legal spend replaces the program estimates and keeps the content-law part', () => {
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

await test('the CCPA threshold counts California consumers a year: monthly actives times the annual multiple, the US share, the Californian share', () => {
  const v = resolveAssumptions(data, 'typical')
  assert.equal(v.annual_users_per_mau, 2)
  const at = Math.ceil(v.ccpa_consumer_threshold / (v.annual_users_per_mau * v.ca_share_of_us_users))
  assert.ok(at > 400000 && at < 450000, `a US-only app crosses at about ${at} monthly users`)
  const below = calculate(min({ mau: at - 1 }), data).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  const above = calculate(min({ mau: at }), data).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  assert.equal(below.us_tier, 'small')
  assert.equal(above.us_tier, 'large')
  assert.equal(below.usp, v.us_privacy_year_small)
  assert.equal(above.usp, v.us_privacy_year_large)
  assert.ok(Math.abs(above.ca_consumers - at * 2 * v.ca_share_of_us_users) < 1e-6 && above.us_share === 1, 'the part carries the test\'s figures for the dialog')
  assert.equal(calculate(min({ mau: 100000 }), data).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs').us_tier, 'small', '100k monthly users is not 100k Californians a year')
  // With the EU and the UK in the mix the US share of users is smaller, so the threshold sits higher.
  assert.equal(ccpaApplies(normalizeInputs(min({ mau: at })), v), true)
  assert.equal(ccpaApplies(normalizeInputs(min({ mau: at, jur: ['eu', 'us'] })), v), false)
  assert.equal(ccpaApplies(normalizeInputs(min({ mau: 10000000, jur: ['eu'] })), v), false, 'no US users, no CCPA')
  assert.ok(Math.abs(caConsumers(normalizeInputs(min({ mau: 1000 })), v) - 1000 * 2 * v.ca_share_of_us_users) < 1e-9)
  // The multiple is a custodial-side figure: the same in every scenario.
  for (const s of SCENARIOS) assert.equal(resolveAssumptions(data, s).annual_users_per_mau, 2)
})

await test('access requests come from EU and UK users always, from US users only once the CCPA applies, and fall with the data retained', () => {
  const v = resolveAssumptions(data, 'typical')
  const dsar = (inputs) => calculate(inputs, data).typical.lines.compliance.parts.find((p) => p.id === 'dsar')
  const usSmall = dsar(min({ mau: 50000 }))
  assert.equal(usSmall.custodial, 0, 'a US-only app below the threshold serves no requests')
  assert.equal(usSmall.noncustodial, 0)
  const usLarge = dsar(min({ mau: 1000000 }))
  assert.ok(Math.abs(usLarge.custodial - 1000000 * v.dsar_rate_per_mau_year * v.dsar_cost) < 1e-6, 'the volume stays per monthly user')
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
  assert.equal(back.version, 3)
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
  assert.equal(under.version, 3)
  // A version-2 link with an override of the key-support rate, which v3 derives instead: the override is dropped, the link reports its version.
  const v2 = decode('?mau=50000&jur=us&team=ten&a.key_support_per_mau_year=0.1&a.egress_gb=0.05&v=2')
  assert.equal(v2.version, 2)
  assert.ok(v2.version < data.version, 'older than the file, so the page says so')
  const recomputed = calculate(v2.inputs, data, v2.overrides)
  assert.deepEqual(Object.keys(recomputed.overrides), ['egress_gb'])
  assert.equal(recomputed.version, 3)
  assert.ok(recomputed.typical.lines.accounts.parts.some((p) => p.id === 'key_handoff') && !recomputed.typical.lines.accounts.parts.some((p) => p.id === 'key_support'))
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
const P = data.assumptions.scale_progress_today.typical
const M = data.assumptions.scale_months.typical

await test('the ramp starts at today\'s network progress and counts from January of the start year: year 0 is months 1 to 12', () => {
  assert.equal(P, 0.3, "Nostr4's estimate: the network delivers about 30% of the at-scale saving today")
  assert.equal(M, 36, "Nostr4's estimate: three years to Nostr at scale")
  assert.ok(Math.abs(networkShare(1, P, M) - 0.319) < 0.005, `month 1 starts just above p: ${networkShare(1, P, M)}`)
  assert.ok(networkShare(1, P, M) > P && networkShare(12, P, M) > networkShare(1, P, M), 'rising from p')
  assert.ok(Math.abs(rampShare(0, P, M) - 0.507) < 0.01, `year 0: ${rampShare(0, P, M)}`)
  assert.ok(rampShare(0, P, M) > P && rampShare(1, P, M) > rampShare(0, P, M) && rampShare(2, P, M) > rampShare(1, P, M), 'each year higher than the last until scale')
  assert.equal(rampShare(3, P, M), 1, 'the marker year is the first full year at scale')
  assert.equal(rampShare(4, P, M), 1)
  assert.equal(MARKER_YEAR, 3)
  // With no progress today the shape is version 2's, shifted a year earlier: the first twelve months are now year 0.
  assert.ok(Math.abs(rampShare(0, 0, 36) - 0.296) < 0.01, String(rampShare(0, 0, 36)))
  assert.ok(Math.abs(rampShare(1, 0, 36) - 0.741) < 0.01, String(rampShare(1, 0, 36)))
  assert.ok(Math.abs(rampShare(2, 0, 36) - 0.963) < 0.01, String(rampShare(2, 0, 36)))
  assert.equal(rampShare(3, 0, 36), 1)
  assert.ok(rampShare(0, P, 48) < rampShare(0, P, 36) && rampShare(0, P, 24) > rampShare(0, P, 36), 'slower is the smaller saving')
  assert.ok(rampShare(0, 0.15, 36) < rampShare(0, P, 36) && rampShare(0, 0.45, 36) > rampShare(0, P, 36), 'less progress today is the smaller saving')
  assert.ok(Math.abs(rampShare(0, 0, 12) - 2 / 3) < 0.01, String(rampShare(0, 0, 12)))
  assert.equal(rampShare(1, 0, 12), 1)
  assert.equal(rampShare(0, P, 0), 1, 'no months to scale means at scale')
  assert.equal(networkShare(5, P, 0), 1)
  assert.ok(data.assumptions.scale_months.low > 36 && data.assumptions.scale_months.high < 36, 'slower is the smaller saving')
  assert.ok(data.assumptions.scale_progress_today.low < P && data.assumptions.scale_progress_today.high > P, 'less progress is the smaller saving')
})

await test('the Nostr line is what an app on Nostr pays that year: year 0 is below custody by the saving times the year\'s share, in every scenario', () => {
  for (const inputs of [base, illustrative, { ...base, growth: '1' }, min({ mau: 2000000, jur: ['eu', 'us'] })]) {
    const r = calculate(inputs, data)
    for (const s of SCENARIOS) {
      const p = r[s].projection
      const v = r[s].values
      assert.equal(p.length, YEARS + 1)
      assert.ok(p[0].nostr < p[0].custodial, `${s}: year 0 starts apart`)
      assert.ok(Math.abs(p[0].custodial - p[0].nostr - p[0].saving * rampShare(0, v.scale_progress_today, v.scale_months)) < 1e-6, `${s}: the gap is the saving times the share`)
      assert.ok(Math.abs(p[0].share - rampShare(0, v.scale_progress_today, v.scale_months)) < 1e-12)
      for (const q of p) {
        assert.ok(Math.abs(q.custodial - q.nostr - q.saving * q.share) < 1e-6, `${s} year ${q.year}`)
        assert.ok(q.nostr >= q.noncustodial - 1e-6, 'never below the at-scale cost')
        assert.ok(Math.abs(q.saving_cash + q.saving_fees + q.saving_risk - q.saving) < 1e-6)
      }
      assert.ok(p[1].nostr - p[1].noncustodial < p[0].nostr - p[0].noncustodial, 'the line falls toward the at-scale cost as the network scales')
      assert.ok(Math.abs(p[YEARS].nostr - p[YEARS].noncustodial) < 1e-6, 'at scale, the Nostr line is the non-custodial cost')
      if (s !== 'low') assert.ok(Math.abs(p[MARKER_YEAR].nostr - p[MARKER_YEAR].noncustodial) < 1e-6, 'the marker year is the first full year at scale under 36 months or fewer')
      assert.equal('path' in p[0], false, 'no path: the lines start apart')
    }
    assert.ok(r.low.projection[0].nostr >= r.typical.projection[0].nostr && r.typical.projection[0].nostr >= r.high.projection[0].nostr, 'the low case is the higher Nostr cost today')
  }
})

await test('the integration: person-weeks per piece scaled by what is not yet on Nostr, at the loaded hour; months with the engineers on it; then the overlap', () => {
  const v = typicalV()
  const eff = deriveInputs(normalizeInputs(base), v)
  const i = integration(eff, v)
  assert.deepEqual(i.weeks, { accounts: 4, graph: 6, storage: 4, media: 3, moderation: 3, payments: 2 })
  assert.equal(i.weeksTotal, 22)
  assert.ok(Math.abs(i.cost - 22 * 40 * ((v.eng_base_salary * v.loaded_multiplier * v.overhead_multiplier) / 2000)) < 1e-6, 'person-weeks at the loaded hour already in the model')
  assert.equal(i.months, Math.ceil(22 / 2 / (52 / 12)))
  assert.equal(i.months, 3)
  assert.equal(i.overlap, 6)
  assert.equal(i.liveMonth, 9)
  assert.equal(i.engineers, 2)
  // No revenue, or revenue already peer to peer: nothing to move.
  assert.equal(integration(deriveInputs(normalizeInputs({ ...base, rev: 0, rails: [] }), v), v).weeks.payments, 0)
  assert.equal(integration(deriveInputs(normalizeInputs({ ...base, rails: ['p2p'] }), v), v).weeks.payments, 0)
  assert.equal(integration(deriveInputs(normalizeInputs({ ...base, rails: ['p2p', 'apple'] }), v), v).weeks.payments, 2, 'a store rail beside it still has revenue to move')
  // What the app already has on Nostr comes off the weeks, row by row.
  const half = integration(deriveInputs(normalizeInputs({ ...base, n_keys: '0.5', n_media_storage: '1', n_event_storage: '0.5' }), v), v)
  assert.equal(half.weeks.accounts, 2)
  assert.equal(half.weeks.media, 0)
  assert.equal(half.weeks.storage, 2)
  assert.equal(half.weeks.graph, 6)
  // Raw keys cancel the accounts credit, as they do for the line.
  assert.equal(integration(deriveInputs(normalizeInputs({ ...base, n_keys: '1', n_raw_keys: '1' }), v), v).weeks.accounts, 4)
  // More engineers shorten the calendar, not the bill; the scenarios run from slow and expensive to quick and cheap.
  const three = integration(eff, typicalV({ integ_engineers: 3 }))
  assert.equal(three.cost, i.cost)
  assert.ok(three.months < i.months)
  const r = calculate(base, data)
  assert.ok(r.low.integration.weeksTotal > r.typical.integration.weeksTotal && r.typical.integration.weeksTotal > r.high.integration.weeksTotal)
  assert.ok(r.low.integration.liveMonth > r.typical.integration.liveMonth && r.typical.integration.liveMonth > r.high.integration.liveMonth)
  assert.deepEqual(Object.keys(r.typical.integration).sort(), ['cost', 'engineers', 'hourly', 'liveMonth', 'months', 'overlap', 'paybackMonth', 'weeks', 'weeksTotal'])
  // The integration reads exactly the assumptions it lists.
  const read = new Set()
  const recorder = new Proxy(v, { get: (target, key) => { if (typeof key === 'string') read.add(key); return target[key] } })
  integration(eff, recorder)
  assert.deepEqual([...read].sort(), [...INTEGRATION_ASSUMPTIONS].sort())
  for (const key of INTEGRATION_ASSUMPTIONS) assert.ok(key in data.assumptions, `${key} is not in the file`)
})

await test('a fully Nostr app has no integration, no overlap, and pays back in month 1', () => {
  const r = calculate({ ...base, nostr_now: '1' }, data)
  for (const s of SCENARIOS) {
    const i = r[s].integration
    assert.equal(i.weeksTotal, 0)
    assert.equal(i.cost, 0)
    assert.equal(i.months, 0)
    assert.equal(i.overlap, 0, 'no custodial stack to retire')
    assert.equal(i.liveMonth, 0)
    assert.equal(i.paybackMonth, 1)
    assert.equal(r[s].totals.payback_month, 1)
    for (const p of r[s].projection) assert.ok(p.integration === 0 && p.overlap === 0)
  }
})

await test('the months net the saving realised against the integration and the overlap; the cumulative is their running sum; payback is where it first reaches zero', () => {
  const r = calculate({ ...base, growth: '0.25' }, data)
  for (const s of SCENARIOS) {
    const { projection: p, monthly, integration: i } = r[s]
    assert.equal(monthly.length, MONTHS)
    assert.equal(MONTHS, 72)
    let running = 0
    for (const q of monthly) {
      // Nothing is realised before the custodial stack is off; both stacks cost during the overlap; the integration is spread over its months.
      assert.equal(q.realised > 0, q.month > i.liveMonth, `${s} month ${q.month} realised`)
      assert.equal(q.overlap > 0, q.month > i.months && q.month <= i.liveMonth, `${s} month ${q.month} overlap`)
      assert.equal(q.integration > 0, q.month <= i.months, `${s} month ${q.month} integration`)
      assert.ok(Math.abs(q.net - (q.realised - q.integration - q.overlap)) < 1e-6)
      running += q.net
      assert.ok(Math.abs(q.cumulative - running) < 1e-6)
    }
    assert.ok(Math.abs(monthly.slice(0, i.months).reduce((a, q) => a + q.integration, 0) - i.cost) < 1e-6, 'the integration adds up to its cost')
    const overlapMonths = monthly.filter((q) => q.overlap > 0)
    assert.equal(overlapMonths.length, i.overlap)
    for (const q of overlapMonths) assert.ok(Math.abs(q.overlap - p[Math.floor((q.month - 1) / 12)].noncustodial / 12) < 1e-6, 'the Nostr costs, paid on top')
    const live = monthly.find((q) => q.month === i.liveMonth + 1)
    assert.ok(Math.abs(live.realised - (p[Math.floor(i.liveMonth / 12)].saving / 12) * networkShare(live.month, r[s].values.scale_progress_today, r[s].values.scale_months)) < 1e-6)
    // Year totals are the sums of their months; the year's cumulative is its last month's.
    for (const q of p) {
      const months = monthly.slice(q.year * 12, q.year * 12 + 12)
      for (const k of ['realised', 'integration', 'overlap', 'net']) assert.ok(Math.abs(q[k] - months.reduce((a, x) => a + x[k], 0)) < 1e-6, `${s} year ${q.year} ${k}`)
      assert.ok(Math.abs(q.cumulative - months[11].cumulative) < 1e-6)
      assert.ok(Math.abs(q.net - (q.realised - q.integration - q.overlap)) < 1e-6)
    }
    assert.equal(r[s].totals.five_year, p[YEARS].cumulative, 'the five-year figure is the net cumulative')
    assert.equal(r[s].totals.marker_year, p[MARKER_YEAR].cumulative)
    assert.ok(monthly[0].cumulative < 0, 'month 1 is in the red: the integration comes first')
    const first = monthly.find((q) => q.cumulative >= -1e-6)
    assert.equal(i.paybackMonth, first.month)
    assert.equal(r[s].totals.payback_month, first.month)
    assert.ok(monthly[i.paybackMonth - 2].cumulative < 0, 'the month before is still negative')
  }
  assert.ok(r.low.totals.five_year <= r.typical.totals.five_year && r.typical.totals.five_year <= r.high.totals.five_year)
  assert.ok(r.low.totals.five_year > 0, 'even the low case comes out ahead')
})

await test('the default app pays back in year 1 under typical; low is later, high earlier; a slow or costly integration can push it out of the window', () => {
  const r = calculate(illustrative, data)
  const year = (m) => Math.floor((m - 1) / 12)
  assert.ok(year(r.typical.totals.payback_month) >= 1 && year(r.typical.totals.payback_month) <= 2, `typical pays back in month ${r.typical.totals.payback_month}`)
  assert.ok(r.low.totals.payback_month > r.typical.totals.payback_month, `low ${r.low.totals.payback_month} later than typical ${r.typical.totals.payback_month}`)
  assert.ok(r.high.totals.payback_month < r.typical.totals.payback_month, `high ${r.high.totals.payback_month} earlier than typical ${r.typical.totals.payback_month}`)
  assert.equal(r.typical.totals.payback_month, r.typical.integration.paybackMonth)
  // A thousand weeks of integration never pays back within the projection: null, which the page words.
  const never = calculate(illustrative, data, { integ_weeks_graph: 1000 })
  assert.equal(never.typical.totals.payback_month, null)
  assert.ok(never.typical.totals.five_year < 0)
  assert.ok(never.typical.projection.every((p) => p.cumulative < 0))
})

await test('three savings: cash from the bills, fees from the payments line, risk from the expected loss; they add up to the saving today and at scale', () => {
  for (const inputs of [base, illustrative, { ...base, n_keys: '1', n_event_storage: '0.5' }, min({ mau: 5000000, jur: JURISDICTIONS }), { ...base, n_p2p: '0.5' }]) {
    const r = calculate(inputs, data)
    for (const s of SCENARIOS) {
      const T = r[s].totals
      assert.ok(Math.abs(T.saving_cash + T.saving_fees + T.saving_risk - T.saving) < 1e-6, `${s} today`)
      assert.ok(Math.abs(T.at_scale_cash + T.at_scale_fees + T.at_scale_risk - T.at_scale) < 1e-6, `${s} at scale`)
      assert.ok(T.saving_risk >= 0 && T.saving_fees >= 0 && T.saving_cash > 0, 'no part is negative')
      if (inputs === base) assert.ok(T.saving_risk > 0 && T.saving_fees > 0 && T.saving_risk < T.saving_cash && T.saving_fees < T.saving_cash, 'for the baseline the fees and the risk are the smaller parts')
      const breach = r[s].lines.compliance.parts.find((p) => p.id === 'breach')
      const line = r[s].lines.compliance
      assert.ok(Math.abs(line.saving_risk - (breach.custodial - line.share * (breach.custodial - breach.noncustodial) - breach.noncustodial)) < 1e-6, 'the risk saving is the breach part, moved by the line\'s share like the rest')
      for (const l of LINES) if (l !== 'compliance') assert.equal(r[s].lines[l].saving_risk, 0)
      // The fees saving is the whole payments line, moved by its share; no other line has one, and the payments line has no cash saving.
      const pay = r[s].lines.payments
      assert.ok(Math.abs(pay.saving_fees - pay.saving) < 1e-6 && pay.saving_cash === 0, `${s}: payments ${pay.saving_fees} vs ${pay.saving}`)
      for (const l of LINES) if (l !== 'payments') assert.equal(r[s].lines[l].saving_fees, 0)
      assert.ok(Math.abs(LINES.reduce((a, l) => a + r[s].lines[l].saving_cash, 0) - T.saving_cash) < 1e-6)
      assert.ok(Math.abs(T.saving_fees - pay.saving_fees) < 1e-6)
      // At scale the split is the marker year's, at that year's users.
      const at = r[s].projection[MARKER_YEAR]
      assert.ok(Math.abs(T.at_scale_cash - at.saving_cash * at.share) < 1e-6)
      assert.ok(Math.abs(T.at_scale_fees - at.saving_fees * at.share) < 1e-6)
      assert.ok(Math.abs(T.at_scale_risk - at.saving_risk * at.share) < 1e-6)
      // Today if integrated: the cash saving the network delivers in year 0, with its fees and risk parts beside it.
      const today = r[s].projection[0]
      assert.ok(Math.abs(T.today_if_integrated - today.saving_cash * today.share) < 1e-6)
      assert.ok(Math.abs(T.today_if_integrated + T.today_if_integrated_fees + T.today_if_integrated_risk - (today.custodial - today.nostr)) < 1e-6)
      assert.ok(T.today_if_integrated < T.at_scale_cash, 'less than at scale')
    }
  }
})

await test('the key management hand-off: the reset rate as hand-offs, a self-service contact each plus the live share, and nothing left of resets', () => {
  const v = resolveAssumptions(data, 'typical')
  const r = calculate(base, data).typical.lines.accounts
  const handoff = r.parts.find((p) => p.id === 'key_handoff')
  const resets = r.parts.find((p) => p.id === 'resets')
  assert.ok(handoff && !r.parts.some((p) => p.id === 'key_support'))
  assert.equal(handoff.custodial, 0)
  assert.ok(Math.abs(handoff.contact - 0.2602) < 1e-9, 'typical: 0.10 self-service plus 2% of 8.01 live')
  assert.ok(Math.abs(handoff.noncustodial - base.mau * 0.25 * 0.2602) < 0.005, 'to the cent')
  assert.ok(Math.abs(handoff.noncustodial - base.mau * v.reset_rate_per_mau_year * (v.support_self_service_contact + v.key_handoff_live_share * v.support_live_contact)) < 1e-6)
  assert.equal(handoff.rate, v.reset_rate_per_mau_year)
  assert.ok(resets.custodial > 0 && resets.noncustodial === 0, 'keys cannot be reset')
  assert.ok(Math.abs(handoff.noncustodial / base.mau - 0.06505) < 1e-6, 'about 0.065 a user a year')
  // Low keeps more hand-offs live; high keeps none.
  const low = calculate(base, data).low.lines.accounts.parts.find((p) => p.id === 'key_handoff')
  const high = calculate(base, data).high.lines.accounts.parts.find((p) => p.id === 'key_handoff')
  assert.ok(low.noncustodial > handoff.noncustodial && high.noncustodial < handoff.noncustodial)
  assert.ok(Math.abs(high.contact - v.support_self_service_contact) < 1e-9)
})

await test('relay capacity is rented for the users who don\'t bring their own, never below one managed relay', () => {
  const v = resolveAssumptions(data, 'typical')
  assert.equal(v.relay_sponsored_share, 0.5)
  assert.equal(v.relay_per_mau_year, 0.14)
  const relay = (mau, over = {}) => calculate(min({ mau }), data, over).typical.lines.storage.parts.find((p) => p.id === 'relay')
  const big = relay(1000000)
  assert.ok(Math.abs(big.noncustodial - 70000) < 1e-6, `1M users, half sponsored at 0.14: ${big.noncustodial}`)
  assert.equal(big.minimum, false)
  assert.equal(big.sponsored, 0.5)
  const small = relay(1000)
  assert.equal(small.noncustodial, v.relay_floor_year)
  assert.equal(small.minimum, true)
  assert.equal(small.custodial, 0)
  assert.ok(Math.abs(relay(1000000, { relay_sponsored_share: 1 }).noncustodial - 140000) < 1e-6, 'sponsoring everyone doubles it')
  assert.ok(Math.abs(relay(1000000, { relay_sponsored_share: 0 }).noncustodial - v.relay_floor_year) < 1e-6, 'sponsoring nobody leaves the one relay')
})

await test('growth compounds and decays; users are whole', () => {
  const inputs = normalizeInputs({ ...base, growth: '1' })
  const { points: p } = project(inputs, typicalV({ growth_decay: 0.5 }))
  assert.equal(p[1].users, 100000)
  assert.equal(p[2].users, 150000)
  assert.equal(p[3].users, 187500)
  for (const q of p) assert.ok(Number.isInteger(q.users))
})

await test('a flat app saves the same each year once the network is at scale and the integration is behind it', () => {
  const inputs = deriveInputs(normalizeInputs({ ...base, growth: '0' }), typicalV())
  const { points: p } = project(inputs, typicalV({ scale_months: 12 }))
  assert.ok(p[0].realised < p[1].realised - 1, 'year 0 carries the integration and the overlap')
  for (let y = 2; y <= YEARS; y++) assert.ok(Math.abs(p[y].realised - p[1].realised) < 1e-6, `year ${y}`)
  const slow = project(inputs, typicalV()).points
  assert.ok(slow[0].realised < slow[1].realised && slow[1].realised < slow[2].realised && slow[2].realised < slow[3].realised - 1)
  assert.ok(Math.abs(slow[4].realised - slow[3].realised) < 1e-6 && Math.abs(slow[5].realised - slow[4].realised) < 1e-6, 'at scale from the marker year on')
  // With nothing to integrate and no ramp, the saving cumulates in a straight line from month 1.
  const straight = project({ ...inputs, nostr_now: '1', n_keys: '1', n_raw_keys: '0', n_signed_events: '1', n_event_storage: '1', n_media_storage: '1', n_labels: '1', n_feeds: '1', n_algos: '1', n_p2p: '1', n_nips: '1' }, typicalV({ scale_months: 0 }))
  assert.equal(straight.integration.weeksTotal, 0)
  for (let y = 0; y <= YEARS; y++) assert.ok(Math.abs(straight.points[y].cumulative - straight.points[0].saving * (y + 1)) < 1e-6, `year ${y}`)
})

await test('the calendar: month 1 is January 2027, the first yearly mark after today is 2028 and Nostr is at scale in 2030', () => {
  const r = calculate(base, data)
  assert.equal(r.start_year, 2027)
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((y) => calendarYear(r.start_year, y)), [2027, 2028, 2029, 2030, 2031, 2032])
  assert.equal(MARKER_YEAR, 3)
  assert.equal(calendarYear(r.start_year, MARKER_YEAR), 2030)
  assert.equal(r.typical.projection[MARKER_YEAR].year, MARKER_YEAR)
})

await test('"at scale" is the marker year\'s column: the gap between the two costs that year, and the lines and their parts add up to it', () => {
  const r = calculate({ ...base, growth: '0.25' }, data)
  for (const s of SCENARIOS) {
    const T = r[s].totals
    const at = r[s].projection[MARKER_YEAR]
    assert.ok(Math.abs(T.at_scale - (at.custodial - at.nostr)) < 1e-6)
    assert.equal(T.scale_custodial, at.custodial)
    assert.equal(T.scale_nostr, at.nostr)
    assert.equal(T.scale_users, at.users)
    assert.ok(Math.abs(T.at_scale - (T.scale_custodial - T.scale_nostr)) < 1e-6, 'the figure is the gap between the two dots')
    assert.ok(Math.abs(T.scale_per_mau_custodial - at.custodial / at.users) < 1e-9 && Math.abs(T.scale_per_mau_nostr - at.nostr / at.users) < 1e-9, 'per user that year, at that year\'s users')
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
  // Flat, it is the whole of today's saving: the marker year is the first full year at scale.
  const flat = calculate({ ...base, growth: '0' }, data).typical.totals
  assert.ok(Math.abs(flat.at_scale - flat.saving) < 1e-6)
  assert.ok(r.low.totals.at_scale <= r.typical.totals.at_scale && r.typical.totals.at_scale <= r.high.totals.at_scale)
  assert.ok(r.low.totals.scale_nostr >= r.typical.totals.scale_nostr && r.typical.totals.scale_nostr >= r.high.totals.scale_nostr, 'the Nostr cost at scale is largest in the low case')
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
  const given = project(normalizeInputs({ ...base, growth: '0.5' }), typicalV({ growth_default: 0 })).points
  const blank = project(normalizeInputs(base), typicalV({ growth_default: 0 })).points
  assert.ok(given[1].users > blank[1].users)
  assert.equal(blank[1].users, base.mau)
})

await test('the lines\' gaps over the projection add up to the gaps between the lines, and the net is that less the integration and the overlap', () => {
  const r = calculate({ ...base, growth: '0.25' }, data)
  for (const s of SCENARIOS) {
    const p = r[s].projection
    const gaps = p.reduce((acc, q) => acc + q.custodial - q.nostr, 0)
    const sum = LINES.reduce((acc, l) => acc + r[s].lines[l].five_year, 0)
    assert.ok(Math.abs(sum - gaps) < 1e-6, `${s}: ${sum} vs ${gaps}`)
    for (const l of LINES) assert.ok(r[s].lines[l].five_year >= -1e-6, `${l} never negative`)
    const realised = p.reduce((acc, q) => acc + q.realised, 0)
    const spent = p.reduce((acc, q) => acc + q.integration + q.overlap, 0)
    assert.ok(realised <= gaps + 1e-6, 'what is realised is at most what the network delivers')
    assert.ok(Math.abs(r[s].totals.five_year - (realised - spent)) < 1e-6)
  }
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
  // The content-law and moderation low cases describe one world: three quarters and half remain.
  assert.equal(data.assumptions.content_law_remains_share.low, 0.75)
  assert.equal(data.assumptions.moderation_remains_share.low, 0.5)
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

await test('the expected breach loss is marked as risk, apart from the cash costs', () => {
  const r = calculate(base, data).typical.lines.compliance
  const breach = r.parts.find((p) => p.id === 'breach')
  assert.equal(breach.kind, 'risk')
  assert.ok(r.parts.filter((p) => p.kind === 'risk').length === 1 && r.parts.filter((p) => !p.kind).length === 4)
  for (const l of LINES) if (l !== 'compliance') for (const p of calculate(base, data).typical.lines[l].parts) assert.notEqual(p.kind, 'risk')
  // Every payments part is a fee; no part of any other line is.
  for (const l of LINES) for (const p of calculate(base, data).typical.lines[l].parts) assert.equal(p.kind === 'fees', l === 'payments', `${l}.${p.id}`)
  // The kind travels into the projection's parts, so the page can keep them apart in every year.
  const at = calculate(base, data).typical.projection[MARKER_YEAR].lines.compliance.parts
  assert.equal(at.find((p) => p.id === 'breach').kind, 'risk')
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
  // Inputs that walk every branch: all regions, every rail, balances held, given and defaulted bands, reported spend or not, above and below the CCPA threshold, every moderation state.
  const variants = [
    normalizeInputs({ ...base, jur: ['eu', 'uk', 'us', 'other'], rails: ['p2p', 'apple', 'google', 'processor', 'reseller'], rev: 50000, balances: ['yes'], mod_who: 'team', mod_heads: '15' }),
    normalizeInputs({ ...base, mod_who: 'vendor', mod_heads: '3' }),
    normalizeInputs({ ...base, mod_who: 'nobody', mod_heads: null }),
    normalizeInputs({ ...base, mod_who: null, mod_heads: null }),
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
  // Every part that can appear has an entry, and the new ones are listed in full.
  const r = calculate(variants[0], data).typical
  for (const line of LINES) for (const p of r.lines[line].parts) assert.ok(PART_ASSUMPTIONS[`${line}.${p.id}`], `${line}.${p.id} has no entry`)
  assert.deepEqual(PART_ASSUMPTIONS['accounts.key_handoff'], ['reset_rate_per_mau_year', 'support_self_service_contact', 'support_live_contact', 'key_handoff_live_share'])
  assert.ok(PART_ASSUMPTIONS['storage.relay'].includes('relay_sponsored_share'))
  assert.ok(PART_ASSUMPTIONS['compliance.privacy_programs'].includes('annual_users_per_mau') && PART_ASSUMPTIONS['compliance.dsar'].includes('annual_users_per_mau'))
  assert.equal(PART_ASSUMPTIONS['accounts.key_support'], undefined)
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
  console.log(`     ${'total'.padEnd(11)} ${f(r.totals.custodial)} ${f(r.totals.noncustodial)}   per MAU ${r.totals.per_mau_custodial.toFixed(2)} → ${r.totals.per_mau_noncustodial.toFixed(2)}   cash ${f(r.totals.saving_cash)} fees ${f(r.totals.saving_fees)} risk ${f(r.totals.saving_risk)}`)
  console.log(`     integration ${r.integration.weeksTotal} weeks, ${r.integration.months} months, ${f(r.integration.cost)}; overlap ${r.integration.overlap} months; payback month ${r.integration.paybackMonth}`)
  for (const p of r.projection) console.log(`     year ${p.year}  ${String(p.users).padStart(9)} users  custody ${f(p.custodial)}  nostr ${f(p.nostr)}  net ${f(p.net)}  so far ${f(p.cumulative)}`)
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
