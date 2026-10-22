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
export const MAP = resolve(root, '_data/forms/map.yml')
export { parseTemplate, buildResponses, checkMap, formAddress, KIND_FORM, KIND_RESPONSE } from '../../assets/js/shared/src/forms.js'

// Node's WebSocket re-fires onerror from close(); nostr-tools calls close()
// from onerror. A relay that refuses the connection would recurse forever.
class SafeWebSocket extends WebSocket {
  close(...args) {
    if (this.readyState >= WebSocket.CLOSING) return
    super.close(...args)
  }
}
useWebSocketImplementation(SafeWebSocket)

export const DEFAULT_RELAYS = [
  'wss://relay.formstr.app',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
]

export async function readMap() {
  return yaml.parse(await readFile(MAP, 'utf8'))
}

export async function readSnapshot() {
  return yaml.parse(await readFile(SNAPSHOT, 'utf8'))
}

export function pointerFrom(naddr) {
  const { type, data } = decode(naddr)
  if (type !== 'naddr') throw new Error('not an naddr')
  return data // { kind, pubkey, identifier, relays }
}

/**
 * One REQ to one relay over a raw socket: events until EOSE or the timeout,
 * then close. nostr-tools' pool recurses in Node when a relay refuses the
 * connection, and a template fetch needs nothing the pool adds.
 */
export function queryRelay(url, filter, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const events = []
    let done = false
    let ws
    const finish = () => {
      if (done) return
      done = true
      try {
        ws?.close()
      } catch { /* closing is best effort */ }
      resolve(events)
    }
    const timer = setTimeout(finish, timeout)
    try {
      ws = new WebSocket(url)
    } catch {
      clearTimeout(timer)
      return resolve(events)
    }
    const id = 'q' + Math.random().toString(36).slice(2, 10)
    ws.onopen = () => ws.send(JSON.stringify(['REQ', id, filter]))
    ws.onmessage = (m) => {
      let msg
      try {
        msg = JSON.parse(m.data)
      } catch {
        return
      }
      if (msg[0] === 'EVENT' && msg[1] === id) events.push(msg[2])
      else if (msg[0] === 'EOSE' && msg[1] === id) {
        clearTimeout(timer)
        finish()
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      finish()
    }
    ws.onclose = () => {
      clearTimeout(timer)
      finish()
    }
  })
}

/** The newest template for a pointer, from its own relays plus the defaults. */
export async function fetchTemplate(pointer, extraRelays = []) {
  const relays = [...new Set([...(pointer.relays || []), ...extraRelays, ...DEFAULT_RELAYS].map((r) => r.replace(/\/$/, '')))]
  const filter = { kinds: [pointer.kind], authors: [pointer.pubkey], '#d': [pointer.identifier] }
  const results = await Promise.all(relays.map((url) => queryRelay(url, filter)))
  let event = null
  for (const e of results.flat()) if (e && (!event || e.created_at > event.created_at)) event = e
  return { event, relays }
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
    if (f.grid) {
      lines.push('    rows:')
      for (const o of f.grid.rows) lines.push(`      - { id: ${o.id}, label: ${JSON.stringify(o.label)} }`)
      lines.push('    columns:')
      for (const o of f.grid.columns) lines.push(`      - { id: ${o.id}, label: ${JSON.stringify(o.label)} }`)
    }
  }
  return lines.join('\n') + '\n'
}
