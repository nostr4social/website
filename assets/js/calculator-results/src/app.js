// /calculator/responses/ — the saved calculations, for the form's key holder.
//
// Read top to bottom. The page is empty until a signer that is the form's
// key (or hello's, which holds the form's secret in its formstr My Forms
// list) signs in through the shared sign dialog. Then: every kind 1069
// response tagged with the form's address is read from the site's relays,
// screened by the reader policy the tools share (the form's a tag, the
// signature, proof of work for an unverified key, duplicates collapsed, the
// test flag), decrypted in memory, and shown as one row each, with the
// headline recomputed through the model from the saved answers, the saved
// assumptions version and the saved date, so an old response shows what
// the person saw. Filters and sorts are in memory; the CSV is made here.
// Nothing is sent anywhere.

import { $, $$, clear, el } from '../../shared/src/dom.js'
import { config, dev, fmt, readJson, t } from '../../shared/src/config.js'
import { SimplePool, getConversationKey, nip44Decrypt, verifyEvent } from '../../shared/src/vendor.js'
import { detectNip07, hexToBytes } from '../../shared/src/signers.js'
import { createSignIn } from '../../shared/src/signin.js'
import { discoveryRelays, normalizeRelay, siteRelays } from '../../shared/src/relays.js'
import { formAddress, KIND_RESPONSE, readResponses } from '../../shared/src/forms.js'
import { screenResponses } from '../../shared/src/policy.js'
import { secretAsHolder } from '../../calculator/src/restore.js'
import { calculate } from '../../calculator/src/model.js'
import { approx, date as formatDate } from '../../calculator/src/format.js'

const snapshot = readJson('page-form')
const map = readJson('page-map')
const versions = readJson('page-assumptions-all')
const address = formAddress(snapshot)

let signIn = null
let decrypted = [] // every response read, decrypted where the key allowed, before the policy
let known = new Set() // authors with a profile: signed in
let rows = [] // the kept responses, as the table's rows
let dropped = []

/** Where to read: the site's relays, unless localhost overrides them. */
function relays() {
  if (dev.local && dev.relays.length) return [...new Set(dev.relays.map(normalizeRelay).filter(Boolean))]
  return siteRelays()
}

function status(message) {
  const node = $('#inbox-status')
  if (node) node.textContent = message || ''
}

/** How this signer opens a response: as the form's key, or as a holder with the form's secret. */
async function opener(signer) {
  if (signer.pubkey === snapshot.pubkey) return (event) => signer.nip44Decrypt(event.pubkey, event.content)
  const secret = await secretAsHolder(signer, snapshot)
  if (!secret) return null
  const key = hexToBytes(secret)
  return async (event) => nip44Decrypt(event.content, getConversationKey(key, event.pubkey))
}

/** The inputs the calculator reads, from a response's values keyed like the map. */
function inputsOf(v) {
  const one = (x) => (Array.isArray(x) ? x[0] : x)
  const inputs = {
    mau: v.mau, posts_per_user: v.posts_per_user, mb: v.mb, legal_usd: v.legal_usd, p2p_volume: v.p2p_volume ?? v.rev,
    rails: v.rails, balances: v.balances, distribution: v.distribution, jur: v.jur,
    growth: one(v.growth), nostr_now: one(v.nostr_now), kind: one(v.kind), mod_who: one(v.mod_who), mod_heads: one(v.mod_heads), team: one(v.team),
  }
  for (const [area, hours] of Object.entries(v.engineering || {})) inputs[`eng_${area}`] = hours
  for (const [row, share] of Object.entries(v.nostr || {})) inputs[`n_${row}`] = share
  return inputs
}

/** The date a response was calculated as of: the t= in its saved link, else the day it was saved. */
function dateOf(v, event) {
  try {
    const t = new URL(v.link).searchParams.get('t')
    if (t && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  } catch {
    /* no link, or not a URL */
  }
  return new Date(event.created_at * 1000).toISOString().slice(0, 10)
}

/**
 * The headline for a row: recomputed through the model with the saved
 * version's assumptions and the saved date, when the page has that
 * version; otherwise the two figures the response saved, said as such.
 */
function headlineOf(v, event) {
  const version = Number(v.version)
  const data = versions[String(version)]
  if (data) {
    try {
      let overrides = {}
      try {
        const parsed = v.overrides ? JSON.parse(v.overrides) : {}
        overrides = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        overrides = {}
      }
      const r = calculate(inputsOf(v), data, overrides, { today: dateOf(v, event) })
      return { value: r.typical.totals.estimated, text: approx(r.typical.totals.estimated), inputs: r.inputs }
    } catch {
      /* fall through to the saved figures */
    }
  }
  const custodial = Number(v.result_custodial)
  const nostr = Number(v.result_noncustodial)
  const value = Number.isFinite(custodial) && Number.isFinite(nostr) ? custodial - nostr : NaN
  return { value, text: Number.isFinite(custodial) ? fmt(t('row.saved'), { custodial: approx(custodial), nostr: approx(nostr), version: Number.isFinite(version) ? version : '?' }) : t('row.none'), inputs: null }
}

/** Read, screen, decrypt, and build the rows. */
async function load(signer) {
  status(t('status.connecting'))
  const open = await opener(signer)
  if (!open) {
    status(t('status.wrong_key'))
    return show([], [])
  }
  const pool = new SimplePool()
  let events = []
  let profiles = []
  try {
    events = await pool.querySync(relays(), { kinds: [KIND_RESPONSE], '#a': [address] }, { maxWait: config.timeouts.discovery * 2 })
    const seen = new Map()
    for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e)
    events = [...seen.values()]
    const authors = [...new Set(events.map((e) => e.pubkey))]
    if (authors.length) {
      const where = dev.local && dev.relays.length ? relays() : discoveryRelays()
      profiles = await pool.querySync(where, { kinds: [0], authors }, { maxWait: config.timeouts.profile }).catch(() => [])
    }
  } finally {
    pool.destroy()
  }
  known = new Set(profiles.map((p) => p.pubkey))
  decrypted = []
  for (const event of events) {
    let answers = null
    try {
      const list = JSON.parse(await open(event))
      answers = Array.isArray(list) ? list : null
    } catch {
      answers = null
    }
    decrypted.push({ event, answers })
  }
  screen()
}

/** The policy over what was read: proof of work for an unverified key is asked while the toggle is on, which is the default. */
function screen() {
  const required = $('#inbox-pow') ? $('#inbox-pow').checked : true
  const screened = screenResponses(decrypted, { address, minPow: required ? Number(config.pow?.response ?? 0) : 0, known, verify: verifyEvent, testId: map.fields.test?.id, testOption: map.fields.test?.options?.yes })
  const kept = screened.kept.map((k) => {
    const v = k.answers ? readResponses(map, k.answers) : {}
    const headline = headlineOf(v, k.event)
    const one = (x) => (Array.isArray(x) ? x[0] : x)
    return {
      id: k.event.id,
      version: Number(v.version) || 0,
      date: new Date(k.event.created_at * 1000),
      test: k.test,
      tier: k.label,
      name: v.contact_name || '',
      email: v.email || '',
      kind: one(v.kind) || '',
      mau: Number(v.mau) || 0,
      team: one(v.team) || '',
      regions: Array.isArray(v.jur) ? v.jur : [],
      volume: Number(v.p2p_volume ?? v.rev) || 0,
      savings: headline.value,
      savingsText: headline.text,
      link: v.link || '',
      undecryptable: !k.answers,
    }
  })
  const refused = screened.dropped.map((d) => ({ id: d.event?.id?.slice(0, 12) || '?', reason: d.reason }))
  for (const k of kept) if (k.undecryptable) refused.push({ id: k.id.slice(0, 12), reason: 'undecryptable' })
  show(kept.filter((k) => !k.undecryptable), refused)
}

/** The oldest assumptions version this page recomputes: the first file from 4 on. */
const RECENT = Math.min(...Object.keys(versions).map(Number).filter(Number.isFinite), 4)

/** The version filter's options: recent and up (the default), all, then each version the responses carry. */
function versionOptions() {
  const select = $('#inbox-version')
  if (!select) return
  const chosen = select.value || 'recent'
  clear(select)
  select.append(el('option', { value: 'recent', text: fmt(select.dataset.recent, { n: RECENT }) }))
  select.append(el('option', { value: 'all', text: select.dataset.all }))
  for (const n of [...new Set(rows.map((r) => r.version))].filter((n) => n > 0).sort((a, b) => b - a)) select.append(el('option', { value: String(n), text: fmt(select.dataset.one, { n }) }))
  select.value = [...select.options].some((o) => o.value === chosen) ? chosen : 'recent'
}

function show(kept, refused) {
  rows = kept
  dropped = refused
  $('#inbox-tools').hidden = false
  versionOptions()
  render()
}

/** The rows that pass the filters, in the chosen order. */
function visible() {
  const mode = $('#inbox-mode')?.value || 'live'
  const tier = $('#inbox-tier')?.value || 'all'
  const contact = $('#inbox-contact')?.checked
  const sort = $('#inbox-sort')?.value || 'date'
  const version = $('#inbox-version')?.value || 'recent'
  const byVersion = (r) => (version === 'all' ? true : version === 'recent' ? r.version >= RECENT : r.version === Number(version))
  const out = rows.filter((r) => byVersion(r) && (mode === 'all' || (mode === 'test') === r.test) && (tier === 'all' || r.tier === tier) && (!contact || r.email || r.name))
  out.sort((a, b) => (sort === 'savings' ? (Number.isFinite(b.savings) ? b.savings : -1) - (Number.isFinite(a.savings) ? a.savings : -1) : b.date - a.date))
  return out
}

function render() {
  const list = visible()
  const body = $('#inbox-rows')
  const table = $('#inbox-table')
  const count = $('#inbox-count')
  if (!body || !table || !count) return
  clear(body)
  for (const r of list) {
    const cells = [
      el('td', { text: r.date.toISOString().slice(0, 16).replace('T', ' ') }),
      el('td', { text: r.version ? `v${r.version}` : '' }),
      el('td', { text: r.test ? t('row.yes') : t('row.no') }),
      el('td', { text: t(`row.${r.tier === 'signed-in' ? 'signed' : 'unverified'}`) }),
      el('td', { text: r.name }),
      el('td', { text: r.email }),
      el('td', { text: r.kind ? t(`kind.${r.kind}`, r.kind) : '' }),
      el('td', { class: 'is-num', text: r.mau ? r.mau.toLocaleString('en-US') : '' }),
      el('td', { text: r.team ? t(`team.${r.team}`, r.team) : '' }),
      el('td', { text: r.regions.map((j) => j.toUpperCase()).join(', ') }),
      el('td', { class: 'is-num', text: r.volume ? approx(r.volume) : '' }),
      el('td', { class: 'is-num', text: r.savingsText }),
      el('td', {}, r.link ? [el('a', { href: r.link, text: t('row.open'), rel: 'noopener' })] : []),
    ]
    body.append(el('tr', { class: r.test ? 'is-test' : null, 'data-id': r.id }, cells))
  }
  table.hidden = list.length === 0
  count.hidden = false
  count.textContent = rows.length === 0 && dropped.length === 0 ? t('status.none') : fmt(t('status.count'), { shown: list.length, kept: rows.length, dropped: dropped.length })
  const details = $('#inbox-dropped')
  if (details) {
    details.hidden = dropped.length === 0
    $('#inbox-dropped-summary').textContent = `${t('status.dropped')} (${dropped.length})`
    const ul = $('#inbox-dropped-list')
    clear(ul)
    for (const d of dropped) ul.append(el('li', { text: fmt(t('status.reason'), d) }))
  }
  status('')
}

/** The visible rows as a CSV file, made here and handed to the browser. */
function csv() {
  const head = $$('#inbox-table thead th').map((th) => th.textContent)
  const quote = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`
  const lines = [head.map(quote).join(',')]
  for (const r of visible()) {
    lines.push([r.date.toISOString(), r.version || '', r.test ? 'yes' : 'no', r.tier, r.name, r.email, r.kind, r.mau || '', r.team, r.regions.join(' '), r.volume || '', Number.isFinite(r.savings) ? Math.round(r.savings) : '', r.link].map(quote).join(','))
  }
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' })
  const a = el('a', { href: URL.createObjectURL(blob), download: t('csv_name') })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  return lines
}

function onSigner(signer) {
  const dialog = $('#sign-modal')
  if (dialog?.open) dialog.close()
  if (!signer) {
    decrypted = []
    rows = []
    dropped = []
    $('#inbox-tools').hidden = true
    $('#inbox-table').hidden = true
    $('#inbox-count').hidden = true
    $('#inbox-dropped').hidden = true
    status(t('status.signed_out'))
    return
  }
  load(signer).catch((err) => {
    console.warn('results: could not load', err)
    status(t('status.wrong_key'))
  })
}

async function boot() {
  if (!$('#inbox')) return
  status(t('status.signed_out'))
  signIn = createSignIn({ onChange: onSigner })
  signIn.wire()
  signIn.markExtension(await detectNip07())
  $('#inbox-sign-open')?.addEventListener('click', () => {
    const dialog = $('#sign-modal')
    if (dialog && !dialog.open) dialog.showModal()
  })
  $('#sign-cancel')?.addEventListener('click', () => $('#sign-modal')?.close())
  for (const id of ['inbox-version', 'inbox-mode', 'inbox-tier', 'inbox-contact', 'inbox-sort']) $(`#${id}`)?.addEventListener('change', render)
  $('#inbox-pow')?.addEventListener('change', () => decrypted.length && screen())
  $('#inbox-csv')?.addEventListener('click', csv)
  // For the test harness: the CSV as text, without a download.
  window.__inboxCsv = () => {
    const head = $$('#inbox-table thead th').map((th) => th.textContent)
    return [head.join(','), ...visible().map((r) => [r.date.toISOString(), r.version, r.test ? 'yes' : 'no', r.tier, r.email, r.mau, Math.round(r.savings) || ''].join(','))].join('\n')
  }
  document.documentElement.dataset.results = 'ready'
}

boot()
