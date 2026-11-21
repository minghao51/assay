// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AU-3 au3-1 boundary probe: hostile Unicode through edit → materialize →
 * export (the investigative follow-up to the CSV header-guard fix).
 *
 * Three values × two composed paths, pinned against real DuckDB 1.5.5:
 *
 * | value            | materialize                          | export (CSV/JSON/parquet)            |
 * | ---------------- | ------------------------------------ | ------------------------------------ |
 * | NUL `\u0000`     | rejected, value-free `Parser Error`  | rejected, value-free `Parser Error`  |
 * | emoji 😀 U+1F600  | round-trips byte-for-byte            | round-trips byte-for-byte            |
 * | lone `\uD800`    | rejected, value-free (au3-13 guard)  | rejected, value-free (au3-13 guard)  |
 *
 * Why each outcome:
 * - `sqlStringLiteral` (used by `cellLiteralSql`/`cellLiteralRawSql`) escapes
 *   only `'`; a NUL is emitted raw between the quotes. DuckDB's lexer stops at
 *   the NUL and answers `Parser Error: unterminated quoted string`. The error
 *   message names the statement window, never the NUL value itself; the
 *   overlay executors additionally replace engine errors with their fixed
 *   value-free classes (`OVERLAY_MATERIALIZATION_FAILURE` /
 *   `EXPORT_MATERIALIZATION_FAILURE`), so end-to-end the NUL path is loud and
 *   value-free.
 * - A 4-byte emoji is a well-formed UTF-8 scalar value; every composed path
 *   round-trips it exactly.
 * - A JS string can carry an *unpaired* surrogate. The engine wire encoder
 *   (`TextEncoder` inside the duckdb-wasm worker; `Buffer.from(s, 'utf8')` in
 *   this suite) replaces it with U+FFFD, and DuckDB cannot represent a lone
 *   surrogate (`chr(0xD800)` → "Invalid UTF8 Codepoint"), so before the au3-13
 *   guard the edit silently materialized as a *different* value. The composer
 *   now rejects an unpaired surrogate loudly and value-free at the cell-literal
 *   boundary (`assertWellFormedCellText`, au3-13) before any SQL reaches the
 *   wire, so the root-cause encoding can never corrupt an accepted value.
 *   Base-data passthrough is untouched: a U+FFFD already in a source file is a
 *   legitimate character and never passes through a literal builder.
 *
 * The composed statements come from the real exported composers — never
 * hand-written. The pinned DuckDB CLI (`/tmp/duckdb`, overridable with
 * `DUCKDB`) follows the agreement pattern of `row-diff-agreement.test.ts` and
 * skips only when the binary is absent.
 *
 * Statements reach the CLI through `-f` (a script file). The CLI's file
 * reader treats an *embedded* NUL as end-of-line (the rest of the line is
 * dropped and the statement window can come out glued), so the
 * engine-rejection pins use a lone NUL, where the CLI agrees with the
 * native engine in outcome (a loud, value-free `Parser Error`). The au3-1
 * drill cross-checked the embedded NUL against the authoritative native
 * bindings (`@duckdb/node-api` 1.5.5): every format rejects it with a
 * value-free `Parser Error`, exactly like the lone NUL. Emoji and
 * lone-surrogate pins are unaffected by the quirk and are also
 * native-cross-checked.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldOverlay } from '@assay/domain'
import type { CellValue, EditOp, OverlayBase, RowId } from '@assay/domain'
import { cellLiteralRawSql, cellLiteralSql, composeOverlayWindowSql } from './overlay-query'
import { composeOverlayExportSql } from './export-query'

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

/** Test-side branded-id constructor for canonical literal ids. */
const rid = (text: string): RowId => text as RowId

const NUL = '\u0000'
const EMOJI = '\u{1F600}'
const LONE_SURROGATE = '\uD800'
/** A distinctive marker in a *neighbouring* edit, to detect value-bearing errors. */
const SENTINEL = 'AU3SECRET'

const BASE: OverlayBase = {
  baseAnchor: 'b1',
  overlayAnchor: 'o1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 2,
}

const SETUP = [
  'CREATE TABLE assay_t1 (id BIGINT, label VARCHAR);',
  "INSERT INTO assay_t1 VALUES (1, 'base'), (2, 'base2');",
]

function compositionFor(ops: readonly EditOp[]): {
  viewName: string
  base: OverlayBase
  state: ReturnType<typeof foldOverlay>['state']
} {
  return { viewName: 'assay_t1', base: BASE, state: foldOverlay(BASE, ops).state }
}

function editComposition(value: CellValue): ReturnType<typeof compositionFor> {
  return compositionFor([{ kind: 'cell-set', rowId: rid('base:b1#0'), column: 'label', value }])
}

interface RunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run the statement list through the pinned CLI. The script is UTF-8 encoded
 * by `writeFileSync(..., 'utf8')`, which replaces an unpaired surrogate with
 * U+FFFD — exactly the duckdb-wasm worker's `new TextEncoder().encode(sql)`
 * path (`duckdb-browser-mvp.worker.js`). A NUL is written raw, as
 * `TextEncoder` would.
 */
function runStatements(dir: string, statements: readonly string[]): RunResult {
  const script = join(dir, 'probe.sql')
  writeFileSync(script, statements.join('\n') + '\n', 'utf8')
  try {
    const stdout = execFileSync(DUCKDB_CLI, [join(dir, 'probe.duckdb'), '-f', script], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(stdout), stderr: '' }
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      ok: false,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    }
  }
}

/** Run `fn` against a fresh scratch directory (removed afterwards). */
function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'assay-au3-boundary-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('AU-3 boundary probe — composed string literals', () => {
  it('pins the root cause: sqlStringLiteral cannot escape NUL', () => {
    // `cellLiteralSql` wraps `sqlStringLiteral`, which escapes only `'`.
    // The NUL is emitted raw between the single quotes.
    expect(cellLiteralSql({ kind: 'string', value: `a${NUL}b` }, 'VARCHAR')).toBe(
      `CAST('a${NUL}b' AS VARCHAR)`,
    )
    expect(cellLiteralRawSql({ kind: 'string', value: `a${NUL}b` })).toBe(`'a${NUL}b'`)
  })

  it('composes a well-formed 4-byte emoji verbatim', () => {
    expect(cellLiteralSql({ kind: 'string', value: EMOJI }, 'VARCHAR')).toBe(
      `CAST('${EMOJI}' AS VARCHAR)`,
    )
  })

  it('rejects a lone surrogate value-free at the cell-literal boundary (au3-13)', () => {
    // Both user-literal kinds are rejected before any SQL is composed.
    expect(() => cellLiteralSql({ kind: 'string', value: LONE_SURROGATE }, 'VARCHAR')).toThrow(
      /unpaired surrogate/,
    )
    expect(() => cellLiteralSql({ kind: 'text', text: LONE_SURROGATE }, 'VARCHAR')).toThrow(
      /unpaired surrogate/,
    )
    expect(() => cellLiteralRawSql({ kind: 'string', value: LONE_SURROGATE })).toThrow(
      /unpaired surrogate/,
    )

    // Value-free: the message names the defect, never the cell text.
    let message = ''
    try {
      cellLiteralSql({ kind: 'string', value: LONE_SURROGATE }, 'VARCHAR')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain(LONE_SURROGATE)
  })

  it('the engine wire encoder replaces a lone surrogate with U+FFFD', () => {
    // The duckdb-wasm worker calls `new TextEncoder().encode(sql)`; Node's
    // utf8 Buffer does the same. Neither can carry an unpaired surrogate.
    expect([...new TextEncoder().encode(LONE_SURROGATE)]).toEqual([0xef, 0xbf, 0xbd])
    expect(Buffer.from(LONE_SURROGATE, 'utf8').toString('utf8')).toBe('\uFFFD')
    // The 4-byte emoji round-trips exactly.
    expect([...new TextEncoder().encode(EMOJI)]).toEqual([0xf0, 0x9f, 0x98, 0x80])
  })
})

describe.skipIf(!hasDuckDbCli)('AU-3 boundary probe vs DuckDB 1.5.5 (pinned CLI)', () => {
  it('pins the dialect: the CLI is the 1.5.x series', () => {
    expect(execFileSync(DUCKDB_CLI, ['--version'], { encoding: 'utf8' })).toMatch(/v1\.5\./)
  })

  it('NUL edit: materialize and every export reject with a value-free parser error', () => {
    // A lone NUL is the CLI-faithful form (the CLI's file reader treats an
    // embedded NUL as end-of-line, gluing the window); the native engine
    // rejects embedded NUL in every format with the same value-free error.
    const composition = editComposition({ kind: 'string', value: NUL })
    const materialize = composeOverlayWindowSql({ ...composition, limit: 10, offset: 0 })
    // The composed statement really does carry the raw NUL (the root cause).
    expect(materialize).toContain(NUL)

    const materialized = withDir((dir) => runStatements(dir, [...SETUP, materialize]))
    expect(materialized.ok).toBe(false)
    expect(materialized.stderr).toMatch(/Parser Error/)
    // Value-free: the NUL itself is never echoed back as data.
    expect(materialized.stderr).not.toContain(NUL)

    for (const [format, destination] of [
      ['csv', 'out.csv'],
      ['json', 'out.json'],
      ['jsonl', 'out.jsonl'],
      ['parquet', 'out.parquet'],
    ] as const) {
      const exportSql = composeOverlayExportSql(composition, format, destination)
      expect(exportSql).not.toBeNull()
      const result = withDir((dir) => runStatements(dir, [...SETUP, exportSql!]))
      expect(result.ok, `${format} export must be rejected`).toBe(false)
      expect(result.stderr, `${format} export error must be value-free`).not.toContain(NUL)
    }
  })

  it('NUL insert: the insert branch rejects the same way', () => {
    const composition = compositionFor([
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map<string, CellValue>([
          ['id', { kind: 'number', value: 3 }],
          ['label', { kind: 'string', value: NUL }],
        ]),
      },
    ])
    const materialize = composeOverlayWindowSql({ ...composition, limit: 10, offset: 0 })
    const result = withDir((dir) => runStatements(dir, [...SETUP, materialize]))
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/Parser Error/)
    expect(result.stderr).not.toContain(NUL)
  })

  it('characterizes the raw NUL error window (neighbouring value may echo; executors wrap)', () => {
    // When the NUL arm follows another edit, DuckDB's parser-error window
    // echoes a fragment of the *preceding* statement text — which is why the
    // executors wrap engine errors in their fixed value-free classes (au3-3).
    // This test documents the raw composer+engine behavior; it will start
    // failing if the composer ever gains a NUL guard (then update it).
    const composition = compositionFor([
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'label',
        value: { kind: 'string', value: SENTINEL },
      },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#1'),
        column: 'label',
        value: { kind: 'string', value: NUL },
      },
    ])
    const materialize = composeOverlayWindowSql({ ...composition, limit: 10, offset: 0 })
    const result = withDir((dir) => runStatements(dir, [...SETUP, materialize]))
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain(SENTINEL)
  })

  it('4-byte emoji edit round-trips through materialize and CSV/JSON export', () => {
    const composition = editComposition({ kind: 'string', value: EMOJI })
    const materialize = composeOverlayWindowSql({ ...composition, limit: 10, offset: 0 })
    const materialized = withDir((dir) => runStatements(dir, [...SETUP, materialize]))
    expect(materialized.ok).toBe(true)
    expect(materialized.stdout).toContain(EMOJI)

    withDir((dir) => {
      const result = runStatements(dir, [
        ...SETUP,
        composeOverlayExportSql(composition, 'csv', 'out.csv')!,
      ])
      expect(result.ok).toBe(true)
      const bytes = readFileSync(join(dir, 'out.csv'))
      expect(bytes.includes(Buffer.from(EMOJI, 'utf8'))).toBe(true)
    })

    withDir((dir) => {
      const result = runStatements(dir, [
        ...SETUP,
        composeOverlayExportSql(composition, 'json', 'out.json')!,
      ])
      expect(result.ok).toBe(true)
      expect(readFileSync(join(dir, 'out.json'), 'utf8')).toContain(EMOJI)
    })
  })

  it('lone-surrogate edit is rejected value-free at compose time (au3-13 guard)', () => {
    // The composer rejects before it produces any SQL: nothing reaches DuckDB,
    // so the wire encoder never gets the chance to substitute U+FFFD.
    const composition = editComposition({ kind: 'string', value: `AU3SECRET${LONE_SURROGATE}b` })
    expect(() => composeOverlayWindowSql({ ...composition, limit: 10, offset: 0 })).toThrow(
      /unpaired surrogate/,
    )
    expect(() => composeOverlayExportSql(composition, 'csv', 'out.csv')).toThrow(
      /unpaired surrogate/,
    )

    // Value-free (ADR 0025): the message names the defect, never the cell text
    // or a neighbouring value.
    let message = ''
    try {
      composeOverlayWindowSql({ ...composition, limit: 10, offset: 0 })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain(LONE_SURROGATE)
    expect(message).not.toContain('AU3SECRET')
  })

  it('supplementary: a NUL already in base data exports raw (data preservation)', () => {
    // The edit path cannot materialize a NUL (the engine rejects the
    // composed statement), but a NUL read from the source file is ordinary
    // string data: the CSV writer must preserve it, not drop it.
    withDir((dir) => {
      const source = join(dir, 'source.csv')
      writeFileSync(
        source,
        Buffer.from([
          0x69,
          0x64,
          0x2c,
          0x6c,
          0x61,
          0x62,
          0x65,
          0x6c,
          0x0a, // id,label\n
          0x31,
          0x2c,
          0x22,
          0x61,
          0x00,
          0x62,
          0x22,
          0x0a, // 1,"a\0b"\n
        ]),
      )
      const base: OverlayBase = {
        ...BASE,
        baseRowCount: 1,
      }
      const composition = {
        viewName: 'assay_t1',
        base,
        state: foldOverlay(base, []).state,
      }
      const result = runStatements(dir, [
        `CREATE VIEW assay_t1 AS SELECT * FROM read_csv('${source}');`,
        composeOverlayExportSql(composition, 'csv', 'out.csv')!,
      ])
      expect(result.ok).toBe(true)
      const bytes = readFileSync(join(dir, 'out.csv'))
      expect(bytes.includes(0x00)).toBe(true)
    })
  })

  it('supplementary: a U+FFFD already in base data exports raw (au3-13 data preservation)', () => {
    // The cell-literal guard applies only to user-entered edit values; a
    // U+FFFD read from the source file is legitimate data and must survive.
    withDir((dir) => {
      const source = join(dir, 'source.csv')
      writeFileSync(source, 'id,label\n1,"a\uFFFDb"\n', 'utf8')
      const base: OverlayBase = {
        ...BASE,
        baseRowCount: 1,
      }
      const composition = {
        viewName: 'assay_t1',
        base,
        state: foldOverlay(base, []).state,
      }
      const result = runStatements(dir, [
        `CREATE VIEW assay_t1 AS SELECT * FROM read_csv('${source}');`,
        composeOverlayExportSql(composition, 'csv', 'out.csv')!,
      ])
      expect(result.ok).toBe(true)
      const bytes = readFileSync(join(dir, 'out.csv'))
      expect(bytes.includes(Buffer.from('\uFFFD', 'utf8'))).toBe(true)
    })
  })
})
