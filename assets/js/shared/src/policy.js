// The reader's side of the page's proof of work. The page makes a one-time
// key mine 20 bits on a form response and 18 on a lead's gift wrap, and a
// signed-in visitor mine none. That costs a flood something only if the
// readers (the results page, `npm run responses`, `npm run check:inboxes`)
// refuse what falls short, so the rules live here, once, pure, for the
// browser and the tools alike.
//
//   screenResponses(rows, opts) → { kept, dropped }
//
// A row is { event, answers } where `answers` is the decrypted response list
// (or null when the reader has no key). The rules, in order: the event must
// carry the form's `a` tag; its signature must check; its author is either
// signed-in (a key the reader knows: one with a published profile, or a
// recipient) or unverified (any other key, which is what a one-time key
// looks like); an unverified response must carry `minPow` bits; and among
// duplicates by content fingerprint, the newest stays. A test marker
// travels as `test`. Everything dropped is returned with its reason, so the
// reader can print what was refused and why.
//
//   screenWraps(events, opts) → { kept, dropped }
//
// Gift wraps (kind 1059) are screened by proof of work alone: the reader
// cannot see inside one, and the page mines the same bits on every wrap
// from a one-time key.

export const KIND_WRAP = 1059

/** Leading zero bits of a hex id: NIP-13's difficulty. */
export function powOf(id) {
  let count = 0
  for (let i = 0; i < id.length; i++) {
    const nibble = parseInt(id[i], 16)
    if (Number.isNaN(nibble)) return count
    if (nibble === 0) {
      count += 4
      continue
    }
    count += Math.clz32(nibble) - 28
    break
  }
  return count
}

/** The content fingerprint: the response tags, as id and value, in id order; the same answers give the same print. */
export function fingerprintOf(answers) {
  if (!Array.isArray(answers)) return null
  const pairs = answers
    .filter((t) => Array.isArray(t) && t[0] === 'response')
    .map((t) => [String(t[1]), String(t[2] ?? '')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return JSON.stringify(pairs)
}

export function screenResponses(rows, { address, minPow = 0, known = new Set(), verify = () => true, testId = null, testOption = null } = {}) {
  const kept = []
  const dropped = []
  const byPrint = new Map()
  for (const row of rows) {
    const e = row.event
    if (!e || !Array.isArray(e.tags) || !e.tags.some((t) => t[0] === 'a' && t[1] === address)) {
      dropped.push({ event: e, reason: 'not addressed to this form' })
      continue
    }
    let valid = false
    try {
      valid = Boolean(verify(e))
    } catch {
      valid = false
    }
    if (!valid) {
      dropped.push({ event: e, reason: 'signature does not check' })
      continue
    }
    const label = known.has(e.pubkey) ? 'signed-in' : 'unverified'
    const pow = powOf(e.id)
    if (label === 'unverified' && pow < minPow) {
      dropped.push({ event: e, reason: `proof of work ${pow} below ${minPow}` })
      continue
    }
    const test = Boolean(testId && Array.isArray(row.answers) && row.answers.some((t) => t[0] === 'response' && t[1] === testId && (testOption ? String(t[2]).split(';').includes(testOption) : Boolean(t[2]))))
    const out = { event: e, answers: row.answers ?? null, label, pow, test, fingerprint: fingerprintOf(row.answers) }
    if (out.fingerprint != null) {
      const seen = byPrint.get(out.fingerprint)
      if (seen) {
        // The newest stays; the older is the duplicate.
        const [older, newer] = seen.event.created_at >= e.created_at ? [out, seen] : [seen, out]
        dropped.push({ event: older.event, reason: `duplicate of ${newer.event.id.slice(0, 12)}` })
        if (newer === out) {
          kept[kept.indexOf(seen)] = out
          byPrint.set(out.fingerprint, out)
        }
        continue
      }
      byPrint.set(out.fingerprint, out)
    }
    kept.push(out)
  }
  kept.sort((a, b) => b.event.created_at - a.event.created_at)
  return { kept, dropped }
}

export function screenWraps(events, { minPow = 0, verify = () => true } = {}) {
  const kept = []
  const dropped = []
  for (const e of events) {
    if (!e || e.kind !== KIND_WRAP) {
      dropped.push({ event: e, reason: 'not a gift wrap' })
      continue
    }
    let valid = false
    try {
      valid = Boolean(verify(e))
    } catch {
      valid = false
    }
    if (!valid) {
      dropped.push({ event: e, reason: 'signature does not check' })
      continue
    }
    const pow = powOf(e.id)
    if (pow < minPow) {
      dropped.push({ event: e, reason: `proof of work ${pow} below ${minPow}` })
      continue
    }
    kept.push({ event: e, pow })
  }
  return { kept, dropped }
}
