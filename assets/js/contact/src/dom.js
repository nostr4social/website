// Every node this page creates goes through here. Nothing is ever built by
// assigning a string to innerHTML — text is set with textContent, and the one
// piece of generated markup, the QR code, is built with createElementNS.

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of [].concat(children)) {
    if (child == null) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function replace(node, ...children) {
  clear(node)
  for (const child of children) if (child != null) node.append(child)
}

export function show(node, visible) {
  node.hidden = !visible
}

/** Clone a <template> by id and return its first element. */
export function fromTemplate(id) {
  const tpl = document.getElementById(id)
  if (!tpl) throw new Error(`missing template: ${id}`)
  return tpl.content.firstElementChild.cloneNode(true)
}
