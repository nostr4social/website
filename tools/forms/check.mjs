// Does the live form still match the snapshot the page was built against?
//
//   npm run check:form
//
// Passes when there is no snapshot yet (the page then submits nothing).
// Fails when the template on the relays differs from the snapshot in any id,
// type, label or option, or when the recipe no longer maps onto it.

import { readFile } from 'node:fs/promises'
import { fetchTemplate, mapRecipe, parseTemplate, pointerFrom, readRecipe, readSnapshot, SNAPSHOT, snapshotYaml } from './lib.mjs'

let snapshot
try {
  snapshot = await readSnapshot()
} catch {
  console.log('--   no snapshot at _data/forms/calculator.yml; the page submits nothing')
  process.exit(0)
}
const pointer = pointerFrom(snapshot.naddr)
const { event, relays } = await fetchTemplate(pointer, snapshot.relays)
if (!event) {
  console.error(`FAIL the template is not on ${relays.join(', ')}`)
  process.exit(1)
}
const live = parseTemplate(event)
const recipe = await readRecipe()
const { missing } = mapRecipe(live, recipe)
let failed = 0
const committed = await readFile(SNAPSHOT, 'utf8')
if (committed !== snapshotYaml(live, snapshot.naddr)) {
  console.error('FAIL the live template differs from the snapshot — run `npm run snapshot:form -- ' + snapshot.naddr + '`')
  failed++
} else console.log('ok   snapshot matches the live template')
for (const m of missing) {
  console.error('FAIL ' + m)
  failed++
}
if (!missing.length) console.log('ok   every question in the recipe is in the form')
process.exit(failed ? 1 : 0)
