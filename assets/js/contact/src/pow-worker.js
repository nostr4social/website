// The proof-of-work miner, off the main thread. Built as its own file with
// its own copy of sha256 (see tools/contact-bundle/build.mjs).
//
//   in:  { event, difficulty, start, step }
//   out: { tries }            every few thousand hashes, for the progress line
//        { event, tries }     when the id meets the difficulty

import { mineSync } from './pow-core.js'

self.onmessage = ({ data }) => {
  const { event, difficulty, start = 1, step = 1 } = data
  const result = mineSync(event, difficulty, {
    start,
    step,
    onBatch: (tries) => {
      self.postMessage({ tries })
      return true
    },
  })
  if (result) self.postMessage(result)
}
