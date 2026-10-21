// Shared by the form tools: read the recipe and the snapshot, fetch a
// template from relays, and turn an naddr into a filter.
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { decode } from 'nostr-tools/nip19'
import yaml from './yaml.mjs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const SNAPSHOT = resolve(root, '_data/forms/calculator.yml')
export const RECIPE = resolve(root, '_data/forms/recipe.yml')
export { parseTemplate, mapRecipe, buildResponses, formAddress, KIND_FORM, KIND_RESPONSE } from '../../assets/js/shared/src/forms.js'

useWebSocketImplementation(WebSocket)

export const DEFAULT_RELAYS = [
  'wss://relay.formstr.app',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
]

export async function readRecipe() {
  return yaml.parse(await readFile(RECIPE, 'utf8'))
}

export async function readSnapshot() {
  return yaml.parse(await readFile(SNAPSHOT, 'utf8'))
}

export function pointerFrom(naddr) {
  const { type, data } = decode(naddr)
  if (type !== 'naddr') throw new Error('not an naddr')
  return data // { kind, pubkey, identifier, relays }
}

/** The newest template for a pointer, from its own relays plus the defaults. */
export async function fetchTemplate(pointer, extraRelays = []) {
  const relays = [...new Set([...(pointer.relays || []), ...extraRelays, ...DEFAULT_RELAYS])]
  const pool = new SimplePool()
  try {
    const event = await pool.get(relays, { kinds: [pointer.kind], authors: [pointer.pubkey], '#d': [pointer.identifier] }, { maxWait: 8000 })
    return { event, relays }
  } finally {
    pool.destroy()
  }
}

export function snapshotYaml(snapshot, naddr) {
  const lines = [
    '# A snapshot of the calculator form as published on Nostr (kind 30168).',
    '# Written by `npm run snapshot:form -- <naddr>`; `npm run check:form` fails',
    '# the build when the live template no longer matches it. The page submits',
    '# responses against the ids here and never fetches the template itself.',
    '',
    `naddr: ${naddr}`,
    `pubkey: ${snapshot.pubkey}`,
    `d: ${snapshot.d}`,
    `name: ${JSON.stringify(snapshot.name)}`,
    `encrypted: ${snapshot.encrypted}`,
    `anonymous_allowed: ${snapshot.anonymous_allowed}`,
    'relays:',
    ...snapshot.relays.map((r) => `  - ${r}`),
    'fields:',
  ]
  for (const f of snapshot.fields) {
    lines.push(`  - id: ${f.id}`)
    lines.push(`    type: ${f.type}`)
    lines.push(`    render: ${f.render}`)
    lines.push(`    required: ${f.required}`)
    lines.push(`    label: ${JSON.stringify(f.label)}`)
    if (f.options.length) {
      lines.push('    options:')
      for (const o of f.options) lines.push(`      - { id: ${o.id}, label: ${JSON.stringify(o.label)} }`)
    } else {
      lines.push('    options: []')
    }
  }
  return lines.join('\n') + '\n'
}
