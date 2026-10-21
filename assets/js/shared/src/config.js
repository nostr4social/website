// Copy and configuration arrive as two inert JSON blocks that Jekyll renders
// from the page's file under _data/pages/. Nothing here is a literal in the
// code, for the same reason nothing in the templates is: the words are the
// site's, not the script's. Every page that runs a script carries the same two
// blocks, `page-strings` and `page-config`, so this module serves all of them.

export function readJson(id) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing config block: ${id}`)
  return JSON.parse(node.textContent)
}

function readOptional(id) {
  return document.getElementById(id) ? readJson(id) : {}
}

function merge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' ? merge(base[k], v) : v
  }
  return out
}

// Two more blocks carry what every scripted page shares (`page-shared-strings`,
// `page-shared-config`); the page's own blocks win where both have a key.
export const strings = merge(readOptional('page-shared-strings'), readJson('page-strings'))
export const config = merge(readOptional('page-shared-config'), readJson('page-config'))

/** The page's query string. `?to=<name>` and `?subject=` work everywhere. */
export const query = new URLSearchParams(location.search)

/** `{name}` placeholders in a string, filled from an object. */
export function fmt(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, key) => (vars[key] == null ? m : String(vars[key])))
}

/** `strings` lookup by dotted path, so the UI can name copy without destructuring. */
export function t(path, fallback = '') {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), strings) ?? fallback
}

/** Localhost-only overrides, for testing against a throwaway key. */
export const dev = (() => {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  if (!local) return { local: false }
  const params = new URLSearchParams(location.search)
  return {
    local: true,
    to: params.get('to'),
    // Repeatable: ?relay=wss://localhost:7000&relay=wss://dead.invalid
    relays: params.getAll('relay'),
    noNip07: params.has('nonip07'),
    noNip44: params.has('nonip44'),
    no10050: params.has('no10050'),
    noPow: params.has('nopow'),
  }
})()
