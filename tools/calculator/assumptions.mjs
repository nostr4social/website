// Writes the public explainer for the calculator's assumptions from the one
// source, _data/assumptions/v<N>.json, so the two can never disagree.
//
//   npm run build:assumptions                # writes calculator/assumptions.v<N>.md for the latest version
//   npm run build:assumptions -- --version 2 # for one version
//   npm run check:assumptions                # fails if the latest committed explainer is stale
//
// The JSON itself is served unchanged at /calculator/assumptions.v<N>.json by
// a one-line Jekyll file in calculator/. Every number the model uses is in the
// JSON with its source; this document is the same table in prose order. Old
// versions stay published so that old results links still name what they
// were made with; version 1's explainer was written by the first form of this
// script and is kept as it was.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const check = process.argv.includes('--check')
const at = process.argv.indexOf('--version')
const versions = (await readdir(resolve(root, '_data/assumptions')))
  .map((f) => f.match(/^v(\d+)\.json$/)?.[1])
  .filter(Boolean)
  .map(Number)
  .sort((a, b) => a - b)
const wanted = at >= 0 ? Number(process.argv[at + 1]) : versions.at(-1)

const data = JSON.parse(await readFile(resolve(root, `_data/assumptions/v${wanted}.json`), 'utf8'))
const out = resolve(root, `calculator/assumptions.v${data.version}.md`)

const LINES = {
  thesis: "At scale: Nostr4's thesis",
  shared: 'Used by more than one line',
  accounts: '1. Accounts and personal data',
  graph: '2. Social graph and feeds',
  storage: '3. Compute and storage',
  compliance: '4. Compliance and liability',
  moderation: '5. Moderation',
  payments: '6. Payments',
}
const CONF = {
  high: 'read on the cited page or price list',
  medium: 'derived from a primary source, or a primary figure converted or amortised',
  low: 'a vendor page, a self-reported salary site, or a primary figure relayed second-hand',
  unsourced: 'no public figure exists; a stated default, deliberately conservative',
}

const fmt = (v, unit) => {
  if (typeof v !== 'number') return String(v)
  if (unit === 'multiplier') return `${v}×`
  if (/^ratio/.test(unit)) return `${Math.round(v * 1000) / 10}%`
  return v >= 1000 ? v.toLocaleString('en-US') : String(v)
}
const group = (a) => (a.scenario_varies ? 'thesis' : a.line)

const lines = []
lines.push(`# Non-Custodial Savings Calculator: assumptions, version ${data.version}`)
lines.push('')
lines.push(`Dated ${data.date}. Currency ${data.currency}; sterling converted at ${data.gbp_usd} USD per GBP where a source is in pounds.`)
lines.push('')
lines.push('Every number the calculator uses is listed here with its source. Each has a **typical** value, which the')
lines.push('page shows as the headline, and a **low** and **high** value. Any value can be overridden on the page or in a')
lines.push('results link with `a.<key>=<value>`; the machine-readable form of this document is `assumptions.v' + data.version + '.json` beside it.')
lines.push('')
lines.push('The range beside every figure on the page comes from the first section alone, **At scale: Nostr4\'s thesis**:')
lines.push('the time for Nostr to establish the standards and infrastructure that support Nostr at scale, the share of')
lines.push('each cost that remains once an app hosts nothing of its own, and the Nostr-native fees that take its place.')
lines.push('Only those rows take their low or high value in the low and high cases; every assumption on the custodial')
lines.push('side is held at its typical value in all three, because that half of the model is the prospect\'s to override.')
lines.push('The band is therefore a statement about the thesis, not about cloud pricing. **Low means the smaller saving**:')
lines.push('the thesis holding less well. The low and high beside the other rows are reference points, not scenarios.')
lines.push('')
lines.push(`The projection runs on a calendar, not a stopwatch: month 1 is January ${data.start_year} for every app, and`)
lines.push('later versions of this file will shorten the time to scale as the network matures. The ramp starts from what')
lines.push('the network delivers today (`scale_progress_today`). An app\'s own integration, its time and its cost, is not')
lines.push('estimated here: it is settled case by case, in a consult. Results links carry the version they were made with;')
lines.push('earlier versions stay published beside this one.')
lines.push('')
lines.push('Confidence means:')
lines.push('')
for (const [k, v] of Object.entries(CONF)) lines.push(`- **${k}**: ${v}`)
lines.push('')
const counts = {}
for (const a of Object.values(data.assumptions)) counts[a.confidence] = (counts[a.confidence] || 0) + 1
const varying = Object.values(data.assumptions).filter((a) => a.scenario_varies).length
lines.push(
  Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ') + ` of ${Object.keys(data.assumptions).length} in all, of which ${varying} are the thesis and move the band. The unsourced ones are the model's weakest points; an unsourced value says why in its note.`,
)
lines.push('')

for (const [line, title] of Object.entries(LINES)) {
  const rows = Object.entries(data.assumptions).filter(([, a]) => group(a) === line)
  if (!rows.length) continue
  lines.push(`## ${title}`)
  lines.push('')
  if (line === 'payments') {
    lines.push('The input this line reads, `rev`, is **in-app payments, gross monthly volume (USD)**: all payments the app')
    lines.push("facilitates: purchases, subscriptions, tips and sales between users. The app's own take is a share of this, not a")
    lines.push('separate input. The line measures the fee stack custody puts on that volume, not the revenue itself.')
    lines.push('')
  }
  if (line === 'thesis') {
    lines.push('These are not estimates of the world as it is but of the world Nostr4 is building. No public price list')
    lines.push('exists for the Nostr-native services, including ours, and at scale there is no vendor to lock an app in, so')
    lines.push('their prices are what the market will bear. Treat the range, not the typical value, as the claim.')
    lines.push('')
  }
  lines.push('| Key | What | Typical | Low | High | Unit | Confidence | Source |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const [key, a] of rows) {
    const src = a.source ? `[${a.source.title}](${a.source.url}) (${a.source.date})` : 'none'
    lines.push(`| \`${key}\` | ${a.label} | ${fmt(a.typical, a.unit)} | ${fmt(a.low, a.unit)} | ${fmt(a.high, a.unit)} | ${a.unit} | ${a.confidence} | ${src} |`)
  }
  lines.push('')
  for (const [key, a] of rows) if (a.note) lines.push(`- \`${key}\`: ${a.note}`)
  lines.push('')
}
lines.push('## Provenance')
lines.push('')
lines.push('The research these numbers were taken from, including the figures that were looked for and not found, is kept')
lines.push('in the site repository under `tools/calculator/`. Changing a number means a new version of this file and of the')
lines.push('JSON beside it; results links carry the version they were made with.')
lines.push('')

const text = lines.join('\n')
if (check) {
  const committed = await readFile(out, 'utf8').catch(() => '')
  if (committed !== text) {
    console.error(`FAIL ${out} is stale — run 'npm run build:assumptions'`)
    process.exit(1)
  }
  console.log(`ok   ${out}`)
} else {
  await writeFile(out, text)
  console.log(`wrote ${out}`)
}
