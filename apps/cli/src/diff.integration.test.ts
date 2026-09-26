// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests for `assay diff` (m6-3): every test SPAWNS the COMPILED
 * CLI (`node --import tsx dist/index.js …`, ADR 0042) against temp file pairs
 * built at runtime and never committed. Outputs are BYTE-PINNED where they
 * are path-free (the renderers keep dataset paths out of stdout), so these
 * pins are exact bytes, not shapes.
 *
 * The `tsx` loader is a test-harness concession (workspace packages still
 * export `src/*.ts`); the CLI's own entry is the compiled artifact.
 *
 * The cross-surface agreement test (§"agreement") executes the SAME compiled
 * DiffPlan through the Node executor in-process — the m6-2 engine path, via
 * the `./node` seam — and asserts per-aspect `{count, samples}` equality
 * against the spawned CLI's `--format json` report. The plan is compiled
 * once and executed once on this surface; the CLI compiles its own from the
 * same inputs, so the agreement is between two independent executions of the
 * shared engine machinery (the m5-4/m6-5 discipline, rebuilt on demand).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { compileRowDiffPlan } from '@assay/diff'
import { DATASET_VIEW, openConnection, registerDatasetAs } from './connection.js'
import { prepareDiffPlan, runDiffPlan } from './node-executor.js'

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPARISON_VIEW = 'assay_t2'

interface CliRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Spawn the compiled CLI (ADR 0042): `node --import tsx dist/index.js …`. */
function runCli(args: readonly string[]): CliRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'dist/index.js', ...args], {
    cwd: CLI_DIR,
    encoding: 'utf8',
  })
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

interface TestFiles {
  [name: string]: string
}

let files: TestFiles
let dir: string

/** The three-row reference table shared by the identical/row/schema pairs. */
const BASE_CSV = 'id,amount,region\n1,10,SG\n2,20,US\n3,30,SG\n'

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'assay-m6-3-'))
  const write = (name: string, text: string): string => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }
  files = {
    sameA: write('same-a.csv', BASE_CSV),
    sameB: write('same-b.csv', BASE_CSV),
    rowA: write('row-a.csv', BASE_CSV),
    rowB: write('row-b.csv', 'id,amount,region\n1,10,SG\n2,25,US\n4,40,DE\n'),
    schemaA: write('schema-a.csv', BASE_CSV),
    schemaB: write('schema-b.csv', 'id,amount,region,score\n1,10,SG,9\n2,20,US,8\n3,30,SG,7\n'),
    inferA: write('infer-a.csv', BASE_CSV),
    inferB: write('infer-b.csv', 'id,amount,region\n1,10,SG\n2,20,US\n4,40,DE\n'),
    mismatchA: write('mismatch-a.csv', 'id,amount\n1,10\n2,20\n'),
    mismatchB: write('mismatch-b.csv', 'id,amount\nx,10\ny,20\n'),
    onlyKeyA: write('onlykey-a.csv', 'id\n1\n2\n'),
    onlyKeyB: write('onlykey-b.csv', 'id,extra\n1,x\n2,y\n'),
    dupAll: write('alldup.csv', 'id,amount,region\n1,10,SG\n1,10,SG\n1,10,SG\n'),
    xlsx: write('dataset.xlsx', 'not really xlsx'),
    clampA: write('clamp-a.csv', buildClampA()),
    clampB: write('clamp-b.csv', buildClampB()),
  }
})

/** One A row and 121 B rows sharing only id=1 (120 added, K-clamped). */
function buildClampA(): string {
  return 'id,v\n1,a\n'
}

function buildClampB(): string {
  const lines = ['id,v', '1,a']
  for (let id = 2; id <= 121; id++) lines.push(`${String(id)},n${String(id)}`)
  return lines.join('\n') + '\n'
}

describe('diff — byte-pinned happy paths', () => {
  it('identical files (exit 0): explicit keys, honest identity verdict', () => {
    const run = runCli(['diff', files.sameA, files.sameB, '--key', 'id'])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `a: same-a.csv (csv)
b: same-b.csv (csv)
rows: 3 -> 3
keys: id (explicit)
schema drift: none
profile deltas: none
row diff: 0 added, 0 removed, 0 changed
  added (0):
    none
  removed (0):
    none
  changed (0):
    none
verdict: IDENTICAL — no differences found (row diff ran on keys: id; schema/profile-level identity alone would not prove row identity)
`,
    )
  })

  it('identical files: --format json is the pinned envelope with identical true', () => {
    const run = runCli(['diff', files.sameA, files.sameB, '--key', 'id', '--format', 'json'])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(`{
  "report": "assay-diff-report",
  "baseViewOnly": true,
  "a": {
    "name": "same-a.csv",
    "format": "csv"
  },
  "b": {
    "name": "same-b.csv",
    "format": "csv"
  },
  "keys": [
    "id"
  ],
  "keySource": "explicit",
  "inference": null,
  "sampleLimitRequested": 20,
  "sampleLimitEffective": 20,
  "schemaDrift": [],
  "columnDeltas": [
    {
      "column": "id",
      "typeA": "BIGINT",
      "typeB": "BIGINT",
      "kindA": "numeric",
      "kindB": "numeric",
      "numeric": {
        "meanShiftStandardized": 0,
        "varianceShiftStandardized": 0,
        "p50Shift": 0,
        "p90Shift": 0
      },
      "categorical": null
    },
    {
      "column": "amount",
      "typeA": "BIGINT",
      "typeB": "BIGINT",
      "kindA": "numeric",
      "kindB": "numeric",
      "numeric": {
        "meanShiftStandardized": 0,
        "varianceShiftStandardized": 0,
        "p50Shift": 0,
        "p90Shift": 0
      },
      "categorical": null
    },
    {
      "column": "region",
      "typeA": "VARCHAR",
      "typeB": "VARCHAR",
      "kindA": "categorical",
      "kindB": "categorical",
      "numeric": null,
      "categorical": {
        "totalVariation": 0,
        "newCategories": [],
        "vanishedCategories": []
      }
    }
  ],
  "rowDiff": {
    "rowCountA": 3,
    "rowCountB": 3,
    "changedComparable": true,
    "added": {
      "count": 0,
      "samplesReturned": 0,
      "samplesComplete": true,
      "samples": []
    },
    "removed": {
      "count": 0,
      "samplesReturned": 0,
      "samplesComplete": true,
      "samples": []
    },
    "changed": {
      "count": 0,
      "samplesReturned": 0,
      "samplesComplete": true,
      "samples": []
    }
  },
  "issues": [],
  "identical": true
}
`)
  })

  it('full pair with row diff (exit 1): schema → profile → row aspect order', () => {
    const run = runCli(['diff', files.rowA, files.rowB, '--key', 'id'])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `a: row-a.csv (csv)
b: row-b.csv (csv)
rows: 3 -> 3
keys: id (explicit)
schema drift: none
profile deltas: 3 columns
  id — numeric: mean shift 0.333333, variance shift 1.333333, p50 shift 0, p90 shift 0.8
  amount — numeric: mean shift 0.5, variance shift 1.25, p50 shift 5, p90 shift 9
  region — categorical: total variation 0.333333, new: [DE], vanished: []
row diff: 1 added, 1 removed, 1 changed
  added (1):
    b #2
  removed (1):
    base #2
  changed (1):
    base #1 — changed: amount
verdict: DIFFERENCES — profile deltas, row diff
`,
    )
  })

  it('schema-drift-only pair (exit 1): the finding leads the report', () => {
    const run = runCli(['diff', files.schemaA, files.schemaB, '--key', 'id'])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `a: schema-a.csv (csv)
b: schema-b.csv (csv)
rows: 3 -> 3
keys: id (explicit)
schema drift: 1 finding
  column-added: score — B BIGINT
profile deltas: none
row diff: 0 added, 0 removed, 0 changed
  added (0):
    none
  removed (0):
    none
  changed (0):
    none
verdict: DIFFERENCES — schema drift
`,
    )
  })

  it('--infer discloses the top candidate and its evidence (exit 1)', () => {
    const run = runCli(['diff', files.inferA, files.inferB, '--infer'])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `a: infer-a.csv (csv)
b: infer-b.csv (csv)
rows: 3 -> 3
keys: id (inferred — top candidate)
inference: key candidate: column 'id' is unique and non-null on both sides (A: BIGINT, 0 nulls, 3 distinct of 3 rows; B: BIGINT, 0 nulls, 3 distinct of 3 rows)
inference outcome: 2 key candidate(s) proposed (single columns the profiles prove non-null and unique on both sides, ranked by profile-A column order); inference is a proposal — confirm keys explicitly before compiling a row diff
schema drift: none
profile deltas: 3 columns
  id — numeric: mean shift 0.333333, variance shift 1.333333, p50 shift 0, p90 shift 0.8
  amount — numeric: mean shift 0.333333, variance shift 1.333333, p50 shift 0, p90 shift 8
  region — categorical: total variation 0.333333, new: [DE], vanished: []
row diff: 1 added, 1 removed, 0 changed
  added (1):
    b #2
  removed (1):
    base #2
  changed (0):
    none
verdict: DIFFERENCES — profile deltas, row diff
`,
    )
  })

  it('--infer emits the structured disclosure in --format json', () => {
    const run = runCli(['diff', files.inferA, files.inferB, '--infer', '--format', 'json'])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    const payload = JSON.parse(run.stdout) as {
      keySource: string
      keys: string[]
      inference: {
        columns: string[]
        candidateDisclosure: string
        outcomeDisclosure: string
        evidence: Record<string, unknown>
      }
      rowDiff: { added: { count: number }; removed: { count: number } }
    }
    expect(payload.keySource).toBe('inferred')
    expect(payload.keys).toEqual(['id'])
    expect(payload.inference.columns).toEqual(['id'])
    expect(payload.inference.candidateDisclosure).toBe(
      "key candidate: column 'id' is unique and non-null on both sides (A: BIGINT, 0 nulls, 3 distinct of 3 rows; B: BIGINT, 0 nulls, 3 distinct of 3 rows)",
    )
    expect(payload.inference.evidence).toEqual({
      column: 'id',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      rowCountA: 3,
      rowCountB: 3,
      nullCountA: 0,
      nullCountB: 0,
      distinctCountA: 3,
      distinctCountB: 3,
    })
    expect(payload.rowDiff.added.count).toBe(1)
    expect(payload.rowDiff.removed.count).toBe(1)
  })

  it('a schema-drift-only pair with no shared non-key column says so honestly', () => {
    const run = runCli(['diff', files.onlyKeyA, files.onlyKeyB, '--key', 'id'])
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toContain('  changed (0 — no shared non-key columns to compare):\n    none')
  })

  it('hostile cell values stay out of stderr (the report is the product)', () => {
    // A changed row whose note value looks like SQL bait: the VALUE may appear
    // as report content (here it is a new categorical category), but stderr
    // must stay empty and the row-diff aspect names only the column.
    const a = join(dir, 'hostile-a.csv')
    const b = join(dir, 'hostile-b.csv')
    writeFileSync(a, 'id,note\n1,ok\n')
    writeFileSync(b, "id,note\n1,'; DROP TABLE assay_x; --\n")
    const run = runCli(['diff', a, b, '--key', 'id'])
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toContain('    base #0 — changed: note')
    expect(run.stderr).toBe('')
  })
})

describe('diff — exit code 2 with readable, value-free stderr', () => {
  it('key-type mismatch (exit 2): exact spellings and the policy reason', () => {
    const run = runCli(['diff', files.mismatchA, files.mismatchB, '--key', 'id'])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `the row diff does not bind against the two datasets:
error: key-type-mismatch (column 'id'): key column 'id' has engine type 'BIGINT' on side A (family 'numeric') and 'VARCHAR' on side B (family 'textual'); the classified families differ and no implicit cross-family key match is performed (a cross-family key is almost certainly a key accident)
`,
    )
  })

  it('a missing key column is a per-side binding error', () => {
    const a = join(dir, 'nokey-a.csv')
    writeFileSync(a, 'id,amount\n1,10\n')
    const run = runCli(['diff', a, files.onlyKeyA, '--key', 'amount'])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `the row diff does not bind against the two datasets:
error: [side B] missing-key-column (column 'amount'): key column 'amount' does not exist on side B (binding is exact and case-sensitive; the schema has 1 columns)
`,
    )
  })

  it('zero inferable candidates is a disclosed binding error (never a silent key)', () => {
    const run = runCli(['diff', files.dupAll, files.dupAll, '--infer'])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `no usable row-diff key could be inferred:
  no key candidate is provable from the profiles: v1 proposes single columns that are non-null and unique on BOTH sides (multi-column joint uniqueness is not derivable from per-column aggregates); choose key columns explicitly
`,
    )
  })

  it('a missing dataset path echoes the path (the caller typed it)', () => {
    const missing = join(dir, 'does-not-exist.csv')
    const run = runCli(['diff', missing, files.sameA, '--key', 'id'])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(`dataset file not found: ${missing}\n`)
  })

  it('an unsupported dataset format names the supported set', () => {
    const run = runCli(['diff', files.xlsx, files.sameA, '--key', 'id'])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toBe(
      `unsupported dataset format 'dataset.xlsx' — supported: parquet, csv, jsonl, json\n`,
    )
  })

  it('usage errors: no key, both key and infer, boolean-with-value, too many paths', () => {
    const noKey = runCli(['diff', files.sameA, files.sameB])
    expect(noKey.exitCode).toBe(2)
    expect(noKey.stderr).toBe('diff requires --key <column> (repeatable) or --infer (see --help)\n')

    const both = runCli(['diff', files.sameA, files.sameB, '--key', 'id', '--infer'])
    expect(both.exitCode).toBe(2)
    expect(both.stderr).toBe(
      '--infer cannot be combined with --key (choose explicit keys or inference)\n',
    )

    const booleanWithValue = runCli(['diff', files.sameA, files.sameB, '--infer=true'])
    expect(booleanWithValue.exitCode).toBe(2)
    expect(booleanWithValue.stderr).toBe("option '--infer' does not take a value (see --help)\n")

    const tooMany = runCli(['diff', files.sameA, files.sameB, files.sameA, '--key', 'id'])
    expect(tooMany.exitCode).toBe(2)
    expect(tooMany.stderr).toBe('diff takes exactly two dataset paths (got 3)\n')

    const noPath = runCli(['diff'])
    expect(noPath.exitCode).toBe(2)
    expect(noPath.stderr).toBe('diff requires two dataset paths <a> <b> (see --help)\n')

    const badLimit = runCli([
      'diff',
      files.sameA,
      files.sameB,
      '--key',
      'id',
      '--sample-limit',
      '0',
    ])
    expect(badLimit.exitCode).toBe(2)
    expect(badLimit.stderr.startsWith('--sample-limit must be an integer of at least 1')).toBe(true)
  })

  it('cross-command flags are rejected, not silently ignored', () => {
    const validateKey = runCli(['validate', files.sameA, '--contract', 'x.yaml', '--key', 'id'])
    expect(validateKey.exitCode).toBe(2)
    expect(validateKey.stderr).toBe(
      'validate does not take --key (did you mean `assay diff`? see --help)\n',
    )

    const validateInfer = runCli(['validate', files.sameA, '--contract', 'x.yaml', '--infer'])
    expect(validateInfer.exitCode).toBe(2)
    expect(validateInfer.stderr).toBe(
      'validate does not take --infer (did you mean `assay diff`? see --help)\n',
    )

    const diffContract = runCli([
      'diff',
      files.sameA,
      files.sameB,
      '--key',
      'id',
      '--contract',
      'x.yaml',
    ])
    expect(diffContract.exitCode).toBe(2)
    expect(diffContract.stderr).toBe(
      'diff does not take --contract (did you mean `assay validate`? see --help)\n',
    )
  })

  it('--help advertises diff and its exit codes', () => {
    const run = runCli(['--help'])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain(
      '  diff              compare two dataset versions (schema drift, profile',
    )
    expect(run.stdout).toContain('zero candidates is a binding error (exit 2)')
    expect(run.stdout).toContain('  0   no differences found across the aspects that ran')
  })
})

describe('diff — the K clamp (K > 100 executes, samples clamp, counts stay full)', () => {
  it('K=500 over 120 added rows: count 120, samplesReturned 100, partial', () => {
    const run = runCli([
      'diff',
      files.clampA,
      files.clampB,
      '--key',
      'id',
      '--sample-limit',
      '500',
      '--format',
      'json',
    ])
    expect(run.exitCode).toBe(1)
    const payload = JSON.parse(run.stdout) as {
      sampleLimitRequested: number
      sampleLimitEffective: number
      rowDiff: { added: { count: number; samplesReturned: number; samplesComplete: boolean } }
    }
    expect(payload.sampleLimitRequested).toBe(500)
    expect(payload.sampleLimitEffective).toBe(100)
    expect(payload.rowDiff.added.count).toBe(120)
    expect(payload.rowDiff.added.samplesReturned).toBe(100)
    expect(payload.rowDiff.added.samplesComplete).toBe(false)

    const human = runCli([
      'diff',
      files.clampA,
      files.clampB,
      '--key',
      'id',
      '--sample-limit',
      '500',
    ])
    expect(human.exitCode).toBe(1)
    expect(human.stdout).toContain('  added (120):')
    expect(human.stdout).toContain(
      '    … 20 more added rows not shown (sample limit 500 clamped to 100)',
    )
  })
})

describe('diff — determinism', () => {
  it('two CLI runs are byte-identical (full-report json)', () => {
    const args = ['diff', files.rowA, files.rowB, '--key', 'id', '--format', 'json']
    const first = runCli(args)
    const second = runCli(args)
    expect(first.exitCode).toBe(1)
    expect(second.stdout).toBe(first.stdout)
    expect(second.stderr).toBe(first.stderr)
  })

  it('two CLI runs are byte-identical (inferred human report)', () => {
    const args = ['diff', files.inferA, files.inferB, '--infer']
    const first = runCli(args)
    const second = runCli(args)
    expect(second.stdout).toBe(first.stdout)
    expect(second.stderr).toBe(first.stderr)
  })
})

describe('agreement — the Node engine path vs the spawned CLI', () => {
  it('per-aspect {count, samples} match the in-process engine execution exactly', async () => {
    const conn = await openConnection()
    try {
      const a = await registerDatasetAs(conn, files.rowA, DATASET_VIEW)
      const b = await registerDatasetAs(conn, files.rowB, COMPARISON_VIEW)

      // Compile the plan locally from the same explicit key (the CLI does the
      // same); the engine executes through the same `./node` seam helpers.
      const compiled = compileRowDiffPlan(a.schema, b.schema, ['id'], {
        relationA: 'agreement_rel_a',
        relationB: 'agreement_rel_b',
        sampleLimit: 20,
      })
      if (!compiled.ok) throw new Error('agreement plan must compile')
      const compiledAgain = compileRowDiffPlan(a.schema, b.schema, ['id'], {
        relationA: 'agreement_rel_a',
        relationB: 'agreement_rel_b',
        sampleLimit: 20,
      })
      expect(compiledAgain.ok ? compiledAgain.plan : null).toEqual(compiled.plan)

      const plan = prepareDiffPlan(compiled.plan, [DATASET_VIEW, COMPARISON_VIEW])
      const result = await runDiffPlan(conn, plan, a.schema, COMPARISON_VIEW)

      expect(result.rowCountA).toBe(3)
      expect(result.rowCountB).toBe(3)
      expect(result.aspects.map((aspect) => [aspect.aspect, aspect.count])).toEqual([
        ['added', 1],
        ['removed', 1],
        ['changed', 1],
      ])
      expect(result.aspects.find((aspect) => aspect.aspect === 'added')?.samples).toEqual([
        { side: 'B', rowKey: 'b:2' },
      ])
      expect(result.aspects.find((aspect) => aspect.aspect === 'removed')?.samples).toEqual([
        { side: 'A', rowKey: 'base:#2' },
      ])
      expect(result.aspects.find((aspect) => aspect.aspect === 'changed')?.samples).toEqual([
        { side: 'A', rowKey: 'base:#1', changedColumns: ['amount'] },
      ])

      // The spawned CLI's --format json agrees per aspect, key for key.
      const run = runCli(['diff', files.rowA, files.rowB, '--key', 'id', '--format', 'json'])
      expect(run.exitCode).toBe(1)
      const payload = JSON.parse(run.stdout) as {
        rowDiff: {
          rowCountA: number
          rowCountB: number
          added: { count: number; samples: { side: string; rowKey: string }[] }
          removed: { count: number; samples: { side: string; rowKey: string }[] }
          changed: {
            count: number
            samples: { side: string; rowKey: string; changedColumns: string[] }[]
          }
        }
      }
      expect(payload.rowDiff.rowCountA).toBe(result.rowCountA)
      expect(payload.rowDiff.rowCountB).toBe(result.rowCountB)
      for (const aspect of result.aspects) {
        const reported = payload.rowDiff[aspect.aspect]
        expect(reported.count, aspect.aspect).toBe(aspect.count)
        // A-side engine keys carry the empty base anchor (`base:#n`); the
        // report exports the anchor-free `base:n` form (the m4-3 grammar).
        const exported = aspect.samples.map((sample) =>
          sample.side === 'A' && sample.rowKey.startsWith('base:#')
            ? { ...sample, rowKey: `base:${sample.rowKey.slice('base:#'.length)}` }
            : sample,
        )
        expect(reported.samples, aspect.aspect).toEqual(exported)
      }
    } finally {
      try {
        conn.closeSync()
      } catch {
        // best-effort cleanup
      }
    }
  })
})
