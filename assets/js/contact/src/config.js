// Copy and configuration arrive as two inert JSON blocks that Jekyll renders
// from _data/pages/contact.yml. Nothing here is a literal in the code, for the
// same reason nothing in the templates is: the words are the site's, not the
// script's.

function readJson(id) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing config block: ${id}`)
  return JSON.parse(node.textContent)
}

export const strings = readJson('contact-strings')
export const config = readJson('contact-config')

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
  }
})()
