// A QR code, drawn as one SVG path from the encoder's matrix. The library can
// render SVG itself, but that would mean parsing a markup string into the page;
// this builds the element and sets one `d` attribute instead.

import { qrEncode } from './vendor.js'

const NS = 'http://www.w3.org/2000/svg'

export function qrSvg(text, { label, margin = 2 } = {}) {
  const { data, size } = qrEncode(text, { ecc: 'M', border: margin })
  const side = size

  let d = ''
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (data[y][x]) d += `M${x} ${y}h1v1h-1z`
    }
  }

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${side} ${side}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.classList.add('qr')
  if (label) {
    const title = document.createElementNS(NS, 'title')
    title.textContent = label
    svg.append(title)
  }

  const bg = document.createElementNS(NS, 'rect')
  bg.setAttribute('width', String(side))
  bg.setAttribute('height', String(side))
  bg.setAttribute('fill', '#ffffff')
  svg.append(bg)

  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', d)
  path.setAttribute('fill', '#14111c')
  svg.append(path)

  return svg
}
