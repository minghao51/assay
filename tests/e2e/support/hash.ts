import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/**
 * Shared hashing for the e2e suite (q-5, AR-F4): the source-immutability
 * journey and the engine harness both need sha256 — one definition here.
 */

/** Lowercase-hex sha256 of an in-memory byte buffer. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Lowercase-hex sha256 of a file, hashed through a fixed 1 MiB read window
 * (G1-R: the whole file must be verified, but at multi-GB sizes a whole-file
 * `readFileSync` allocates the entire fixture in RAM — ~10 GiB against a
 * ~30 GiB machine — before hashing a byte). Chunked hashing keeps memory
 * constant and produces the identical digest.
 *
 * Synchronous on purpose: the big-fixture reuse decision is sync, and the
 * hermetic reuse spec calls this from a synchronous test.
 */
export function sha256File(filePath: string): string {
  const hash = createHash('sha256')
  const fd = openSync(filePath, 'r')
  try {
    const size = fstatSync(fd).size
    const chunk = Buffer.alloc(1024 * 1024)
    let position = 0
    while (position < size) {
      const read = readSync(fd, chunk, 0, chunk.length, position)
      if (read <= 0) break // EOF before size: file truncated under us — hash what we got
      hash.update(chunk.subarray(0, read))
      position += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}
