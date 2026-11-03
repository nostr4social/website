// The shared machine configuration, read by the tools from the same file
// the pages read (_data/blocks/nostr_config.yml): the relay lists, the
// proof-of-work thresholds, the calculator mode. One place, so trimming a
// relay or raising the difficulty is one change for the site and the tools.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from '../forms/yaml.mjs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function readConfig() {
  return yaml.parse(readFileSync(resolve(root, '_data/blocks/nostr_config.yml'), 'utf8'))
}

const strip = (r) => String(r).trim().replace(/\/$/, '')

/** The site's relays: where responses go and where the readers look. */
export function siteRelays(config = readConfig()) {
  return [...new Set((config.relays?.site || []).map(strip))]
}

/** Relays for profile and relay-list lookups: the site's, plus any indexers. */
export function discoveryRelays(config = readConfig()) {
  return [...new Set([...(config.relays?.discovery || []), ...(config.relays?.site || [])].map(strip))]
}

/** NIP-13 thresholds, in leading zero bits, as the pages mine them. */
export function powConfig(config = readConfig()) {
  return { response: Number(config.pow?.response ?? 0), anonymous: Number(config.pow?.anonymous ?? 0), signed: Number(config.pow?.signed ?? 0) }
}

export function calculatorMode(config = readConfig()) {
  return config.calculator_mode === 'live' ? 'live' : 'test'
}
