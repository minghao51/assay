// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests for `assay profile` (ar-5; AR-C4): every test SPAWNS the
 * COMPILED CLI (`node --import tsx dist/index.js …`, ADR 0042) against temp
 * files built at runtime and never committed. The human report is
 * BYTE-PINNED; the JSON report is checked for the pinned envelope shape and
 * for two-run byte determinism. The `tsx` loader is a test-harness
 * concession (workspace packages still export `src/*.ts`); the CLI's own
 * entry is the compiled artifact.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { DATASET_VIEW, openConnection, registerDataset } from './connection.js'
import { profileView } from './node-executor.js'

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const SMALL_CSV = 'id,region\n1,DE\n2,XX\n3,DE\n4,\n'

let files: { readonly small: string; readonly xlsx: string }

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'assay-profile-'))
  files = {
    small: join(dir, 'profile-sm.csv'),
    xlsx: join(dir, 'dataset.xlsx'),
  }
  writeFileSync(files.small, SMALL_CSV)
  writeFileSync(files.xlsx, 'not really xlsx')
})

describe('profile — byte-pinned happy paths', () => {
  it('human report: the 4-row dataset renders the pinned bytes (exit 0)', () => {
    const run = runCli(['profile', files.small])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `dataset: profile-sm.csv (csv) — base view only (the raw file; no edits)
rows: 4
columns: 2
column id (BIGINT) — numeric — nulls 0, distinct 4
  min 1, max 4, mean 2.5, stddev 1.2909944487358056, p50 2.5, p90 3.7, p95 3.8499999999999996, p99 3.9699999999999998
column region (VARCHAR) — categorical — nulls 1, distinct 2
  top 2 of 2 distinct non-null values:
    2 × DE
    1 × XX
`,
    )
  })

  it('json report: the pinned envelope shape and fixed key order', () => {
    const run = runCli(['profile', files.small, '--format', 'json'])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(`{
  "report": "assay-profile-report",
  "baseViewOnly": true,
  "dataset": {
    "name": "profile-sm.csv",
    "format": "csv"
  },
  "rows": 4,
  "topK": 10,
  "columns": [
    {
      "name": "id",
      "type": "BIGINT",
      "kind": "numeric",
      "nullCount": 0,
      "distinctCount": 4,
      "numeric": {
        "min": 1,
        "max": 4,
        "mean": 2.5,
        "stddev": 1.2909944487358056,
        "quantiles": {
          "p50": 2.5,
          "p90": 3.7,
          "p95": 3.8499999999999996,
          "p99": 3.9699999999999998
        }
      },
      "categorical": null
    },
    {
      "name": "region",
      "type": "VARCHAR",
      "kind": "categorical",
      "nullCount": 1,
      "distinctCount": 2,
      "numeric": null,
      "categorical": {
        "topK": [
          {
            "value": "DE",
            "count": 2
          },
          {
            "value": "XX",
            "count": 1
          }
        ]
      }
    }
  ]
}
`)
  })

  it('two runs are byte-identical (JSON determinism)', () => {
    const args = ['profile', files.small, '--format', 'json']
    const first = runCli(args)
    const second = runCli(args)
    expect(first.exitCode).toBe(0)
    expect(second.stdout).toBe(first.stdout)
  })

  it('agrees with the in-process `./node` profileView (cross-surface discipline)', async () => {
    const conn = await openConnection()
    try {
      const registered = await registerDataset(conn, files.small)
      const inProcess = await profileView(conn, DATASET_VIEW, registered.schema)
      const run = runCli(['profile', files.small, '--format', 'json'])
      const payload = JSON.parse(run.stdout) as {
        rows: number
        columns: { name: string; nullCount: number; distinctCount: number; kind: string }[]
      }
      expect(payload.rows).toBe(inProcess.rowCount)
      expect(
        payload.columns.map((column) => ({
          name: column.name,
          nullCount: column.nullCount,
          distinctCount: column.distinctCount,
          kind: column.kind,
        })),
      ).toEqual(
        inProcess.columns.map((column) => ({
          name: column.name,
          nullCount: column.nullCount,
          distinctCount: column.distinctCount,
          kind: column.kind,
        })),
      )
    } finally {
      try {
        conn.closeSync()
      } catch {
        // best-effort cleanup
      }
    }
  })
})

describe('profile — exit code 2 with readable, value-free stderr', () => {
  it('a missing dataset path is a readable error', () => {
    const missing = join(dirname(files.small), 'does-not-exist.csv')
    const run = runCli(['profile', missing])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(`dataset file not found: ${missing}\n`)
  })

  it('an unsupported dataset format names the supported set', () => {
    const run = runCli(['profile', files.xlsx])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `unsupported dataset format 'dataset.xlsx' — supported: parquet, csv, jsonl, json\n`,
    )
  })

  it('cross-command flags are rejected, not silently ignored', () => {
    const contract = runCli(['profile', files.small, '--contract', 'x.yaml'])
    expect(contract.exitCode).toBe(2)
    expect(contract.stderr).toBe(
      'profile does not take --contract (did you mean `assay validate`? see --help)\n',
    )

    const key = runCli(['profile', files.small, '--key', 'id'])
    expect(key.exitCode).toBe(2)
    expect(key.stderr).toBe('profile does not take --key (did you mean `assay diff`? see --help)\n')

    const infer = runCli(['profile', files.small, '--infer'])
    expect(infer.exitCode).toBe(2)
    expect(infer.stderr).toBe(
      'profile does not take --infer (did you mean `assay diff`? see --help)\n',
    )

    const sampleLimit = runCli(['profile', files.small, '--sample-limit', '5'])
    expect(sampleLimit.exitCode).toBe(2)
    expect(sampleLimit.stderr).toBe('profile does not take --sample-limit (see --help)\n')
  })

  it('requires exactly one path and a valid --format', () => {
    const noPath = runCli(['profile'])
    expect(noPath.exitCode).toBe(2)
    expect(noPath.stderr).toBe('profile requires a dataset path (see --help)\n')

    const tooMany = runCli(['profile', files.small, files.small])
    expect(tooMany.exitCode).toBe(2)
    expect(tooMany.stderr).toBe('profile takes exactly one dataset path (got 2)\n')

    const badFormat = runCli(['profile', files.small, '--format', 'xml'])
    expect(badFormat.exitCode).toBe(2)
    expect(badFormat.stderr).toBe("--format must be 'human' or 'json' (got 'xml')\n")
  })
})
