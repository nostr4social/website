// Does the live form still match the snapshot the page was built against,
// and does the id map still fit it?
//
//   npm run check:form
//
// Passes when there is no snapshot yet (the page then submits nothing).

import { readFile } from 'node:fs/promises'
import { checkMap, fetchTemplate, parseTemplate, pointerFrom, readMap, readSnapshot, SNAPSHOT, snapshotYaml } from './lib.mjs'

let snapshot
try {
  snapshot = await readSnapshot()
} catch {
  console.log('--   no snapshot at _data/forms/calculator.yml; the page submits nothing')
  process.exit(0)
}
let failed = 0
const map = await readMap()
for (const m of checkMap(snapshot, map)) {
  console.error('FAIL map: ' + m)
  failed++
}
if (!failed) console.log('ok   every id in the map is in the snapshot')

const pointer = pointerFrom(snapshot.naddr)
const { event, relays } = await fetchTemplate(pointer, snapshot.relays)
if (!event) {
  console.error(`FAIL the template is not on ${relays.join(', ')}`)
  process.exit(1)
}
const live = parseTemplate(event)
const committed = await readFile(SNAPSHOT, 'utf8')
if (committed !== snapshotYaml(live, snapshot.naddr)) {
  console.error('FAIL the live template differs from the snapshot — run `npm run snapshot:form -- ' + snapshot.naddr + '`')
  failed++
} else console.log('ok   snapshot matches the live template')
for (const m of checkMap(live, map)) {
  console.error('FAIL live: ' + m)
  failed++
}
process.exit(failed ? 1 : 0)
