import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './support/fixture'
import { BIG_ROW_COUNT, metaMatches, sha256File } from './support/big-fixture'

// Negative test for the m1-7 bench-fixture reuse check (T4; m1-7 reviewer
// carry-over): the sidecar meta has always stored sha256, but the old reuse
// decision compared rows+bytes only — a same-size corrupted big.parquet was
// silently reused and every bench number built on corrupt bytes. The
// decision now lives in the pure `metaMatches(meta, stat, sha256)`, which
// `ensureBigFixture` consults (over the re-hashed file) before reusing.
//
// Runs in the DEFAULT suite by design: it doctors two small same-size files
// in a fresh temp dir — no ASSAY_E2E_BIG_BENCH, no DuckDB CLI, no ~1 GiB
// fixture, no browser page. The real bench fixture is never touched:
// rejecting it would push `ensureBigFixture` into CLI regeneration, which
// the default suite must not require (that end-to-end path is covered by the
// gated bench run, which prints the `[m1-7 fixture] reused … meta+sha256
// match` line).

test('bench fixture reuse rejects a same-size corrupted file (sha256 meta check)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-e2e-t4-reuse-'))
  try {
    // Two files of identical size differing only in the last byte: the
    // sha256 must see the difference (whole-file hashing) while a size
    // comparison cannot — the exact corruption shape the old check missed.
    const good = Buffer.alloc(65_536)
    const corrupt = Buffer.from(good)
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1] ^ 0xff
    const goodPath = path.join(dir, 'good.parquet')
    const corruptPath = path.join(dir, 'corrupt.parquet')
    writeFileSync(goodPath, good)
    writeFileSync(corruptPath, corrupt)

    const bytes = good.length
    expect(statSync(corruptPath).size, 'the corruption is same-size').toBe(bytes)
    const goodSha = sha256File(goodPath)
    const corruptSha = sha256File(corruptPath)
    expect(corruptSha, 'sha256 distinguishes the corrupted file').not.toBe(goodSha)

    // The meta the generator would have written for the good file.
    const meta = { rows: BIG_ROW_COUNT, bytes, sha256: goodSha }

    // Anchor: these inputs defeat exactly the old check — rows and bytes
    // agree — so a rows+bytes-only decision would reuse the corrupt file.
    // This is the assertion that fails if the hardened comparison is lost.
    expect(meta.rows === BIG_ROW_COUNT && meta.bytes === bytes && bytes > 0).toBe(true)

    // Hardened decision: the corrupt file is rejected (→ regeneration), the
    // honest file is reused.
    expect(metaMatches(meta, { rows: BIG_ROW_COUNT, bytes }, corruptSha)).toBe(false)
    expect(metaMatches(meta, { rows: BIG_ROW_COUNT, bytes }, goodSha)).toBe(true)

    // A meta without a usable sha256 can never be verified — reject.
    expect(
      metaMatches({ rows: BIG_ROW_COUNT, bytes }, { rows: BIG_ROW_COUNT, bytes }, corruptSha),
    ).toBe(false)

    // The pre-existing guards keep their meaning alongside the hash check.
    expect(metaMatches(meta, { rows: BIG_ROW_COUNT - 1, bytes }, goodSha)).toBe(false)
    expect(metaMatches(meta, { rows: BIG_ROW_COUNT, bytes: 0 }, goodSha)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
