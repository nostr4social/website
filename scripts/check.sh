#!/usr/bin/env bash
# Build checks for nostr4.social. Run after `bundle exec jekyll build`.
#
#   JEKYLL_ENV=production bundle exec jekyll build && scripts/check.sh
#
# Every check here enforces a rule from the README: no copy in templates, no
# inline styles, no third-party requests.

set -uo pipefail
cd "$(dirname "$0")/.."

SITE=${SITE:-_site}
fails=0

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails + 1)); }
note() { printf '  --   %s\n' "$1"; }

if [ ! -d "$SITE" ]; then
  echo "No $SITE/ — run 'bundle exec jekyll build' first." >&2
  exit 2
fi

echo "Checking $SITE"

# --- files that must exist ----------------------------------------------------
for f in index.html CNAME 404.html sitemap.xml robots.txt site.webmanifest \
         favicon.ico .well-known/nostr.json; do
  if [ -f "$SITE/$f" ]; then pass "$f present"; else fail "$f missing"; fi
done

# --- NIP-05 must survive the build byte for byte ------------------------------
if [ -f "$SITE/.well-known/nostr.json" ]; then
  if cmp -s .well-known/nostr.json "$SITE/.well-known/nostr.json"; then
    pass ".well-known/nostr.json matches source"
  else
    fail ".well-known/nostr.json differs from source"
  fi
  if command -v python3 >/dev/null 2>&1; then
    if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' \
         "$SITE/.well-known/nostr.json" 2>/dev/null; then
      pass ".well-known/nostr.json is valid JSON"
    else
      fail ".well-known/nostr.json is not valid JSON"
    fi
  fi
fi

# --- no copy in templates -----------------------------------------------------
# A '<' anywhere under _data/ means markup crept into the copy. Full-line
# comments are notes to the next editor, not copy, so they are exempt.
if hits=$(grep -rn '<' _data/ 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'); then
  fail "'<' found in _data/ — copy must be plain text"
  printf '%s\n' "$hits" | head -20 | sed 's/^/       /'
else
  pass "no markup in _data/"
fi

# --- no inline styles ---------------------------------------------------------
if hits=$(grep -rn 'style="' "$SITE" --include='*.html' 2>/dev/null); then
  fail "inline style= in generated HTML"
  printf '%s\n' "$hits" | head -20 | sed 's/^/       /'
else
  pass "no inline styles"
fi

# --- no third-party requests --------------------------------------------------
if hits=$(grep -rnE '<(script|link|img|iframe)[^>]+(src|href)="(https?:)?//' \
            "$SITE" --include='*.html' 2>/dev/null | grep -v 'rel="canonical"' \
            | grep -vE 'property="og:|name="twitter:'); then
  fail "third-party asset reference in generated HTML"
  printf '%s\n' "$hits" | head -20 | sed 's/^/       /'
else
  pass "no third-party assets"
fi

# --- link and markup validation ----------------------------------------------
# A build made with --baseurl (the staging deploy under /website/) prefixes
# every internal link; BASE_PATH tells htmlproofer to strip it before looking.
proofer_args=(--disable-external --allow-hash-href --ignore-files '/vendor/' --no-enforce-https)
if [ -n "${BASE_PATH:-}" ]; then
  proofer_args+=(--swap-urls "^${BASE_PATH%/}/:/")
fi
if bundle exec htmlproofer --version >/dev/null 2>&1; then
  if bundle exec htmlproofer "$SITE" "${proofer_args[@]}" >/dev/null 2>&1; then
    pass "htmlproofer"
  else
    fail "htmlproofer — rerun without the output filter to see why"
    bundle exec htmlproofer "$SITE" "${proofer_args[@]}" 2>&1 | tail -30 | sed 's/^/       /'
  fi
else
  note "htmlproofer not installed — skipped"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$fails check(s) failed."
fi
exit $((fails > 0))
