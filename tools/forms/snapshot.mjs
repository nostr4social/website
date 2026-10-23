// Snapshot the calculator's form from Nostr into _data/forms/calculator.yml.
//
//   npm run snapshot:form              # the form the snapshot already names
//   npm run snapshot:form -- naddr1... # a different form, or the first time
//
// Fetches the kind 30168 template the naddr points at and writes the
// snapshot the page submits against. The naddr is the form's permanent
// address (its key and its d tag); edits in the builder keep it. Then check the id map beside it still
// fits (`npm run check:form`); edit _data/forms/map.yml if a question was
// added or replaced. Re-run after editing the form in the builder.

import { writeFile } from 'node:fs/promises'
import { checkMap, fetchTemplate, parseTemplate, pointerFrom, readMap, readSnapshot, SNAPSHOT, snapshotYaml } from './lib.mjs'

let naddr = process.argv[2]
if (!naddr) {
  try {
    naddr = (await readSnapshot()).naddr
  } catch {
    console.error('usage: npm run snapshot:form -- <naddr>   (no snapshot exists yet to take the address from)')
    process.exit(2)
  }
}
const pointer = pointerFrom(naddr)
const { event, relays } = await fetchTemplate(pointer)
if (!event) {
  console.error(`no template found on ${relays.join(', ')}`)
  process.exit(1)
}
const snapshot = parseTemplate(event)
console.log(`form "${snapshot.name}" by ${snapshot.pubkey.slice(0, 8)}… d=${snapshot.d}: ${snapshot.fields.length} questions, ${snapshot.relays.length} relays`)
if (snapshot.encrypted) console.error('WARN the template is encrypted; the page cannot read an encrypted form')
if (!snapshot.anonymous_allowed) console.error('WARN the form disallows anonymous responses; the page submits anonymously')
await writeFile(SNAPSHOT, snapshotYaml(snapshot, naddr))
console.log(`wrote ${SNAPSHOT}`)
let missing = []
try {
  missing = checkMap(snapshot, await readMap())
} catch {
  console.log('--   no _data/forms/map.yml yet; write one from the snapshot')
}
for (const m of missing) console.error('MISSING ' + m)
process.exit(missing.length ? 1 : 0)
