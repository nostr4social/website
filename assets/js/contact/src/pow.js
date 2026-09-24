// Drive the miner: a few workers share the search, the first to finish wins,
// the rest are stopped. Falls back to mining on the main thread where workers
// are unavailable, which is slower but correct.

import { mineSync } from './pow-core.js'

export const WORKER_PATH = '/assets/js/contact/pow-worker.js'

function workerCount() {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2
  return Math.max(1, Math.min(4, cores - 1))
}

/**
 * Resolve to `event` with a nonce tag and an id of at least `difficulty`
 * leading zero bits. onProgress({ tries, elapsed }) is called as work goes on.
 */
export function minePow(event, difficulty, { onProgress, signal } = {}) {
  if (!difficulty) return Promise.resolve(event)
  if (typeof Worker === 'undefined') {
    const started = Date.now()
    const { event: mined } = mineSync(event, difficulty, {
      onBatch: (tries) => (onProgress?.({ tries, elapsed: Date.now() - started }), true),
    })
    return Promise.resolve(mined)
  }

  return new Promise((resolve, reject) => {
    const started = Date.now()
    const count = workerCount()
    const workers = []
    const tries = new Array(count).fill(0)
    let done = false

    const stop = () => {
      done = true
      for (const w of workers) w.terminate()
    }
    signal?.addEventListener('abort', () => (stop(), reject(new DOMException('aborted', 'AbortError'))))

    for (let i = 0; i < count; i++) {
      let worker
      try {
        worker = new Worker(WORKER_PATH)
      } catch (err) {
        stop()
        return reject(err)
      }
      workers.push(worker)
      worker.onerror = (err) => (stop(), reject(err.error || new Error('pow worker failed')))
      worker.onmessage = ({ data }) => {
        if (done) return
        tries[i] = data.tries
        if (data.event) {
          stop()
          resolve(data.event)
        } else {
          onProgress?.({ tries: tries.reduce((a, b) => a + b, 0), elapsed: Date.now() - started })
        }
      }
      worker.postMessage({ event, difficulty, start: i + 1, step: count })
    }
  })
}
