// A test form for the local relay: the published form's own questions, ids
// and all, re-signed under a key that exists for one test run. The tests
// then exercise exactly the ids the map names, without touching the real
// form.
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { KIND_FORM } from './lib.mjs'

export function fixtureTemplate(snapshot, relay) {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const tags = [
    ['d', snapshot.d],
    ['name', `<p>${snapshot.name}</p>`],
    ['settings', JSON.stringify({
      description: snapshot.description || '',
      sections: (snapshot.sections || []).map((sec, i) => ({ id: sec.id, title: sec.title, description: sec.description || '', questionIds: sec.questions, order: i })),
    })],
    ['relay', relay],
    ['t', 'public'],
  ]
  for (const f of snapshot.fields) {
    // A parsed template keeps a grid under `grid`; the snapshot file writes
    // `rows` and `columns` beside `options`. Accept either.
    const grid = f.grid || (f.rows ? { rows: f.rows, columns: f.columns } : null)
    const options = grid
      ? JSON.stringify({ columns: grid.columns.map((c) => [c.id, c.label, '{}']), rows: grid.rows.map((r) => [r.id, r.label, '{}']) })
      : JSON.stringify((f.options || []).map((o) => [o.id, `<p>${o.label}</p>`]))
    tags.push(['field', f.id, f.type, `<p>${f.label}</p>`, options, JSON.stringify({ renderElement: f.render, required: f.required })])
  }
  const event = finalizeEvent({ kind: KIND_FORM, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, secret)
  return { event, secret, pubkey }
}

/** Start `nak serve` on a port; resolves to a function that stops it. */
export async function localRelay(port, { spawn }) {
  const relay = spawn('nak', ['serve', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
  await new Promise((resolveStart, reject) => {
    const t = setTimeout(() => reject(new Error('nak serve did not start')), 8000)
    relay.stderr.on('data', (d) => {
      if (String(d).includes(String(port))) {
        clearTimeout(t)
        resolveStart()
      }
    })
    relay.on('exit', () => reject(new Error('nak serve exited')))
  })
  await new Promise((r) => setTimeout(r, 300))
  return () => relay.kill()
}
