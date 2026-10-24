// Writes the public explainer for the calculator's assumptions from the one
// source, _data/assumptions/v<N>.json, so the two can never disagree.
//
//   npm run build:assumptions          # writes calculator/assumptions.v<N>.md
//   npm run check:assumptions          # fails if the committed explainer is stale
//
// The JSON itself is served unchanged at /calculator/assumptions.v<N>.json by
// a one-line Jekyll file in calculator/. Every number the model uses is in the
// JSON with its source; this document is the same table in prose order.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const check = process.argv.includes('--check')

const data = JSON.parse(await readFile(resolve(root, '_data/assumptions/v1.json'), 'utf8'))
const out = resolve(root, `calculator/assumptions.v${data.version}.md`)

const LINES = {
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

const lines = []
lines.push(`# Cost of Custody Calculator: assumptions, version ${data.version}`)
lines.push('')
lines.push(`Dated ${data.date}. Currency ${data.currency}; sterling converted at ${data.gbp_usd} USD per GBP where a source is in pounds.`)
lines.push('')
lines.push('Every number the calculator uses is listed here with its source. Each has a **typical** value, which the')
lines.push('page shows as the headline, and a **low** and **high** value, which bound the range shown beside every')
lines.push('line. Low always means the smaller cost. Any value can be overridden on the page or in a results link')
lines.push('with `a.<key>=<value>`; the machine-readable form of this document is `assumptions.v' + data.version + '.json` beside it.')
lines.push('')
lines.push('A few of the unsourced values are not estimates of the world as it is but of the world Nostr4 is building: the')
lines.push('shares of age checks, moderation, moderation tooling and content-law programs that remain once an app hosts')
lines.push('nothing of its own. Their notes say so. Treat their ranges, not their typical values, as the claim.')
lines.push('')
lines.push('Confidence means:')
lines.push('')
for (const [k, v] of Object.entries(CONF)) lines.push(`- **${k}**: ${v}`)
lines.push('')
const counts = {}
for (const a of Object.values(data.assumptions)) counts[a.confidence] = (counts[a.confidence] || 0) + 1
lines.push(
  Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ') + ` of ${Object.keys(data.assumptions).length} in all. The unsourced ones are the model's weakest points; treat the range, not the typical value, as the claim.`,
)
lines.push('')

for (const [line, title] of Object.entries(LINES)) {
  const rows = Object.entries(data.assumptions).filter(([, a]) => a.line === line)
  if (!rows.length) continue
  lines.push(`## ${title}`)
  lines.push('')
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
