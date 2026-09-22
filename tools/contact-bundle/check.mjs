// Rebuilds in memory and compares against what is committed, byte for byte.
// Run in CI, in a job that is not the Pages build, so a reviewer never has to
// trust the committed blobs.
//
//   npm run check:contact

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAll, targets, toYaml } from './build.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
let failed = 0
const fail = (msg) => { console.error('FAIL ' + msg); failed++ }

const fresh = await buildAll({ write: false })

for (const [name, t] of Object.entries(targets)) {
  const committed = await readFile(resolve(root, t.out)).catch(() => null)
  if (!committed) {
    fail(`${t.out} is missing — run 'npm run build:contact'`)
  } else if (!committed.equals(fresh[name].bytes)) {
    fail(`${t.out} differs from a fresh build — run 'npm run build:contact'`)
  } else {
    console.log(`ok   ${t.out} (${committed.length} B)`)
  }
}

const committedYaml = await readFile(resolve(root, '_data/assets.yml'), 'utf8').catch(() => '')
if (committedYaml.trim() !== toYaml(fresh).trim()) {
  fail("_data/assets.yml does not match a fresh build — run 'npm run build:contact'")
} else {
  console.log('ok   _data/assets.yml')
}

process.exit(failed ? 1 : 0)
