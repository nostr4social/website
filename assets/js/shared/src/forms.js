// Nostr forms (NIP-101, as formstr.app implements it), the parts this site
// needs: read a form template into a plain snapshot, match the snapshot to a
// recipe that names each question by its label, and build the response tags
// a submission carries. No DOM, no network: the node tools and the page use
// the same code.
//
// A template is a kind 30168 event. Each question is a tag
//   ["field", id, primitive, label, optionsJson, settingsJson]
// where primitive is text | number | option | label | grid, optionsJson is a
// list of [optionId, label, config?], and settingsJson holds the builder's
// renderElement (shortText, number, radioButton, checkboxes, ...) and
// `required`. The builder stores labels as HTML, so they are compared with
// tags stripped and whitespace collapsed.
//
// A response is a kind 1069 event with ["a", "30168:<pubkey>:<d>"] and, in
// its NIP-44 encrypted content, a JSON list of
//   ["response", fieldId, value, metadataJson]
// where an option answer is the option id, several joined by ";".

export const KIND_FORM = 30168
export const KIND_RESPONSE = 1069

export function normalizeLabel(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

const parseJson = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback
  } catch {
    return fallback
  }
}

/** A plain object from a template event: what the page needs, nothing else. */
export function parseTemplate(event) {
  if (!event || event.kind !== KIND_FORM) throw new Error('not a form template')
  const tag = (name) => event.tags.find((t) => t[0] === name)?.[1]
  const d = tag('d')
  if (!d) throw new Error('template has no d tag')
  const fields = []
  for (const t of event.tags) {
    if (t[0] !== 'field') continue
    const [, id, primitive, label, optionsJson, settingsJson] = t
    const settings = parseJson(settingsJson, {})
    const options = parseJson(optionsJson, [])
    const field = {
      id,
      type: primitive,
      label: stripHtml(label),
      render: settings.renderElement || primitive,
      required: Boolean(settings.required),
      options: Array.isArray(options) ? options.map((o) => ({ id: o[0], label: stripHtml(o[1]) })) : [],
    }
    // A grid's "options" are {columns, rows}; an answer is {rowId: columnId}.
    if (primitive === 'grid' && options && !Array.isArray(options)) {
      field.options = []
      field.grid = {
        rows: (options.rows || []).map((r) => ({ id: r[0], label: stripHtml(r[1]) })),
        columns: (options.columns || []).map((c) => ({ id: c[0], label: stripHtml(c[1]) })),
      }
    }
    fields.push(field)
  }
  const settings = parseJson(tag('settings'), {})
  // The builder's placeholder for a description nobody wrote.
  const PLACEHOLDER = /^click to edit/i
  const clean = (text) => (text && !PLACEHOLDER.test(stripHtml(text)) ? stripHtml(text) : '')
  const sections = (Array.isArray(settings.sections) ? settings.sections : [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((sec) => ({ id: sec.id, title: clean(sec.title), description: clean(sec.description), questions: Array.isArray(sec.questionIds) ? sec.questionIds.slice() : [] }))
  return {
    pubkey: event.pubkey,
    d,
    name: stripHtml(tag('name') || ''),
    description: clean(settings.description),
    relays: event.tags.filter((t) => t[0] === 'relay').map((t) => t[1]),
    encrypted: event.content !== '',
    anonymous_allowed: !settings.disallowAnonymous,
    sections,
    fields,
  }
}

/**
 * The map names, by id, which question carries what. It is written once, by
 * hand, from the published template, and checked against it on every build:
 *
 *   fields:
 *     mau: { id: OKIJzE }
 *     pay: { id: 88UlKt, options: { p2p: Q9rNXl, apple: sO56FE } }
 *     eng_hours: { id: fIVb03, rows: { accounts: r4poWN }, columns: { "0": CW1BOL, "5": ark9hI } }
 *
 * Returns the ids in the map that the snapshot does not have.
 */
export function checkMap(snapshot, map) {
  const byId = new Map(snapshot.fields.map((f) => [f.id, f]))
  const missing = []
  for (const [key, m] of Object.entries(map.fields)) {
    const f = byId.get(m.id)
    if (!f) {
      missing.push(`${key}: no question with id ${m.id}`)
      continue
    }
    // A parsed template keeps a grid under `grid`; the snapshot file writes
    // `rows` and `columns` beside `options`. Accept either.
    const rows = f.grid?.rows || f.rows || []
    const columns = f.grid?.columns || f.columns || []
    for (const [value, oid] of Object.entries(m.options || {})) {
      if (!(f.options || []).some((o) => o.id === oid)) missing.push(`${key}.${value}: no option ${oid}`)
    }
    for (const [value, rid] of Object.entries(m.rows || {})) {
      if (!rows.some((r) => r.id === rid)) missing.push(`${key}.${value}: no row ${rid}`)
    }
    for (const [value, cid] of Object.entries(m.columns || {})) {
      if (!columns.some((c) => c.id === cid)) missing.push(`${key}.${value}: no column ${cid}`)
    }
  }
  return missing
}

/**
 * The response tags for a set of values keyed like the map. Blank values are
 * left out. An option answer is the option id, several joined by ";"; a grid
 * answer is { rowKey: columnKey } and becomes JSON of { rowId: columnId }.
 */
export function buildResponses(map, values) {
  const out = []
  for (const [key, v] of Object.entries(values)) {
    const f = map.fields[key]
    if (!f) continue
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    let value
    if (f.rows) {
      const cells = {}
      for (const [rowKey, colKey] of Object.entries(v)) {
        const rid = f.rows[rowKey]
        const cid = f.columns?.[String(colKey)]
        if (rid && cid) cells[rid] = cid
      }
      if (!Object.keys(cells).length) continue
      value = JSON.stringify(cells)
    } else if (f.options) {
      const list = Array.isArray(v) ? v : [v]
      value = list.map((x) => f.options[String(x)]).filter(Boolean).join(';')
      if (!value) continue
    } else {
      value = String(v)
    }
    out.push(['response', f.id, value, '{}'])
  }
  return out
}

/**
 * The inverse of buildResponses: response tags back into values keyed like
 * the map. An option answer becomes the value or list of values; a grid
 * answer becomes { rowKey: columnValue }; anything unmapped is ignored.
 */
export function readResponses(map, tags) {
  const byId = {}
  for (const [key, f] of Object.entries(map.fields)) byId[f.id] = { key, ...f }
  const flip = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [v, k]))
  const values = {}
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'response') continue
    const f = byId[tag[1]]
    if (!f) continue
    const raw = tag[2] ?? ''
    if (f.rows) {
      let cells
      try {
        cells = JSON.parse(raw)
      } catch {
        continue
      }
      const rows = flip(f.rows)
      const cols = flip(f.columns)
      const out = {}
      for (const [rid, cid] of Object.entries(cells || {})) if (rows[rid] && cols[cid] != null) out[rows[rid]] = cols[cid]
      values[f.key] = out
    } else if (f.options) {
      const opts = flip(f.options)
      const list = raw.split(';').map((id) => opts[id]).filter((v) => v != null)
      values[f.key] = list
    } else {
      values[f.key] = raw
    }
  }
  return values
}

/**
 * The form's secret from a formstr "My Forms" list (kind 14083), decrypted:
 * a JSON list of ["f", "<pubkey>:<d>", relay, "<secret>[:<viewKey>]"].
 * Returns the secret hex for this snapshot's form, or null.
 */
export function formSecretFromList(list, snapshot) {
  const want = `${snapshot.pubkey}:${snapshot.d}`
  for (const tag of Array.isArray(list) ? list : []) {
    if (!Array.isArray(tag) || tag[0] !== 'f' || tag[1] !== want) continue
    const secret = String(tag[3] || '').split(':')[0]
    if (/^[0-9a-f]{64}$/.test(secret)) return secret
  }
  return null
}

export const KIND_MY_FORMS = 14083

export const formAddress = (snapshot) => `${KIND_FORM}:${snapshot.pubkey}:${snapshot.d}`
