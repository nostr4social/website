# nostr4.social — maintainer's guide

This is the source for nostr4.social. It is a Jekyll 4 site with a custom theme.
This guide is for the people who keep it current: how to change the words, add
a page, or add a new kind of section. You do not need to know Jekyll to change
copy. You need to know a little to add a page, and some HTML and CSS to add a
component.

- [The one rule](#the-one-rule)
- [Changing copy](#changing-copy)
- [How copy is marked up](#how-copy-is-marked-up)
- [Anatomy of a page](#anatomy-of-a-page)
- [Section catalogue](#section-catalogue)
- [Adding a section to a page](#adding-a-section-to-a-page)
- [Adding a page](#adding-a-page)
- [Adding a component](#adding-a-component)
- [Icons](#icons)
- [The contact form](#the-contact-form)
- [Building and checking](#building-and-checking)
- [Where things are](#where-things-are)

## The one rule

**Every word a visitor reads lives in `_data/`.** Not in templates, not in
stylesheets, not in JavaScript. A page is a list of sections in a YAML file;
each section names a component and gives it its copy.

This means changing the site's words never means touching HTML. It also means
the build will refuse anything that looks like markup in the copy: a `<`
anywhere under `_data/` fails `scripts/check.sh`. If you want emphasis, use the
conventions in [How copy is marked up](#how-copy-is-marked-up).

Two smaller rules follow from the same idea, and the same script enforces them:
no inline `style=` attributes in the output, and no requests to third-party
hosts. Fonts, icons, images and scripts are all served from this domain.

## Changing copy

Find the page under `_data/pages/`:

| Page | File |
| --- | --- |
| `/` | `_data/pages/home.yml` |
| `/nostr/` | `_data/pages/nostr.yml` |
| `/trustr/` | `_data/pages/trustr.yml` |
| `/services/` | `_data/pages/services.yml` |
| `/about/` | `_data/pages/about.yml` |
| `/contact/` | `_data/pages/contact.yml` |
| the 404 page | `_data/pages/404.yml` |

Edit the text, save, and the site rebuilds. Copy that appears on more than one
page is in `_data/blocks/` and referenced by name (see `use:` below), so it is
changed once:

| Block | Used on | What |
| --- | --- | --- |
| `thesis.yml` | `/`, `/nostr/` | the "any app that allows users to interact" paragraph |
| `protocol_cards.yml` | `/`, `/nostr/` | the four protocol tiles |
| `services_band.yml` | `/`, `/nostr/`, `/trustr/` | Consultation · Research · Development |
| `cast.yml` | `/` | the hero diagram: the user and four kinds of app |
| `trustr_cast.yml` | `/trustr/` | the hero diagram: TrustR.ing and three customers |

Site-wide words — the tagline, the copyright line, the nav labels, the footer
columns, the accessibility strings — are in `_data/site.yml`, `_data/nav.yml`
and `_data/footer.yml`.

A few YAML habits that save trouble:

- Long text: use `>-` and indent the lines under it. Line breaks inside are
  joined into one paragraph. A blank line inside makes a new paragraph.
- Quote anything that starts with a symbol, or that YAML might read as
  something else: `"#charter"`, `"404"`, `"[nostr4.social] Contact"`,
  `"TSM · trust services"`.
- Straight quotes `"..."` in copy are turned into curly ones at build time.

## How copy is marked up

Copy is Markdown, with three conventions from the style guide. Nothing else
is needed, and nothing else is styled.

| You write | What it means | How it renders |
| --- | --- | --- |
| `**words**` | ordinary emphasis inside a sentence | brighter, bold |
| `**—**` | the turn in a sentence — the punch | the dash in rust |
| `*Name*` | a named component: a product, a standard, a role | gold, upright, never italic |

So on the request-flow section of `/trustr/`:

```yaml
text: >-
  **The reader configures** **—** in the *TrustR Dashboard*. Which
  service, whose point of view, and which interactions to interpret.
```

**Headings are plain text.** Do not put `*` or `**` in a `title`. The one
piece of markup a heading gets is added for you: the rust **4** in `Nostr4`
and in a heading like `Freedom 4 Social Apps` (a standalone 4 between spaces).
Body copy never gets this treatment, so `Nostr4` in a paragraph stays plain.

**Links in copy** are plain URLs in `href:` fields. Fragments (`"#charter"`),
query strings and absolute URLs are left alone; anything else is treated as a
path on this site.

## Anatomy of a page

A page is two files.

`_pages/about.md` — front matter only, no body:

```yaml
---
permalink: /about/
data: about
---
```

`_data/pages/about.yml` — everything the visitor sees:

```yaml
meta:
  title: About                 # becomes "About · Nostr4" in the tab
  description: >-              # the search-result and share text
    Nostr4 is a Delaware Public Benefit Corporation ...

sections:
  - type: hero
    glow: left
    head:
      eyebrow: The company
      title: About Nostr4
      lede: Most companies write a mission statement as an afterthought ...
    actions:
      - label: Read the charter
        href: "#charter"
        style: primary

  - type: notice
    head: { ... }

  - type: callout
    id: charter
    band: raised
    head: { ... }
    quote: strengthen open public discourse ...
    actions: [ ... ]
```

Every entry under `sections:` is one full-width band. The `type` picks which
component draws it; everything else is that component's copy. Sections share an
envelope of optional keys:

| Key | Values | What it does |
| --- | --- | --- |
| `id` | any slug | an anchor, so `href: "#id"` can reach it |
| `band` | `ground` (default) · `sunk` · `raised` | the background shade |
| `glow` | `left` · `right` | the purple wash, on the side away from the copy |
| `tight` | `true` | the 56px vertical rhythm instead of 72px |
| `flush` | `true` | no vertical padding; the content sets its own |
| `ruled` | `true` | hairlines above and below |
| `use` | a block name | take the body from `_data/blocks/<name>.yml` |
| `head` | see below | the heading group above the body |
| `actions` | see below | the buttons under the body |
| `actions_align` | `center` | centre the buttons |

**`head`** can carry any of:

| Key | What |
| --- | --- |
| `eyebrow` | small uppercase label; `eyebrow_tone: gold` colours it |
| `watermark` | the oversized faint word behind a band's heading (`Infrastructure`, `Growth`) |
| `title` | the heading, bold |
| `light` | a heading at body weight — a sentence, not a label |
| `level` | `h1` when this head is the page's main heading (only `/nostr/` does this) |
| `sub` | a quiet line under the title |
| `lede` | a paragraph or two under the title; `lede_size: xl` for the large setting; `lede_bright: true` makes the first paragraph brighter |

**`actions`** is a list of buttons:

```yaml
actions:
  - label: Launch the Demo
    href: https://trustr.ing
    style: primary          # primary · secondary (default) · disabled
    size: lg                # optional
    external: true          # opens in a new tab
    note: trustr.ing        # quiet text beside the button
    icon: caret             # optional, from _includes/icons/
```

A button with `style: disabled` (or no `href`) renders as a real disabled
control — used for "White Paper Coming Soon".

## Section catalogue

Twenty section types exist. The first group is layout-level; the rest each
make one argument on one page. All of them take the envelope above; the fields
listed are their own.

### Page framing

**`hero`** — opens the page; its `title` is the page's only `h1`.

```yaml
- type: hero
  glow: right
  cast: cast              # optional: a block with the diagram
  cast_type: cast         # cast (centre + 4 corners) · hub (top + 3 below)
  cast_layout: side       # side · below
  head: { eyebrow, title, lede }
  actions: [ ... ]
```

**`notice`** — the gold-rail "this page is still being written" panel. Takes
`head` and optional `actions`; nothing else.

**`callout`** — the closing band: one idea left, one button right. Takes `head`,
`actions`, and optionally `quote` (chartered language on a purple rail).

**`proof-bar`** — three claims with their evidence. Use with
`band: sunk, ruled: true, flush: true`.

```yaml
items:
  - claim: We Build Infrastructure
    note: TrustR has been live since April 2026.
```

The Public Benefit claim belongs in a `callout`, never here.

### Cards and lists

**`tiles`** — four icon cards with an optional paragraph above them.

```yaml
- type: tiles
  intro: thesis            # block with `text:` — the paragraph above
  use: protocol_cards      # block with `items:` — or inline `items:`
  item_level: h3           # h2 only when the head is the page's h1
items:
  - { icon: lock, title: Non-Custodial, body: ... }
```

**`cards`** — three cards with a rust icon and a chip link.

```yaml
items:
  - icon: verified
    title: TSM
    body: Trust Service Machines ...
    link: { label: Read the TSM base spec, href: https://... }
```

**`list`** — ruled items, no boxes. `columns: 2` or `3` (default). An `href`
on an item makes its title a link.

```yaml
items:
  - { title: Curators, body: Publish a ranking as a service., href: /trustr/ }
```

**`services-band`** — the same as `list` with three columns; named so the
recurring "how to hire us" stop reads as itself in the data. Always
`use: services_band`.

**`products`** — the two big product panels.

```yaml
items:
  - badge: { label: Live, tone: live }        # live · soon
    name: TrustR
    body: On Nostr, the feed belongs to the reader ...
    standards:
      label: Standards we designed along the way
      chips:
        - { label: "TSM · trust services", href: https://... }
    actions: [ ... ]
```

**`pairs`** — six cards, each a cost then its relief on a purple rail.

```yaml
items:
  - icon: lock
    title: Release Custody
    cost: Apps that hold accounts and personal data are ...
    relief: Apps integrating with Nostr can release custody ...
```

### Arguments

**`split`** — the case on the left, outcome cards on the right. The two titles
are halves of one sentence.

```yaml
- type: split
  title: Nostr has a problem ...
  body: How does one discover trustworthy content ...
  bright: true             # first paragraph of `body` in the brighter ink
  punch: Any social app that holds custody ...   # the larger closing line
  wide: true               # wider gutter between halves
  aside:
    title: ... without a standard for trust.
    tone: recessed         # recessed (the world without) · lifted (the world with)
    items:
      - { eyebrow: Users get, title: Vendor Lock In, body: ... }
```

**`ledger`** — two columns of the same line items, a purple seam between.

```yaml
columns:
  - label: Custodial Tech Company
    tone: cost             # the muted treatment
    inside: true           # draw the items inside the company's box
    app: { icon: phone, name: Custodial App }
    group: In House Full Stack
    items:
      - { icon: lock-closed, label: Accounts & personal data }
  - label: Nostr Tech Company
    app: { icon: phone, name: Nostr App }
    group: User Controlled
    items: [ ... ]
```

The asymmetry — `inside` on one side only — is the argument. Keep it.

**`chain`** — three boxes joined by purple links, rust along the top.

```yaml
items:
  - { title: Web of trust, body: A baseline graph built from ... }
note: Each link in that chain is a TSM service ...
```

**`zones`** — the architecture: columns of nodes with seams between, and one
box outside.

```yaml
zones:
  - label: Public interface
    wide: true
    nodes:
      - icon: phone
        title: TrustR Dashboard
        note: Configure a request. Watch it resolve.
        steps: [1, 10]        # which steps of the flow touch this node
outside:
  label: Outside TrustR
  nodes:
    - { icon: broadcast, tone: gold, title: Public relays, scanned continuously }
```

**`flow`** — numbered steps.

```yaml
items:
  - step: "6"
    text: "**Interpretation** **—** turns every interaction into a rating ..."
    rules: [a follow counts 1.0, a mute counts 0.0]         # optional chips
  - step: "7"
    text: ...
    params:                                                 # optional grid
      - { name: attenuation, note: how fast influence decays with distance }
close: That signed output is now an addressable event ...
```

### Diagrams (used by `hero`)

**`cast`** — a figure at the centre and four parts around it, clockwise from
top-left. `tone: rust` marks the parts Nostr4 builds; the rest are gold.

```yaml
centre: face
items:
  - { icon: phone, title: Social Client Apps, note: ... }
  - { icon: key, tone: rust, title: Key Management Apps, note: ... }
```

**`hub`** — one provider above three kinds of customer.

```yaml
hub: { icon: cloud, tone: rust, title: TrustR.ing, note: ... }
items:
  - { icon: phone, title: Onboarding Client Apps, note: ... }
```

### `contact-form`

The encrypted form. Its copy is large and its own; see
[The contact form](#the-contact-form).

## Adding a section to a page

1. Open `_data/pages/<page>.yml`.
2. Add an entry under `sections:` at the position you want it, starting with
   `type:` and any envelope keys, then the component's own fields from the
   catalogue.
3. If the copy will appear on another page too, put the body in
   `_data/blocks/<name>.yml` and reference it with `use: <name>`.
4. Build and run `scripts/check.sh` (see [Building and checking](#building-and-checking)).

Nothing in `_includes/` or `_sass/` changes.

A worked example — a ruled list of three partners under the products on the
home page:

```yaml
  - type: list
    id: partners
    band: sunk
    head:
      title: Who runs it with us
      lede: Three relays carry TrustR's outputs today.
    items:
      - { title: relay.example, body: Since launch. }
      - { title: nos.example, body: Since June. }
      - { title: purple.example, body: Read-only mirror. }
```

## Adding a page

1. **Copy.** Create `_data/pages/<key>.yml` with `meta:` and `sections:`. Quote
   the key if it is a number.
2. **Address.** Create `_pages/<key>.md` containing only front matter:

   ```yaml
   ---
   permalink: /<slug>/
   data: <key>
   ---
   ```

   The layout is applied automatically. Add `csp: contact` only if the page
   needs JavaScript (see the contact form); otherwise it gets the strict
   default policy that forbids scripts.
3. **Reach it.** Add it to `_data/nav.yml` (masthead) and/or `_data/footer.yml`
   (footer columns), and to the list of doors in `_data/pages/404.yml`.
4. Build and check.

The page's `<title>` is `meta.title · Nostr4`; the home page uses the site title
from `_data/site.yml` because its `meta:` is empty.

## Adding a component

Add one only when no existing type can carry the argument. The catalogue is the
theme; each new type is a permanent addition to it.

1. **Include.** Create `_includes/components/<type>.html`. It receives
   `include.section` (the whole section entry) and `include.block` (the body —
   either the section itself or the block named by `use:`). Start it with a
   `{% comment %}` listing its fields; that comment is the catalogue entry.

   ```liquid
   {%- comment -%}
     items   [{title, body}]
   {%- endcomment -%}
   {%- assign b = include.block -%}
   <div class="grid grid--3">
     {%- for item in b.items -%}
     <div class="thing">
       <h3 class="thing__title">{{ item.title }}</h3>
       {% include lib/text.html text=item.body class="thing__body" %}
     </div>
     {%- endfor -%}
   </div>
   ```

   The envelope renders the `head` above and the `actions` below for you. If
   your component needs the head *inside* its own layout (as `hero`, `notice`
   and `callout` do), add its name to `owns_layout` in
   `_includes/components/section.html` and call `lib/section-head.html` and
   `lib/actions.html` yourself.

2. **Use the primitives** in `_includes/lib/` rather than writing markup for
   things that already exist:

   | Include | For |
   | --- | --- |
   | `lib/heading.html` | any heading from copy — adds the rust 4, escapes the rest |
   | `lib/text.html` | any body copy — Markdown plus the three conventions |
   | `lib/actions.html` | a row of buttons |
   | `lib/icon.html` | an inline SVG icon by name |
   | `lib/href.html` | resolve a link without breaking fragments |
   | `lib/node.html` | an architecture box (icon, title, note, steps) |
   | `lib/section-head.html` | the heading group, if you own your layout |

   Never put copy in the include, and never write `style="..."`.

3. **Styles.** Create `_sass/components/_<type>.scss` and add
   `@use "components/<type>";` to `assets/css/site.scss`. Use the custom
   properties from `_sass/_tokens.scss` for every colour, size, weight and
   space — there should be no literal values in a component. Breakpoints:

   ```scss
   @use "../breakpoints" as *;
   @include below($bp-mid) { ... }    // 1200 · 900 · 600 are $bp-wide, $bp-mid, $bp-narrow
   ```

   The shared grids (`.grid--2`, `.grid--3`, `.grid--4`) already collapse at
   the right widths; prefer them to a grid of your own.

4. **Use it** from a page's `sections:` and build. Run the responsive and
   accessibility audits (below) — they catch a new component that overflows on
   a phone or skips a heading level.

5. **Document it** here, in the catalogue.

## Icons

Icons are inline SVG so they take their colour from the text around them. Each
is a file in `_includes/icons/` holding only the shapes (no `<svg>` wrapper),
drawn on a 24×24 grid. Currently:

`broadcast card caret cloud doc face gavel hub insights key lock lock-closed
network people phone scatter storage verified`

To add one, save the `<path>`/`<circle>` elements from a Material Icons Round
glyph as `_includes/icons/<name>.svg`, with any `fill`/`stroke` set to
`currentColor` or omitted. Then use `icon: <name>` in copy. Components colour
icons by role — gold for the ecosystem, rust for what Nostr4 builds — via
`icon--gold` / `icon--rust`.

## The contact form

`/contact/` is the one page that runs JavaScript. Its copy is in
`_data/pages/contact.yml` like any other page, in the `contact-form` section,
but that section has three parts:

- **Rendered markup** — `methods`, `nip46`, `compose`, `sending`, `result`,
  `unavailable`, `email`, `how_it_works`. Edit these like any copy.
- **`strings`** — what the script says at runtime: status lines, result
  verdicts, every error message. Edit these like any copy; the keys are what
  the script looks up, so do not rename them.
- **`config`** — relay lists, timeouts, message limits, the curated list of
  remote signers. Machine configuration; change with care.

Who the form sends to is not in this file at all: it is every name in
`.well-known/nostr.json`. Add or remove a person there.

The script itself is in `assets/js/contact/src/` and is built into
`assets/js/contact/contact.js` plus two vendored libraries. Change a source
file or a dependency pin, then:

```sh
npm ci
npm run build:contact      # rebuilds all three and writes their hashes to _data/assets.yml
npm run check:contact      # proves the committed files match the sources
```

The built files are committed, so the site deploys without Node. Their
hashes are in the page as subresource integrity, which is why a rebuild is
required after any change — an unbuilt edit simply fails to load.

## Building and checking

Ruby 3.2 and the bundler in `/home/manime/gems/bin`:

```sh
export PATH="/home/manime/gems/bin:$PATH"
bundle install                              # first time
bundle exec jekyll serve --livereload       # http://localhost:4000, rebuilds on save
```

Before committing:

```sh
JEKYLL_ENV=production bundle exec jekyll build
scripts/check.sh
```

`check.sh` confirms the required files exist, `.well-known/nostr.json` survived
the build unchanged, there is no `<` in `_data/`, no inline styles and no
third-party assets in the output, and every internal link resolves.

With the site served on port 4000, the browser audits (they drive headless
Chrome and need no extra dependencies):

```sh
npm run audit:responsive    # every page × 1440/1200/900/600/390: no horizontal scroll
npm run audit:a11y          # alt text, one h1, no skipped levels, labelled fields, named controls
npm run e2e:ui              # the contact form end to end, against an unreachable relay
npm run e2e:contact         # the NIP-17 pipeline offline; add a wss:// URL to publish for real
```

Deployment is by `.github/workflows/pages.yml`. It is currently reachable only
by manual dispatch; the `push` trigger is commented out until cutover.

## Where things are

```
_data/
  site.yml            tagline, copyright, meta defaults, a11y strings, CSP policies
  nav.yml  footer.yml masthead links, footer columns
  pages/*.yml         one file per page: meta + sections
  blocks/*.yml        copy shared by more than one page
  assets.yml          generated — contact bundle paths and hashes; never edit
_pages/*.md           one per page: permalink + data key, nothing else
_includes/
  components/         one include per section type; section.html is the dispatcher
  lib/                heading, text, actions, icon, href, node, section-head, lockup
  icons/*.svg         icon shapes
  head/               csp, seo, icons, fonts
  masthead.html footer.html skip-link.html scripts.html
_layouts/             default.html (the shell), page.html (renders sections)
_sass/
  _tokens.scss        every colour, size, weight, space and radius
  _breakpoints.scss   1200 · 900 · 600
  base/               reset, fonts, typography, layout, a11y
  components/         one partial per component
  pages/_contact.scss
assets/
  css/site.scss       the one stylesheet; @use each partial
  fonts/              Archivo (variable) and IBM Plex Mono, self-hosted, OFL
  images/             the mark; og/default.png
  js/contact/         src/ is the code; contact.js is the build
  js/vendor/          nostr-tools and uqr, pinned and hashed
tools/
  contact-bundle/     build, check, e2e, and the CDP browser driver
  audit/              responsive and a11y audits
scripts/check.sh      the build gate
.well-known/nostr.json  NIP-05 — also who the contact form sends to
_reference/           source material, never published
```
