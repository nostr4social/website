// The smallest YAML reader this repo needs: plain scalars, quoted strings,
// nested maps, block lists of scalars or of maps, and one-line flow maps and
// lists. No dependency, because the site has none. Comments and blank lines
// are skipped. It is enough for _data/forms/*.yml, which the tools here write.
export default {
  parse(text) {
    const lines = text.split('\n').map((l) => l.replace(/\t/g, '  '))
    let i = 0
    const peek = () => {
      while (i < lines.length && (/^\s*$/.test(lines[i]) || /^\s*#/.test(lines[i]))) i++
      return i < lines.length ? lines[i] : null
    }
    const indentOf = (l) => l.match(/^ */)[0].length
    function block(indent) {
      const first = peek()
      if (first == null) return null
      if (/^\s*-\s/.test(first) || /^\s*-$/.test(first)) return list(indentOf(first))
      return map(indentOf(first))
    }
    function map(indent) {
      const out = {}
      for (;;) {
        const l = peek()
        if (l == null || indentOf(l) < indent) return out
        if (indentOf(l) > indent) throw new Error('bad indent: ' + l)
        const m = l.match(/^\s*("(?:[^"\\]|\\.)*"|[^:#]+?)\s*:(?:\s+(.*))?$/)
        if (!m) throw new Error('bad line: ' + l)
        const key = scalar(m[1])
        i++
        const rest = m[2] == null ? '' : m[2].replace(/\s+#.*$/, '').trim()
        if (rest === '') {
          const next = peek()
          out[key] = next != null && indentOf(next) > indent ? block(indentOf(next)) : next != null && /^\s*-/.test(next) && indentOf(next) === indent ? list(indent) : null
        } else {
          out[key] = value(rest)
        }
      }
    }
    function list(indent) {
      const out = []
      for (;;) {
        const l = peek()
        if (l == null || indentOf(l) !== indent || !/^\s*-/.test(l)) return out
        const rest = l.replace(/^\s*-\s?/, '').trim()
        i++
        if (rest === '') {
          out.push(block(indentOf(peek())))
        } else if (/^[^"'{[][^:]*:\s/.test(rest) || /^[^"'{[][^:]*:$/.test(rest)) {
          // a map that starts on the dash line
          lines[i - 1] = ' '.repeat(indent + 2) + rest
          i--
          out.push(map(indent + 2))
        } else {
          out.push(value(rest))
        }
      }
    }
    function value(s) {
      if (s.startsWith('{')) return flowMap(s)
      if (s.startsWith('[')) return flowList(s)
      return scalar(s)
    }
    function flowMap(s) {
      const inner = s.slice(1, s.lastIndexOf('}')).trim()
      const out = {}
      for (const part of splitFlow(inner)) {
        if (!part) continue
        const at = part.indexOf(':')
        out[scalar(part.slice(0, at).trim())] = value(part.slice(at + 1).trim())
      }
      return out
    }
    function flowList(s) {
      const inner = s.slice(1, s.lastIndexOf(']')).trim()
      return splitFlow(inner).filter((p) => p !== '').map((p) => value(p.trim()))
    }
    function splitFlow(s) {
      const parts = []
      let depth = 0
      let quote = null
      let cur = ''
      for (const ch of s) {
        if (quote) {
          cur += ch
          if (ch === quote) quote = null
        } else if (ch === '"' || ch === "'") {
          quote = ch
          cur += ch
        } else if (ch === '{' || ch === '[') {
          depth++
          cur += ch
        } else if (ch === '}' || ch === ']') {
          depth--
          cur += ch
        } else if (ch === ',' && depth === 0) {
          parts.push(cur.trim())
          cur = ''
        } else cur += ch
      }
      parts.push(cur.trim())
      return parts
    }
    function scalar(s) {
      s = s.trim()
      if (s.startsWith('"')) return JSON.parse(s)
      if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
      if (s === 'true') return true
      if (s === 'false') return false
      if (s === 'null' || s === '~') return null
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
      return s
    }
    return block(0)
  },
}
