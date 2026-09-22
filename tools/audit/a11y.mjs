// Accessibility audit: the structural checks that can be made without a human.
// Contrast and focus order are checked by eye against the style guide.
//
//   bundle exec jekyll serve
//   npm run audit:a11y

import { withBrowser } from '../contact-bundle/cdp.mjs'
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000'
const PAGES = ['/', '/nostr/', '/trustr/', '/services/', '/about/', '/contact/', '/404.html']
let failures = 0
const check = (page, name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${page.padEnd(12)} ${name}${detail ? ' — ' + detail : ''}`)
}
await withBrowser(async (api) => {
  for (const page of PAGES) {
    await api.goto(BASE + page)
    const r = await api.eval(`(() => {
      const imgs = [...document.images].filter(i => i.getAttribute('alt') === null).map(i => i.src);
      const h1 = [...document.querySelectorAll('h1')].map(h => h.textContent.trim());
      const levels = [...document.querySelectorAll('h1,h2,h3,h4')].map(h => +h.tagName[1]);
      let skips = [];
      for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i-1] > 1) skips.push(levels[i-1] + '->' + levels[i]);
      const unlabelled = [...document.querySelectorAll('input:not([type=hidden]), textarea, select')]
        .filter(f => !f.closest('label') && !f.getAttribute('aria-label') && !f.getAttribute('aria-labelledby')
                     && !document.querySelector('label[for="' + f.id + '"]'))
        .map(f => f.id || f.name || f.type);
      const namelessButtons = [...document.querySelectorAll('button, a')]
        .filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.querySelector('[alt]'))
        .map(b => b.tagName + (b.id ? '#' + b.id : '') + (b.className ? '.' + b.className.toString().split(' ')[0] : ''));
      const lang = document.documentElement.lang;
      const title = document.title;
      const desc = document.querySelector('meta[name=description]')?.content || '';
      const main = document.querySelectorAll('main#main').length;
      const skip = document.querySelector('.skip-link')?.getAttribute('href');
      return { imgs, h1, skips, unlabelled, namelessButtons, lang, title, desc, main, skip };
    })()`)
    check(page, 'every image has alt', r.imgs.length === 0, r.imgs.join(' '))
    check(page, 'exactly one h1', r.h1.length === 1, r.h1.join(' | '))
    check(page, 'no skipped heading levels', r.skips.length === 0, r.skips.join(' '))
    check(page, 'every field is labelled', r.unlabelled.length === 0, r.unlabelled.join(' '))
    check(page, 'every control has a name', r.namelessButtons.length === 0, r.namelessButtons.join(' '))
    check(page, 'lang, title, description, main, skip link',
      r.lang === 'en' && r.title.length > 0 && r.desc.length > 0 && r.main === 1 && r.skip === '#main',
      `${r.lang} | ${r.title} | main=${r.main} | skip=${r.skip}`)
  }
})
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
