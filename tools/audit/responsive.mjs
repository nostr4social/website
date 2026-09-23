// Every page at every breakpoint, checked for horizontal page scroll — the one
// responsive failure that is always a bug rather than a judgment call.
//
//   bundle exec jekyll serve
//   npm run audit:responsive

import { withBrowser } from '../contact-bundle/cdp.mjs'
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000'
const PAGES = ['/', '/nostr/', '/trustr/', '/services/', '/about/', '/contact/', '/404.html']
const WIDTHS = [1440, 1200, 900, 600, 479, 390, 360]
let failures = 0
await withBrowser(async (api) => {
  for (const page of PAGES) {
    for (const width of WIDTHS) {
      await api.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 600 })
      await api.goto(BASE + page)
      await new Promise(r => setTimeout(r, 250))
      const r = await api.eval(`(() => {
        const de = document.documentElement;
        const over = [...document.querySelectorAll('body *')]
          .filter(n => n.getBoundingClientRect().right > de.clientWidth + 1)
          .slice(0, 4)
          .map(n => n.tagName.toLowerCase() + '.' + (n.className && n.className.toString().split(' ')[0] || '') + ' @' + Math.round(n.getBoundingClientRect().right));
        return { scrollW: de.scrollWidth, clientW: de.clientWidth, over };
      })()`)
      const ok = r.scrollW <= r.clientW + 1
      if (!ok) failures++
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${page.padEnd(12)} ${String(width).padStart(5)}  scroll ${r.scrollW}/${r.clientW}${ok ? '' : '  ' + r.over.join(' | ')}`)
    }
  }
})
console.log(failures ? `\n${failures} widths overflow` : '\nno horizontal overflow anywhere')
process.exit(failures ? 1 : 0)
