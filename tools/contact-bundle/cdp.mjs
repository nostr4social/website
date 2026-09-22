// Drive headless Chrome over the DevTools protocol. Node 22 has a global
// WebSocket, so this needs no dependencies.
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function withBrowser(fn) {
  const profile = await mkdtemp(join(tmpdir(), 'cdp-'))
  const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('chrome did not start')), 20000)
    chrome.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/ws:\/\/[^\s]+/)
      if (m) { clearTimeout(t); resolve(m[0]) }
    })
  })

  const ws = new WebSocket(wsUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  const events = []
  const listeners = new Set()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
      for (const l of listeners) l(msg)
    }
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params, sessionId }))
    })

  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const api = {
      send: (m, p) => send(m, p, sessionId),
      events,
      onEvent: (fn) => listeners.add(fn),
      async eval(expr, { awaitPromise = true } = {}) {
        const r = await send('Runtime.evaluate', {
          expression: expr, awaitPromise, returnByValue: true,
        }, sessionId)
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
        return r.result.value
      },
      async goto(url) {
        await send('Page.navigate', { url }, sessionId)
        await new Promise((r) => setTimeout(r, 900))
      },
      async waitFor(expr, { timeout = 15000, every = 150 } = {}) {
        const until = Date.now() + timeout
        for (;;) {
          if (await api.eval(`!!(${expr})`)) return true
          if (Date.now() > until) throw new Error('timed out waiting for: ' + expr)
          await new Promise((r) => setTimeout(r, every))
        }
      },
    }
    await api.send('Page.enable')
    await api.send('Runtime.enable')
    await api.send('Log.enable')
    await api.send('Network.enable')
    return await fn(api)
  } finally {
    ws.close()
    chrome.kill()
    await new Promise((r) => setTimeout(r, 300))
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
}
