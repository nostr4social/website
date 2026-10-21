// A test form for the local relay: the calculator's recipe as formstr.app
// would publish it, under a key that exists for one test run. Used by the
// browser and pipeline tests so they never touch a real form.
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { KIND_FORM } from './lib.mjs'

export function fixtureTemplate(recipe, relay) {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const rid = () => Math.random().toString(36).slice(2, 8)
  const TEXT = ['name', 'company', 'email', 'npub', 'link', 'overrides', 'version', 'test']
  const MULTI = ['stores', 'jur', 'nostr']
  const tags = [
    ['d', 'cost-of-custody-test'],
    ['name', '<p>Cost of Custody <b>test</b></p>'],
    ['settings', JSON.stringify({ description: 'test' })],
    ['relay', relay],
    ['t', 'public'],
  ]
  for (const [key, want] of Object.entries(recipe.fields)) {
    const isOption = Boolean(want.options)
    const primitive = isOption ? 'option' : TEXT.includes(key) ? 'text' : 'number'
    const render = isOption ? (MULTI.includes(key) ? 'checkboxes' : 'radioButton') : primitive === 'number' ? 'number' : key === 'overrides' ? 'paragraph' : 'shortText'
    const options = isOption ? Object.values(want.options).map((label) => [rid(), `<p>${label}</p>`]) : []
    tags.push(['field', rid(), primitive, `<p>${want.label}</p>`, JSON.stringify(options), JSON.stringify({ renderElement: render, required: false })])
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
