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
    fields.push({
      id,
      type: primitive,
      label: stripHtml(label),
      render: settings.renderElement || primitive,
      required: Boolean(settings.required),
      options: Array.isArray(options) ? options.map((o) => ({ id: o[0], label: stripHtml(o[1]) })) : [],
    })
  }
  const settings = parseJson(tag('settings'), {})
  return {
    pubkey: event.pubkey,
    d,
    name: stripHtml(tag('name') || ''),
    relays: event.tags.filter((t) => t[0] === 'relay').map((t) => t[1]),
    encrypted: event.content !== '',
    anonymous_allowed: !settings.disallowAnonymous,
    fields,
  }
}

/**
 * Match a snapshot to a recipe: { fields: { key: { label, options?: { value: label } } } }.
 * Returns { fields: { key: { id, type, options?: { value: optionId } } }, missing: [...] }.
 */
export function mapRecipe(snapshot, recipe) {
  const byLabel = new Map()
  for (const f of snapshot.fields) byLabel.set(normalizeLabel(f.label), f)
  const fields = {}
  const missing = []
  for (const [key, want] of Object.entries(recipe.fields)) {
    const f = byLabel.get(normalizeLabel(want.label))
    if (!f) {
      missing.push(`${key}: no question labelled "${want.label}"`)
      continue
    }
    const entry = { id: f.id, type: f.type }
    if (want.options) {
      entry.options = {}
      const optByLabel = new Map(f.options.map((o) => [normalizeLabel(o.label), o.id]))
      for (const [value, label] of Object.entries(want.options)) {
        const id = optByLabel.get(normalizeLabel(label))
        if (!id) missing.push(`${key}: no option labelled "${label}"`)
        else entry.options[value] = id
      }
    }
    fields[key] = entry
  }
  return { fields, missing }
}

/** The response tags for a set of values keyed like the recipe. Blank values are left out. */
export function buildResponses(mapping, values) {
  const out = []
  for (const [key, v] of Object.entries(values)) {
    const f = mapping.fields[key]
    if (!f) continue
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    let value
    if (f.options) {
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

export const formAddress = (snapshot) => `${KIND_FORM}:${snapshot.pubkey}:${snapshot.d}`
