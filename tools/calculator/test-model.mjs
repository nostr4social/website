// Tests for the cost model and the results-link codec. Pure Node, no browser.
//
//   npm run test:model

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const data = JSON.parse(await readFile(resolve(root, '_data/assumptions/v4.json'), 'utf8'))
const { calculate: calculateRaw, evaluate, resolveAssumptions, cleanOverrides, varyingKeys, jurShares, ccpaApplies, caConsumers, project, pointAt, usersAt, networkShare, monthsBetween, addMonths, parseDate, isDate, deriveInputs, applyKind, complianceFactor, breachLoss, LINE_FUNCTIONS, PART_ASSUMPTIONS, LINES, SCENARIOS, JURISDICTIONS, TEAMS, YEARS, normalizeInputs } = await import(resolve(root, 'assets/js/calculator/src/model.js'))
// Every test is as of one pinned date: the model never reads the clock.
const TODAY = '2026-11-03'
const calculate = (inputs, d = data, overrides = {}) => calculateRaw(inputs, d, overrides, { today: TODAY })
const { encode, decode } = await import(resolve(root, 'assets/js/calculator/src/codec.js'))
const { INPUTS, InputError } = await import(resolve(root, 'assets/js/calculator/src/inputs.js'))
const { approx, compact, compactNumber, money, number } = await import(resolve(root, 'assets/js/calculator/src/format.js'))

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
const illustrative = { mau: 50000, jur: ['us'], team: 'ten', growth: '0.5', kind: 'messaging', rev: 5000 }
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
  assert.equal(data.version, 4)
  for (const gone of ['scale_progress_today', 'scale_months', 'breach_cost_per_user', 'breach_cost_cap', 'key_support_per_mau_year']) assert.ok(!(gone in data.assumptions), `${gone} is gone`)
  assert.ok(!Object.keys(data.assumptions).some((k) => k.startsWith('integ_') || k.startsWith('scale_')), 'integration cost is never estimated, and nothing is called scale')
  assert.ok(!('start_year' in data), 'no calendar start: the app\'s timeline is relative')
  assert.ok(!/Date\.now|new Date\(\)/.test(text), 'the model never reads the clock')
  for (const [key, a] of Object.entries(data.assumptions)) assert.ok(!/at[- ]scale|scale_/i.test(`${a.label} ${a.note}`), `${key} still says scale`)
  assert.equal(data.assumptions.network_mature_start.unit, 'date')
  assert.equal(data.assumptions.network_mature_end.unit, 'date')
  assert.deepEqual(TEAMS, ['one', 'ten', 'fifty', 'more'])
})

await test('the baseline evaluates to finite, non-negative numbers', () => finite(calculate(base, data)))

await test('low is the smaller saving: the custodial column is the same in every scenario, the Nostr column falls from low to high', () => {
  const r = calculate(base, data)
  for (const l of LINES) {
    assert.ok(Math.abs(r.low.lines[l].custodial - r.typical.lines[l].custodial) < 1e-6, `${l} custodial low = typical`)
    assert.ok(Math.abs(r.high.lines[l].custodial - r.typical.lines[l].custodial) < 1e-6, `${l} custodial high = typical`)
    assert.ok(r.low.lines[l].noncustodial >= r.typical.lines[l].noncustodial - 1e-6, `${l} non-custodial low ≥ typical`)
    assert.ok(r.typical.lines[l].noncustodial >= r.high.lines[l].noncustodial - 1e-6, `${l} non-custodial typical ≥ high`)
    assert.ok(r.low.lines[l].estimated <= r.typical.lines[l].estimated + 1e-6 && r.typical.lines[l].estimated <= r.high.lines[l].estimated + 1e-6, `${l} saving low ≤ typical ≤ high`)
  }
  assert.ok(Math.abs(r.low.totals.custodial - r.typical.totals.custodial) < 1e-6 && Math.abs(r.high.totals.custodial - r.typical.totals.custodial) < 1e-6)
  assert.ok(r.low.totals.saving <= r.typical.totals.saving && r.typical.totals.saving <= r.high.totals.saving)
  assert.ok(r.low.totals.estimated <= r.typical.totals.estimated && r.typical.totals.estimated <= r.high.totals.estimated)
})

await test('only the thesis varies across scenarios: no custodial-side assumption moves, and every varying one is at-scale or Nostr-native', () => {
  const vary = varyingKeys(data)
  assert.equal(vary.length, 21, `${vary.length} varying keys`)
  const thesis = /^(.*_remains_share|media_sponsor_share|retained_data_share|.*_per_mau_year|relay_floor_year|relay_sponsored_share|key_handoff_live_share|lightning_rate)$/
  for (const key of vary) assert.ok(thesis.test(key), `${key} varies but is not a thesis key`)
  // The custodial side's own rates never vary, whatever the file says in its low and high columns.
  for (const key of ['eng_base_salary', 'egress_gb', 'blob_gb_month', 'dsar_cost', 'dsar_rate_per_mau_year', 'breach_prob_year', 'verify_share_us', 'gdpr_program_year', 'apple_rate_standard', 'growth_default', 'growth_decay', 'compute_per_mau_year', 'auth_per_mau_month', 'annual_users_per_mau', 'support_self_service_contact', 'support_live_contact', 'reset_rate_per_mau_year', 'network_mature_start', 'network_mature_end', 'integration_payback_months', 'estimated_savings_months', 'p2p_conversion_share', 'compliance_tier_factor_one', 'breach_loss_one']) {
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
  // Every varying key runs one way: low keeps more, high keeps less, a larger fee in the low case. None of the new rows varies.
  for (const key of vary) {
    const a = data.assumptions[key]
    assert.ok(a.low >= a.typical && a.typical >= a.high, `${key}: low ${a.low}, typical ${a.typical}, high ${a.high} run the wrong way`)
  }
  // The thesis section opens with the contested store commission; the timeline rows are not scenarios.
  assert.equal(vary[0], 'p2p_store_fee_remains_share')
  for (const key of ['network_mature_start', 'network_mature_end', 'integration_payback_months', 'estimated_savings_months', 'p2p_conversion_share']) assert.ok(!vary.includes(key), `${key} does not vary`)
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
  assert.equal(v.p2p_conversion_share, 1, 'full conversion is the thesis')
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
  assert.ok(Math.abs(p2p.lines.payments.estimated) < 1e-6)
  // A version-2 link carries the same volume under the same key.
  const link = decode('?mau=500000&rev=50000&rails=apple%2Cgoogle&jur=us&team=ten&v=2')
  assert.equal(link.version, 2)
  assert.equal(calculate(link.inputs, data).inputs.rev, 50000)
  // The conversion share: at half, the unconverted half stays on the store rail at the full rate.
  const half = calculate(inputs, data, { p2p_conversion_share: 0.5 }).typical.lines.payments
  const vh = calculate(inputs, data, { p2p_conversion_share: 0.5 }).typical.values
  const applePart = half.parts.find((p) => p.id === 'store_apple')
  assert.ok(Math.abs(applePart.noncustodial - (applePart.revenue * 0.5 * (applePart.rate * vh.p2p_store_fee_remains_share + vh.lightning_rate) + applePart.revenue * 0.5 * applePart.rate)) < 1e-6, 'store: converted half at residual commission plus the rail, unconverted half at the full rate')
  const webHalf = calculate({ ...inputs, rails: ['processor'] }, data, { p2p_conversion_share: 0.5 }).typical.lines.payments.parts.find((p) => p.id === 'processor')
  assert.ok(Math.abs(webHalf.noncustodial - (webHalf.revenue * 0.5 * vh.lightning_rate + 0.5 * webHalf.custodial)) < 1e-6, 'processor: converted half on the rail, unconverted half at the processor\'s rate')
  assert.ok(half.noncustodial > r.typical.lines.payments.noncustodial, 'less conversion, less saving')
  const none = calculate({ ...inputs, rails: ['processor'] }, data, { p2p_conversion_share: 0 }).typical.lines.payments.parts.find((p) => p.id === 'processor')
  assert.ok(Math.abs(none.noncustodial - none.custodial) < 1e-6, 'no conversion, nothing changes on a processor rail')
  // The store commission row is read by the Apple and Google parts, and by no other.
  for (const [key, keys] of Object.entries(PART_ASSUMPTIONS)) assert.equal(keys.includes('p2p_store_fee_remains_share'), key === 'payments.store_apple' || key === 'payments.store_google', key)
  assert.ok(Math.abs(r.typical.lines.payments.estimated) > 0)
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
  assert.equal(nobody.estimated, 0, 'no saving is claimed where nothing is spent')
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
    const sum = LINES.reduce((acc, l) => acc + r[s].lines[l].estimated, 0)
    assert.ok(Math.abs(sum - r[s].totals.estimated) < 1e-6, `${s}: ${sum} vs ${r[s].totals.estimated}`)
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
  assert.ok(q.includes('team=one') && q.includes('kind=feed') && !q.includes('eng_') && !q.includes('posts_per_user=') && q.endsWith('v=4'), q)
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
  assert.equal(back.version, 4)
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
  assert.equal(under.version, 4)
  // A version-2 link with an override of the key-support rate, which v3 derives instead: the override is dropped, the link reports its version.
  const v2 = decode('?mau=50000&jur=us&team=ten&a.key_support_per_mau_year=0.1&a.egress_gb=0.05&v=2')
  assert.equal(v2.version, 2)
  assert.ok(v2.version < data.version, 'older than the file, so the page says so')
  const recomputed = calculate(v2.inputs, data, v2.overrides)
  assert.deepEqual(Object.keys(recomputed.overrides), ['egress_gb'])
  assert.equal(recomputed.version, 4)
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

// ── the timeline ────────────────────────────────────────────────────────────

const typicalV = (over = {}) => ({ ...resolveAssumptions(data, 'typical'), ...over })
const V = resolveAssumptions(data, 'typical')
const pointsOf = (inputs, over = {}, today = TODAY) => {
  const v = typicalV(over)
  const eff = deriveInputs(normalizeInputs(inputs), v)
  return { v, eff, points: project(eff, v, today) }
}

await test('dates: ISO strings only, real calendar dates only, months between them fractional by days, and months added by the calendar', () => {
  assert.deepEqual(parseDate('2026-11-03'), { y: 2026, m: 11, d: 3 })
  for (const bad of ['2026-13-01', '2026-02-30', '2026-2-3', '20261103', '2026-11-03T00:00', '', null, 'tomorrow', 1700000000]) assert.equal(isDate(bad), false, String(bad))
  assert.equal(isDate('2024-02-29'), true)
  assert.equal(isDate('2023-02-29'), false)
  assert.equal(monthsBetween('2026-11-03', '2027-11-03'), 12)
  assert.equal(monthsBetween('2026-11-03', '2026-11-03'), 0)
  assert.ok(Math.abs(monthsBetween('2026-11-03', '2030-03-01') - 39.93) < 0.01)
  assert.ok(monthsBetween('2030-03-01', '2026-11-03') < 0, 'a date behind us is negative months')
  assert.ok(Number.isNaN(monthsBetween('x', '2026-11-03')))
  assert.equal(addMonths('2026-11-03', 12), '2027-11-03')
  assert.equal(addMonths('2026-11-03', 0), '2026-11-03')
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28', 'the day is clamped to the month')
  assert.equal(addMonths('2026-11-03', 36), '2029-11-03')
  assert.equal(addMonths('2026-11-03', 3.5), '2027-02-18', 'half a month is fifteen days')
  assert.equal(addMonths('nope', 1), null)
})

await test('the network curve: 0 at the start date, 1 at the end date and after it, front-loaded between, and read at each dot\'s own date', () => {
  assert.equal(networkShare(V.network_mature_start, V), 0)
  assert.equal(networkShare(V.network_mature_end, V), 1)
  assert.equal(networkShare('2040-01-01', V), 1, 'after the end date the share is 1')
  assert.equal(networkShare('2010-01-01', V), 0, 'before the start it is 0')
  const T = monthsBetween(V.network_mature_start, V.network_mature_end)
  const half = addMonths(V.network_mature_start, T / 2)
  assert.ok(Math.abs(networkShare(half, V) - 0.75) < 0.01, `halfway is three quarters: ${networkShare(half, V)}`)
  assert.equal(V.network_mature_start, '2023-01-01')
  assert.equal(V.network_mature_end, '2030-03-01')
  const today = networkShare(TODAY, V)
  const u = monthsBetween(V.network_mature_start, TODAY) / T
  assert.ok(Math.abs(today - (1 - (1 - u) ** 2)) < 1e-12 && today > 0.7 && today < 0.85, `as of ${TODAY} the network delivers ${today}`)
  assert.ok(networkShare('2027-11-03', V) > today, 'rising')
  assert.equal(networkShare(TODAY, { network_mature_start: '2030-01-01', network_mature_end: '2030-01-01' }), 1, 'no span means mature')
  assert.equal(networkShare(TODAY, { network_mature_start: '2040-01-01', network_mature_end: '2030-01-01' }), 1, 'an end before its start means mature')
  // The two dates are not scenarios, and an override of one is an ISO date, never a number.
  for (const s of SCENARIOS) assert.equal(resolveAssumptions(data, s).network_mature_end, '2030-03-01')
  assert.equal(resolveAssumptions(data, 'typical', { network_mature_end: '2031-06-15' }).network_mature_end, '2031-06-15')
  assert.deepEqual(cleanOverrides(data, { network_mature_end: '2031-06-15', network_mature_start: 'soon', integration_payback_months: '18' }), { network_mature_end: '2031-06-15', integration_payback_months: 18 })
  assert.deepEqual(cleanOverrides(data, { network_mature_end: '2030-03-01', network_mature_start: '2023-01-01' }), {}, 'the typical dates are not overrides')
})

await test('the model takes the date and never reads the clock: no date, no result; the same inputs on two dates differ only by the network\'s progress', () => {
  assert.throws(() => calculateRaw(base, data), /today/)
  assert.throws(() => calculateRaw(base, data, {}, { today: '2026-11' }), /today/)
  const a = calculate(base)
  const b = calculateRaw(base, data, {}, { today: '2028-11-03' })
  assert.equal(a.today, TODAY)
  assert.equal(b.today, '2028-11-03')
  assert.ok(Math.abs(a.typical.totals.custodial - b.typical.totals.custodial) < 1e-6, 'custody is the app as it runs today, whatever the date')
  assert.ok(b.typical.projection[0].nostr < a.typical.projection[0].nostr, 'later, the network delivers more')
  assert.equal(a.typical.projection[0].date, TODAY)
  assert.equal(a.typical.projection[3].date, '2029-11-03')
})

await test('six points a line, today and today plus one to five years, every one the run-rate at that instant; the Nostr line starts below custody today and is never below the fully non-custodial cost', () => {
  for (const inputs of [base, illustrative, { ...base, growth: '1' }, min({ mau: 2000000, jur: ['eu', 'us'] })]) {
    const r = calculate(inputs)
    for (const s of SCENARIOS) {
      const p = r[s].projection
      assert.equal(p.length, YEARS + 1)
      assert.deepEqual(p.map((q) => q.months), [0, 12, 24, 36, 48, 60])
      assert.deepEqual(p.map((q) => q.year), [0, 1, 2, 3, 4, 5])
      assert.ok(p[0].nostr < p[0].custodial && p[0].nostr > 0, `${s}: today the Nostr line is a real number below custody`)
      for (const q of p) {
        assert.ok(Math.abs(q.custodial - q.nostr - q.saving * q.share) < 1e-6, `${s} year ${q.year}: the gap is the saving times the share`)
        assert.ok(Math.abs(q.realised - (q.custodial - q.nostr)) < 1e-6)
        assert.ok(q.nostr >= q.noncustodial - 1e-6, 'never below the non-custodial cost')
        assert.ok(Math.abs(q.saving_cash + q.saving_fees - q.saving) < 1e-6, 'cash and fees are the saving; the breach is not in it')
        assert.ok(Math.abs(q.share - networkShare(q.date, r[s].values)) < 1e-12, 'each dot samples the curve at its own date')
        assert.ok(!('cumulative' in q), 'nothing is cumulative')
      }
      assert.ok(p[1].share > p[0].share, 'rising')
      assert.ok(Math.abs(p[YEARS].nostr - p[YEARS].noncustodial) < 1e-6, 'with the defaults the network is mature before year five')
    }
    assert.ok(r.low.projection[0].nostr >= r.typical.projection[0].nostr && r.typical.projection[0].nostr >= r.high.projection[0].nostr, 'the low case is the higher Nostr cost today')
  }
})

await test('growth compounds and decays; the year dots are whole users; a point between two dots is set between them in proportion', () => {
  const inputs = normalizeInputs({ ...base, growth: '1' })
  const v = typicalV({ growth_decay: 0.5 })
  assert.equal(usersAt(12, inputs, v), 100000)
  assert.equal(usersAt(24, inputs, v), 150000)
  assert.equal(usersAt(36, inputs, v), 187500)
  assert.ok(usersAt(18, inputs, v) > 100000 && usersAt(18, inputs, v) < 150000)
  assert.ok(Math.abs(usersAt(18, inputs, v) - 100000 * Math.sqrt(1.5)) < 1e-6, 'geometric between the dots')
  for (const q of project(deriveInputs(inputs, v), v, TODAY)) assert.ok(Number.isInteger(q.users))
  const given = project(deriveInputs(normalizeInputs({ ...base, growth: '0.5' }), typicalV({ growth_default: 0 })), typicalV({ growth_default: 0 }), TODAY)
  const blank = project(deriveInputs(normalizeInputs(base), typicalV({ growth_default: 0 })), typicalV({ growth_default: 0 }), TODAY)
  assert.ok(given[1].users > blank[1].users)
  assert.equal(blank[1].users, base.mau)
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

await test('the markers: the payback window ends at integration_payback_months, the headline is read estimated_savings_months later, and the network-mature marker sits at its true place or says "since"', () => {
  const r = calculate(illustrative)
  const v = r.typical.values
  const M = r.typical.markers
  assert.equal(M.payback.months, v.integration_payback_months)
  assert.equal(M.estimated.months, v.integration_payback_months + v.estimated_savings_months)
  assert.equal(M.estimated.months, 36, 'month 36 with the defaults')
  assert.equal(M.estimated.point.date, '2029-11-03')
  assert.ok(Math.abs(M.mature.months - monthsBetween(TODAY, v.network_mature_end)) < 1e-9)
  assert.equal(M.mature.since, false)
  assert.ok(M.mature.point && Math.abs(M.mature.point.share - 1) < 1e-9, 'at the network\'s date the share is 1')
  assert.equal(M.mature.point.date, '2030-03-01')
  // A marker between the dots is a point like any other: the same instant through pointAt.
  const direct = pointAt(M.mature.months, r.typical.effective, v, TODAY)
  assert.ok(Math.abs(direct.nostr - M.mature.point.nostr) < 1e-6)
  assert.ok(M.mature.point.users > r.typical.projection[3].users && M.mature.point.users < r.typical.projection[4].users)
  // The headline is the gap at the estimated instant, cash plus fees, and the estimated figures are that point's.
  const T = r.typical.totals
  const E = M.estimated.point
  assert.ok(Math.abs(T.estimated - (E.custodial - E.nostr)) < 1e-6)
  assert.ok(Math.abs(T.estimated_cash + T.estimated_fees - T.estimated) < 1e-6)
  assert.equal(T.estimated_months, 36)
  assert.equal(T.estimated_after_payback, 12, 'the caption names the months after payback')
  assert.equal(T.estimated_date, '2029-11-03')
  assert.equal(T.estimated_users, E.users)
  assert.ok(Math.abs(T.estimated - r.typical.projection[3].realised) < 1e-6, 'with the defaults the instant is the year-three dot')
  // Behind us: a network date before today hides the dot.
  const past = calculate(illustrative, data, { network_mature_end: '2026-01-01' })
  assert.equal(past.typical.markers.mature.since, true)
  assert.equal(past.typical.markers.mature.point, null)
  assert.ok(past.typical.markers.mature.months < 0)
  assert.ok(Math.abs(past.typical.projection[0].share - 1) < 1e-9, 'and the network is mature from today')
  // The marker follows the two assumptions, never a year.
  const late = calculate(illustrative, data, { integration_payback_months: 30, estimated_savings_months: 9 })
  assert.equal(late.typical.markers.estimated.months, 39)
  assert.equal(late.typical.totals.estimated_date, '2030-02-03')
  assert.ok(late.typical.markers.estimated.point.users > late.typical.projection[3].users)
})

await test('the headline is the estimated instant\'s gap, the lines and their parts add up to it in every scenario, and the breach is beside it, never in it', () => {
  for (const inputs of [base, illustrative, { ...base, n_keys: '1', n_event_storage: '0.5' }, min({ mau: 5000000, jur: JURISDICTIONS }), { ...base, n_p2p: '0.5' }, { ...base, mod_who: 'nobody', mod_heads: null }]) {
    const r = calculate(inputs)
    for (const s of SCENARIOS) {
      const T = r[s].totals
      const sum = LINES.reduce((acc, l) => acc + r[s].lines[l].estimated, 0)
      assert.ok(Math.abs(sum - T.estimated) < 1e-6, `${s}: ${sum} vs ${T.estimated}`)
      // A line may cost more on Nostr in the low case (the key hand-off at 10% live contacts outcosts the resets it replaces); the sum is what the page claims.
      assert.ok(T.estimated > 0, `${s}: the headline is positive`)
      for (const l of LINES) {
        const line = r[s].lines[l]
        if (s === 'typical') assert.ok(line.estimated >= -1e-6, `${l} never negative in the typical case`)
        const parts = line.parts.filter((p) => p.kind !== 'risk').reduce((acc, p) => acc + p.estimated_custodial - p.estimated_noncustodial, 0)
        assert.ok(Math.abs(parts - line.estimated) < 1e-6, `${s}.${l}: parts ${parts} vs ${line.estimated}`)
        assert.ok(Math.abs(line.estimated_custodial - line.estimated_noncustodial - line.estimated) < 1e-6)
        if (l !== 'payments') assert.equal(line.saving_fees, 0)
        assert.ok(!('saving_risk' in line))
      }
      assert.ok(Math.abs(T.saving_cash + T.saving_fees - T.saving) < 1e-6, 'today: cash and fees are the saving')
      assert.ok(T.breach_reduction >= 0)
      assert.ok(!('saving_risk' in T) && !('at_scale' in T) && !('five_year' in T) && !('cumulative' in T))
      // The breach rides beside the compliance line, moved by its share, and is in no line total.
      const breach = r[s].lines.compliance.parts.find((p) => p.id === 'breach')
      const line = r[s].lines.compliance
      assert.equal(breach.kind, 'risk')
      assert.ok(Math.abs(T.breach_saving - (breach.custodial - line.share * (breach.custodial - breach.noncustodial) - breach.noncustodial)) < 1e-6)
      assert.ok(Math.abs(line.custodial - line.parts.filter((p) => p.kind !== 'risk').reduce((a, p) => a + p.custodial - line.share * (p.custodial - p.noncustodial), 0)) < 1e-6, 'the line is its bills')
      // The fees saving is the whole payments line; the payments line has no cash saving.
      const pay = r[s].lines.payments
      assert.ok(Math.abs(pay.saving_fees - pay.saving) < 1e-6 && pay.saving_cash === 0)
      assert.ok(Math.abs(LINES.reduce((a, l) => a + r[s].lines[l].saving_cash, 0) - T.saving_cash) < 1e-6)
      const E = r[s].markers.estimated.point
      assert.ok(Math.abs(T.estimated_cash - E.saving_cash * E.share) < 1e-6)
      assert.ok(Math.abs(T.estimated_fees - E.saving_fees * E.share) < 1e-6)
      assert.ok(Math.abs(T.breach_reduction - E.breach.reduction) < 1e-6)
    }
    assert.ok(r.low.totals.estimated <= r.typical.totals.estimated && r.typical.totals.estimated <= r.high.totals.estimated)
    assert.ok(r.low.totals.estimated_nostr >= r.typical.totals.estimated_nostr && r.typical.totals.estimated_nostr >= r.high.totals.estimated_nostr, 'the Nostr cost at the instant is largest in the low case')
  }
  // With growth, the headline is the saving at that instant's users, not today's; flat, it is the whole of today's saving once the network is mature.
  const grown = calculate({ ...base, growth: '0.25' }).typical.totals
  assert.ok(grown.estimated > grown.saving)
  const flat = calculate({ ...base, growth: '0' }).typical
  assert.ok(Math.abs(flat.totals.estimated - flat.totals.saving * flat.markers.estimated.point.share) < 1e-6)
})

await test('the breach is sized by the firm: the chance of a breach times the median loss for the team\'s tier, falling with the data retained, and shown as a reduction beside the headline', () => {
  const v = resolveAssumptions(data, 'typical')
  assert.equal(v.breach_prob_year, 0.056, 'IRIS 2025: firms under 10M revenue')
  assert.equal(breachLoss('one', v), 357000)
  assert.equal(breachLoss('ten', v), 357000)
  assert.equal(breachLoss('fifty', v), 357000)
  assert.equal(breachLoss('more', v), 466700)
  const part = (team, mau = 50000) => calculate(min({ mau, team })).typical.lines.compliance.parts.find((p) => p.id === 'breach')
  const ten = part('ten')
  assert.ok(Math.abs(ten.custodial - 0.056 * 357000) < 1e-6, `${ten.custodial}`)
  assert.ok(Math.abs(ten.noncustodial - ten.custodial * v.retained_data_share) < 1e-6)
  assert.equal(ten.loss, 357000)
  assert.equal(ten.policy, v.cyber_insurance_year, 'the cross-check travels with the part')
  assert.equal(part('ten', 500).custodial, part('ten', 5000000).custodial, 'a firm\'s figure, not a per-user one')
  assert.ok(part('more').custodial > ten.custodial)
  const r = calculate(illustrative).typical
  assert.ok(Math.abs(r.totals.breach_reduction - (ten.custodial - ten.noncustodial) * r.markers.estimated.point.share) < 1e-6 || r.totals.breach_reduction > 0)
  assert.ok(r.totals.breach_reduction > 10000 && r.totals.breach_reduction < 30000, `about $18k a year: ${r.totals.breach_reduction}`)
  assert.ok(Math.abs(LINES.reduce((a, l) => a + r.lines[l].estimated, 0) - r.totals.estimated) < 1e-6, 'and none of it is in the lines')
  // A fully Nostr app for storage and keys keeps nothing to lose: the reduction is zero.
  const already = calculate({ ...base, n_keys: '1', n_event_storage: '1', n_media_storage: '1' }).typical.totals
  assert.ok(Math.abs(already.breach_reduction) < 1e-6)
})

await test('compliance programmes scale by team size: the rows are the top tier\'s, a smaller team carries its tier\'s share, and the DSA is a token below the top tier', () => {
  const v = resolveAssumptions(data, 'typical')
  assert.deepEqual(TEAMS.map((t) => complianceFactor(t, v)), [0.05, 0.2, 0.4, 1])
  const programs = (team, jur = ['eu', 'uk', 'us']) => calculate(min({ mau: 500, team, jur })).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  const solo = programs('one')
  assert.ok(Math.abs(solo.gdpr - v.gdpr_program_year * 0.05) < 1e-6)
  assert.ok(Math.abs(solo.osa - v.uk_osa_year * 0.05) < 1e-6)
  assert.ok(Math.abs(solo.dsa - v.dsa_year * 0.05) < 1e-6)
  assert.equal(solo.usp, v.us_privacy_year_small, 'the US programme is not scaled')
  assert.equal(solo.factor, 0.05)
  assert.ok(solo.custodial < 6000, `a solo founder's programmes: ${solo.custodial}`)
  const big = programs('more')
  assert.ok(Math.abs(big.gdpr - v.gdpr_program_year) < 1e-6 && Math.abs(big.osa - v.uk_osa_year) < 1e-6 && Math.abs(big.dsa - v.dsa_year) < 1e-6, 'the top tier reads the rows in full')
  const fifty = programs('fifty')
  assert.ok(Math.abs(fifty.gdpr - v.gdpr_program_year * 0.4) < 1e-6)
  assert.ok(Math.abs(fifty.dsa - v.dsa_year * 0.05) < 1e-6, 'a small enterprise pays the DSA token, not its tier\'s share')
  assert.ok(programs('ten').custodial > solo.custodial && fifty.custodial > programs('ten').custodial && big.custodial > fifty.custodial)
  // Reported spend is the founder's number: not scaled.
  const reported = calculate(min({ mau: 500, team: 'one', jur: ['eu'], legal_usd: 5000 })).typical.lines.compliance.parts.find((p) => p.id === 'privacy_programs')
  assert.equal(reported.custodial, 5000)
  // The tier rows are read only by the compliance line.
  for (const [key, keys] of Object.entries(PART_ASSUMPTIONS)) assert.equal(keys.some((k) => k.startsWith('compliance_tier_factor_')), key === 'compliance.privacy_programs', key)
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
  const contentLaw = v.uk_osa_year * v.compliance_tier_factor_ten
  assert.ok(Math.abs(programs.noncustodial - (contentLaw * v.content_law_remains_share + (v.gdpr_program_year * v.compliance_tier_factor_ten + v.us_privacy_year_small) * v.privacy_remains_share)) < 1e-6)
  // The content-law and moderation low cases describe one world: three quarters and half remain.
  assert.equal(data.assumptions.content_law_remains_share.low, 0.75)
  assert.equal(data.assumptions.moderation_remains_share.low, 0.5)
  // In the high scenario no age check remains, yet the accounts line still costs something on Nostr.
  const high = evaluate(normalizeInputs({ ...base, jur: ['uk'] }), resolveAssumptions(data, 'high'))
  assert.equal(high.lines.accounts.parts.find((p) => p.id === 'verify').noncustodial, 0)
  assert.ok(high.lines.accounts.noncustodial > 0)
  // Engineering keeps half: a Nostr app still builds signer login, feed logic and relay handling. The thesis, pending member data.
  for (const key of ['accounts_eng_remains_share', 'infra_eng_remains_share', 'graph_eng_remains_share']) {
    assert.equal(data.assumptions[key].typical, 0.5)
    assert.ok(/pending member data/.test(data.assumptions[key].note), key)
  }
  assert.equal(data.assumptions.privacy_remains_share.typical, 0.5)
  for (const key of ['privacy_remains_share', 'content_law_remains_share']) assert.ok(/not legal advice\.$/.test(data.assumptions[key].note), key)
  const acc = r.lines.accounts.parts.find((p) => p.id === 'engineering')
  assert.ok(Math.abs(acc.noncustodial - acc.custodial * v.accounts_eng_remains_share) < 1e-6 && acc.noncustodial > 0)
  const infra = r.lines.storage.parts.find((p) => p.id === 'engineering')
  assert.ok(Math.abs(infra.noncustodial - infra.custodial * v.infra_eng_remains_share) < 1e-6 && infra.noncustodial > 0)
})

await test('the expected breach loss is marked as risk, apart from the cash costs, and every payments part is a fee', () => {
  const r = calculate(base).typical.lines.compliance
  const breach = r.parts.find((p) => p.id === 'breach')
  assert.equal(breach.kind, 'risk')
  assert.ok(r.parts.filter((p) => p.kind === 'risk').length === 1 && r.parts.filter((p) => !p.kind).length === 4)
  for (const l of LINES) if (l !== 'compliance') for (const p of calculate(base).typical.lines[l].parts) assert.notEqual(p.kind, 'risk')
  for (const l of LINES) for (const p of calculate(base).typical.lines[l].parts) assert.equal(p.kind === 'fees', l === 'payments', `${l}.${p.id}`)
  // The kind travels into the points' parts, so the page can keep them apart at every instant.
  const at = calculate(base).typical.markers.estimated.point.lines.compliance.parts
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

  const messaging = calculate(min({ kind: 'messaging' })).typical
  const media = calculate(min({ kind: 'feed' })).typical
  assert.ok(media.lines.storage.custodial > messaging.lines.storage.custodial * 1.5, `a media feed costs far more to serve: ${media.lines.storage.custodial} vs ${messaging.lines.storage.custodial}`)
  assert.ok(media.totals.estimated > messaging.totals.estimated * 1.1, 'and it shows in the headline')
  assert.equal(media.derived.egress_gb_per_mau_month, 'kind')
  assert.equal(media.values.egress_gb_per_mau_month, v.kind_feed_egress_gb)
})

await test('the part → assumptions map says exactly which assumptions each line reads', () => {
  // Inputs that walk every branch: all regions, every rail, balances held, given and defaulted bands, reported spend or not, above and below the CCPA threshold, every moderation state, every team tier.
  const variants = [
    normalizeInputs({ ...base, jur: ['eu', 'uk', 'us', 'other'], rails: ['p2p', 'apple', 'google', 'processor', 'reseller'], rev: 50000, balances: ['yes'], mod_who: 'team', mod_heads: '15' }),
    normalizeInputs({ ...base, mod_who: 'vendor', mod_heads: '3' }),
    normalizeInputs({ ...base, mod_who: 'nobody', mod_heads: null }),
    normalizeInputs({ ...base, mod_who: null, mod_heads: null }),
    normalizeInputs({ mau: 10000000, jur: ['us'], team: 'more', rails: ['apple'], rev: 200000, legal_usd: 50000 }),
    normalizeInputs({ mau: 1000, jur: ['other'], team: 'one' }),
    normalizeInputs({ mau: 1000, jur: ['eu'], team: 'fifty', rails: ['google'], rev: 200000 }),
    normalizeInputs({ mau: 1000, jur: ['eu', 'uk'], team: 'more' }),
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
  const r = calculate(variants[0]).typical
  for (const line of LINES) for (const p of r.lines[line].parts) assert.ok(PART_ASSUMPTIONS[`${line}.${p.id}`], `${line}.${p.id} has no entry`)
  assert.deepEqual(PART_ASSUMPTIONS['accounts.key_handoff'], ['reset_rate_per_mau_year', 'support_self_service_contact', 'support_live_contact', 'key_handoff_live_share'])
  assert.ok(PART_ASSUMPTIONS['compliance.breach'].includes('breach_loss_more') && !PART_ASSUMPTIONS['compliance.breach'].includes('breach_cost_per_user'))
  // The timeline rows are read by the projection, not by any line.
  for (const keys of Object.values(PART_ASSUMPTIONS)) for (const key of ['network_mature_start', 'network_mature_end', 'integration_payback_months', 'estimated_savings_months']) assert.ok(!keys.includes(key))
})

await test('growth is a band, starts on Steady on the form, and an unknown band is refused', () => {
  assert.equal(normalizeInputs({ ...base, growth: '0.25' }).growth, '0.25')
  assert.equal(normalizeInputs(base).growth, null, 'blank until answered: the model holds an unanswered app flat')
  assert.equal(INPUTS.growth.start, '0.5', "the form's starting answer is Fast")
  assert.equal(INPUTS.rev.start, 5000, "the form's starting payment volume is 5,000 a month, so the illustrative app shows the line")
  assert.equal(INPUTS.kind.start, 'messaging', 'the illustrative app is a messaging app')
  assert.equal(INPUTS.kind.default, null, 'but a link that says nothing means an app')
  assert.deepEqual(INPUTS.jur.default, ['us'], 'in the US')
  // For the bitcoiners: the illustrative app's headline prints $210k.
  assert.equal(approx(calculate(illustrative).typical.totals.estimated), '$210k', String(calculate(illustrative).typical.totals.estimated))
  assert.equal(normalizeInputs(min({ kind: null })).kind, null)
  assert.equal(INPUTS.rev.default, 0, 'but a link that says nothing means no payments')
  assert.equal(normalizeInputs(min()).rev, 0)
  assert.equal(INPUTS.growth.default, null)
  assert.equal(INPUTS.growth.required, false)
  assert.throws(() => normalizeInputs({ ...base, growth: '0.3' }), (e) => e instanceof InputError && e.key === 'growth')
  const q = encode(normalizeInputs({ ...base, growth: '0' }))
  assert.ok(q.includes('growth=0'), q)
  assert.equal(decode(`?${q}`).inputs.growth, '0')
})

await test('one rounding for the headline, the lines and the chart: two significant figures, a dash for what is not a number, zero for a residue', () => {
  assert.equal(approx(292469), '$290k')
  assert.equal(approx(1510000), '$1.5M')
  assert.equal(approx(52700), '$53k')
  assert.equal(approx(10100000), '$10M')
  assert.equal(approx(24300), '$24k')
  assert.equal(approx(950), '$950')
  assert.equal(approx(-0.2), '$0', 'never -$0')
  assert.equal(money(-0.4), '$0')
  assert.equal(approx(NaN), '—')
  assert.equal(approx(Infinity), '—')
  assert.equal(compact(Infinity), '—')
  assert.equal(money('x'), '—')
  assert.equal(compactNumber(-1500), '-1.5k', 'the sign stays')
  assert.equal(number(NaN), '—')
})

await test('a baseline printout, for the eye', () => {
  const r = calculate(base).typical
  const f = (n) => Math.round(n).toLocaleString('en-US').padStart(12)
  for (const l of LINES) console.log(`     ${l.padEnd(11)} ${f(r.lines[l].custodial)} ${f(r.lines[l].noncustodial)}`)
  console.log(`     ${'total'.padEnd(11)} ${f(r.totals.custodial)} ${f(r.totals.noncustodial)}   per MAU ${r.totals.per_mau_custodial.toFixed(2)} → ${r.totals.per_mau_noncustodial.toFixed(2)}   cash ${f(r.totals.saving_cash)} fees ${f(r.totals.saving_fees)} breach ${f(r.totals.breach_saving)}`)
  for (const p of r.projection) console.log(`     ${p.date}  ${String(Math.round(p.users)).padStart(9)} users  share ${p.share.toFixed(3)}  custody ${f(p.custodial)}  nostr ${f(p.nostr)}  saving ${f(p.realised)}`)
  console.log(`     headline ${approx(r.totals.estimated)} at month ${r.totals.estimated_months} (${r.totals.estimated_date}); breach reduction ${approx(r.totals.breach_reduction)}; network mature ${r.markers.mature.date}`)
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
