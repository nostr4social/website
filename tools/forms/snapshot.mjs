// Snapshot the calculator's form from Nostr into _data/forms/calculator.yml.
//
//   npm run snapshot:form -- naddr1...
//
// Fetches the kind 30168 template the naddr points at, checks it against the
// recipe (every question the page sends must exist, by label), and writes the
// snapshot the page submits against. Re-run after editing the form in the
// builder; check:form fails the build until you do.

import { writeFile } from 'node:fs/promises'
import { fetchTemplate, mapRecipe, parseTemplate, pointerFrom, readRecipe, SNAPSHOT, snapshotYaml } from './lib.mjs'

const naddr = process.argv[2]
if (!naddr) {
  console.error('usage: npm run snapshot:form -- <naddr>')
  process.exit(2)
}
const pointer = pointerFrom(naddr)
const { event, relays } = await fetchTemplate(pointer)
if (!event) {
  console.error(`no template found on ${relays.join(', ')}`)
  process.exit(1)
}
const snapshot = parseTemplate(event)
const recipe = await readRecipe()
const { missing } = mapRecipe(snapshot, recipe)
console.log(`form "${snapshot.name}" by ${snapshot.pubkey.slice(0, 8)}… d=${snapshot.d}: ${snapshot.fields.length} questions, ${snapshot.relays.length} relays`)
if (snapshot.encrypted) console.error('WARN the template is encrypted; the page cannot read an encrypted form')
if (!snapshot.anonymous_allowed) console.error('WARN the form disallows anonymous responses; the page submits anonymously')
for (const m of missing) console.error('MISSING ' + m)
await writeFile(SNAPSHOT, snapshotYaml(snapshot, naddr))
console.log(`wrote ${SNAPSHOT}${missing.length ? ` with ${missing.length} question(s) missing — fix the form and run again` : ''}`)
process.exit(missing.length ? 1 : 0)
