/**
 * Integration tests for `assay validate` (m5-4): every test SPAWNS the CLI
 * the way a user does (`node --import tsx src/index.ts …`) against temp
 * dirty files built at runtime and never committed. Outputs are BYTE-PINNED
 * where they are path-free (the renderers keep dataset paths out of stdout
 * and contract-authored text only in stderr), so these pins are exact bytes,
 * not shapes.
 *
 * The cross-surface agreement test (§"agreement") executes the SAME compiled
 * plan through the Node executor in-process and asserts per-rule
 * `{failCount, failPercent}` equality against the m5-2 CLI-1.5.5-derived
 * expectations, then asserts the spawned CLI's `--format json` reports the
 * same per-rule numbers — the engine conformance scenario's agreement
 * discipline, rebuilt on demand (the harness dataset is never imported).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { compileContract } from '@assay/validation'
import { failPercentFromCounts } from '@assay/engine-duckdb/node'
import { parseContract } from '@assay/contracts'
import { openConnection, PLAN_RELATION, registerDataset } from './connection'
import { preparePlan, runValidationPlan } from './node-executor'
import {
  BINDING_ERROR_CONTRACT,
  CLEAN_CONTRACT,
  EMPTY_DATASET_CONTRACT,
  MALFORMED_CONTRACT,
  MALFORMED_YAML_CONTRACT,
  SMALL_DIRTY_CONTRACT,
  SMALL_DIRTY_CSV,
  UNKNOWN_KEY_CONTRACT,
  VALIDATION_BASE_COUNTS,
  VALIDATION_CONTRACT,
  VALIDATION_FIRST_SAMPLES,
  buildValidationJsonl,
} from './test-datasets'

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

interface CliRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Spawn the CLI exactly as documented: `node --import tsx src/index.ts …`. */
function runCli(args: readonly string[]): CliRun {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
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
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'assay-m5-4-'))
  const write = (name: string, text: string): string => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }
  files = {
    small: write('small.csv', SMALL_DIRTY_CSV),
    smallContract: write('small-contract.yaml', SMALL_DIRTY_CONTRACT),
    cleanContract: write('clean-contract.yaml', CLEAN_CONTRACT),
    empty: write('empty.csv', 'id,region,amount\n'),
    emptyContract: write('empty-contract.yaml', EMPTY_DATASET_CONTRACT),
    malformedRange: write('malformed-range.yaml', MALFORMED_CONTRACT),
    malformedYaml: write('malformed-yaml.yaml', MALFORMED_YAML_CONTRACT),
    unknownKey: write('unknown-key.yaml', UNKNOWN_KEY_CONTRACT),
    binding: write('binding.yaml', BINDING_ERROR_CONTRACT),
    validation: write('validation.jsonl', buildValidationJsonl()),
    validationContract: write('validation-contract.yaml', VALIDATION_CONTRACT),
  }
})

describe('validate — byte-pinned happy paths', () => {
  it('human report: the 6-row dirty dataset renders the pinned bytes (exit 1)', () => {
    const run = runCli(['validate', files.small, '--contract', files.smallContract])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `dataset: small.csv (csv) — base view only (the raw file; no edits)
contract: small-dirty v1
rows: 6
rules: 8
FAIL columns[0].unique — id — Unique values — 2 of 6 rows (33%)
     base #0 — 1
     base #3 — 1
FAIL columns[1].allowed-values — region — Allowed values — 2 of 6 rows (33%)
     base #1 — XX
     base #5 — ZZ
FAIL columns[2].min — amount — Minimum bound — 1 of 6 rows (17%)
     base #4 — -3
PASS dataset.max-rows — Maximum row count — 0 violations
PASS dataset.min-rows — Minimum row count — 0 violations
PASS columns[0].required — id — Required (no NULLs) — 0 violations
PASS columns[1].required — region — Required (no NULLs) — 0 violations
PASS columns[3].required — note — Required (no NULLs) — 0 violations
verdict: INVALID — 3 of 8 rules failing (6 rows)
`,
    )
  })

  it('json report: the same dataset renders the pinned bytes (exit 1)', () => {
    const run = runCli([
      'validate',
      files.small,
      '--contract',
      files.smallContract,
      '--format',
      'json',
    ])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(`{
  "report": "assay-validation-report",
  "baseViewOnly": true,
  "contract": {
    "name": "small-dirty",
    "version": 1
  },
  "valid": false,
  "stale": false,
  "datasetRows": 6,
  "rules": [
    {
      "ruleId": "columns[0].unique",
      "column": "id",
      "rule": "unique",
      "label": "Unique values",
      "failCount": 2,
      "failPercent": 33,
      "samplesReturned": 2,
      "samplesComplete": true,
      "sampleRowKeys": [
        "base:0",
        "base:3"
      ],
      "sampleValues": [
        1,
        1
      ]
    },
    {
      "ruleId": "columns[1].allowed-values",
      "column": "region",
      "rule": "allowed-values",
      "label": "Allowed values",
      "failCount": 2,
      "failPercent": 33,
      "samplesReturned": 2,
      "samplesComplete": true,
      "sampleRowKeys": [
        "base:1",
        "base:5"
      ],
      "sampleValues": [
        "XX",
        "ZZ"
      ]
    },
    {
      "ruleId": "columns[2].min",
      "column": "amount",
      "rule": "min",
      "label": "Minimum bound",
      "failCount": 1,
      "failPercent": 17,
      "samplesReturned": 1,
      "samplesComplete": true,
      "sampleRowKeys": [
        "base:4"
      ],
      "sampleValues": [
        -3
      ]
    },
    {
      "ruleId": "dataset.max-rows",
      "column": null,
      "rule": "max-rows",
      "label": "Maximum row count",
      "failCount": 0,
      "failPercent": 0,
      "samplesReturned": 0,
      "samplesComplete": true,
      "sampleRowKeys": [],
      "sampleValues": []
    },
    {
      "ruleId": "dataset.min-rows",
      "column": null,
      "rule": "min-rows",
      "label": "Minimum row count",
      "failCount": 0,
      "failPercent": 0,
      "samplesReturned": 0,
      "samplesComplete": true,
      "sampleRowKeys": [],
      "sampleValues": []
    },
    {
      "ruleId": "columns[0].required",
      "column": "id",
      "rule": "required",
      "label": "Required (no NULLs)",
      "failCount": 0,
      "failPercent": 0,
      "samplesReturned": 0,
      "samplesComplete": true,
      "sampleRowKeys": [],
      "sampleValues": []
    },
    {
      "ruleId": "columns[1].required",
      "column": "region",
      "rule": "required",
      "label": "Required (no NULLs)",
      "failCount": 0,
      "failPercent": 0,
      "samplesReturned": 0,
      "samplesComplete": true,
      "sampleRowKeys": [],
      "sampleValues": []
    },
    {
      "ruleId": "columns[3].required",
      "column": "note",
      "rule": "required",
      "label": "Required (no NULLs)",
      "failCount": 0,
      "failPercent": 0,
      "samplesReturned": 0,
      "samplesComplete": true,
      "sampleRowKeys": [],
      "sampleValues": []
    }
  ]
}
`)
  })

  it('a clean dataset is exit 0 with the honest zero-state verdict', () => {
    const run = runCli(['validate', files.small, '--contract', files.cleanContract])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe(
      `dataset: small.csv (csv) — base view only (the raw file; no edits)
contract: clean-check v3
rows: 6
rules: 5
PASS dataset.max-rows — Maximum row count — 0 violations
PASS dataset.min-rows — Minimum row count — 0 violations
PASS columns[0].required — id — Required (no NULLs) — 0 violations
PASS columns[1].allowed-values — region — Allowed values — 0 violations
PASS columns[1].required — region — Required (no NULLs) — 0 violations
verdict: VALID — 0 violations across 5 rules (6 rows)
`,
    )
  })

  it('an empty dataset (0 rows) renders the honest zero states — shares stay 0', () => {
    const run = runCli([
      'validate',
      files.empty,
      '--contract',
      files.emptyContract,
      '--format',
      'json',
    ])
    expect(run.exitCode).toBe(0)
    const payload = JSON.parse(run.stdout) as {
      datasetRows: number
      valid: boolean
      rules: { failCount: number; failPercent: number }[]
    }
    expect(payload.datasetRows).toBe(0)
    expect(payload.valid).toBe(true)
    for (const rule of payload.rules) {
      expect(rule.failCount).toBe(0)
      expect(rule.failPercent).toBe(0) // the documented empty-dataset convention
    }
  })

  it('quote-laden and DROP-bait values print verbatim as sample rows (stdout only)', () => {
    const run = runCli(['validate', files.validation, '--contract', files.validationContract])
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toContain(`base #59 — '; DROP TABLE assay_conf_injected; --`)
    expect(run.stdout).toContain(`base #11 — o'brien`)
    // The duplicate-id sample carries a bare number value; NULL samples
    // (amount #7) render through the share rule's dataset-fact — no row.
    expect(run.stdout).toContain(`base #0 — 1`)
    // Privacy: stderr stays empty on a successful run — values NEVER land there.
    expect(run.stderr).toBe('')
  })
})

describe('validate — exit code 2 with readable stderr', () => {
  it('malformed contract: out-of-range bounds, with path:line:column (pinned bytes)', () => {
    const run = runCli(['validate', files.small, '--contract', files.malformedRange])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `contract could not be parsed:
error: columns[0].max:7:10: columns[0].max: max (1) must be ≥ min (5)
`,
    )
  })

  it('malformed contract: YAML syntax error, with line/column (pinned bytes)', () => {
    const run = runCli(['validate', files.small, '--contract', files.malformedYaml])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `contract could not be parsed:
error: document:6:1: YAML syntax error: Sequence item without - indicator at line 6, column 1:

  - name: id
   min: [unclosed
^

error: document:7:1: YAML syntax error: Flow sequence in block collection must be sufficiently indented and end with a ] at line 7, column 1:

   min: [unclosed

^

`,
    )
  })

  it('malformed contract: unknown rule key, attributed to the entry (pinned bytes)', () => {
    const run = runCli(['validate', files.small, '--contract', files.unknownKey])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `contract could not be parsed:
error: columns[0]:6:5: unknown key "frobnicate" in the rule set at "columns[0]"; expected one of: name, type, required, unique, min, max, allowed-values, regex, max-null-share, min-distinct-share
`,
    )
  })

  it('binding errors: per-rule attribution on stderr, one line per error (pinned bytes)', () => {
    const run = runCli(['validate', files.small, '--contract', files.binding])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `contract does not bind against the dataset:
error: columns[0].required (column 'ghost_col'): [missing-column] rule addresses column 'ghost_col', which does not exist in the target schema (binding is exact and case-sensitive; the schema has 4 columns)
error: columns[1].min (column 'region'): [rule-not-applicable] min/max bounds require a numeric column, but column 'region' has engine type 'VARCHAR' (family 'textual')
`,
    )
  })

  it('a missing dataset path is a readable stderr error', () => {
    const missing = join(dir, 'does-not-exist.csv')
    const run = runCli(['validate', missing, '--contract', files.smallContract])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(`dataset file not found: ${missing}\n`)
  })

  it('a missing contract file is a readable stderr error', () => {
    const missing = join(dir, 'no-such-contract.yaml')
    const run = runCli(['validate', files.small, '--contract', missing])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(`contract file not readable: ${missing}\n`)
  })

  it('an unsupported dataset format names the supported set', () => {
    const xlsx = join(dir, 'dataset.xlsx')
    writeFileSync(xlsx, 'not really xlsx')
    const run = runCli(['validate', xlsx, '--contract', files.smallContract])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toBe(
      `unsupported dataset format 'dataset.xlsx' — supported: parquet, csv, jsonl, json\n`,
    )
  })

  it('a corrupt dataset file becomes a fixed failure class, not engine text', () => {
    const corrupt = join(dir, 'corrupt.parquet')
    writeFileSync(corrupt, 'PAG1 garbage bytes')
    const run = runCli(['validate', corrupt, '--contract', files.smallContract])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('the dataset could not be opened (parquet reader refused the file)\n')
  })

  it('violated min-rows on an EMPTY dataset is refused by the result-sanity guard (documented edge)', () => {
    // A min-rows fact over 0 rows reports failCount 1 > rowCount 0 — the
    // engine's m5-2 result-sanity guard refuses that shape, and the CLI
    // replicates the guard exactly (cross-surface discipline). This is a
    // genuine shared upstream edge (legitimate compiler output the guard
    // rejects); reported to the orchestrator, pinned here as executed.
    const contract = `format: v1
name: empty-edge
version: 1
columns: []
dataset:
  min-rows: 1
`
    const path = join(dir, 'empty-edge.yaml')
    writeFileSync(path, contract)
    const run = runCli(['validate', files.empty, '--contract', path])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      "validation rule 'dataset.min-rows' reported more failures than rows in the dataset\n",
    )
  })

  it('--sample-limit must be a positive integer', () => {
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      const run = runCli([
        'validate',
        files.small,
        '--contract',
        files.smallContract,
        '--sample-limit',
        bad,
      ])
      expect(run.exitCode).toBe(2)
      expect(run.stdout).toBe('')
      expect(run.stderr.startsWith('--sample-limit must be an integer of at least 1')).toBe(true)
    }
  })

  it('unknown flags, missing --contract, and missing path are usage errors', () => {
    const unknown = runCli([
      'validate',
      files.small,
      '--contract',
      files.smallContract,
      '--frobnicate',
    ])
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr).toBe("unknown option '--frobnicate' (see --help)\n")

    const noContract = runCli(['validate', files.small])
    expect(noContract.exitCode).toBe(2)
    expect(noContract.stderr).toBe('validate requires --contract <file> (see --help)\n')

    const noPath = runCli(['validate', '--contract', files.smallContract])
    expect(noPath.exitCode).toBe(2)
    expect(noPath.stderr).toBe('validate requires a dataset path (see --help)\n')

    const unknownCommand = runCli(['profile', files.small])
    expect(unknownCommand.exitCode).toBe(2)
    expect(unknownCommand.stderr).toBe("unknown command 'profile' (see --help)\n")

    const noArgs = runCli([])
    expect(noArgs.exitCode).toBe(2)
    expect(noArgs.stdout).toContain('usage:')
  })

  it('--help advertises the command and exits 0 (pinned opening bytes)', () => {
    const run = runCli(['--help'])
    expect(run.exitCode).toBe(0)
    expect(run.stdout.startsWith('assay 0.0.0 — the local-first data workbench CLI')).toBe(true)
    expect(run.stdout).toContain('  validate          validate a dataset against an assay contract')
    expect(run.stdout).toContain('exit codes:')
    expect(run.stdout).toContain('baseViewOnly: true and stale: false in --format json')
  })
})

describe('validate — the K clamp (K > 100 executes, samples clamp, counts stay full)', () => {
  it('K=500 over 110 tag violations: failCount 110, samplesReturned 100, partial flag', () => {
    const run = runCli([
      'validate',
      files.validation,
      '--contract',
      files.validationContract,
      '--sample-limit',
      '500',
      '--format',
      'json',
    ])
    expect(run.exitCode).toBe(1)
    const payload = JSON.parse(run.stdout) as {
      rules: {
        ruleId: string
        failCount: number
        failPercent: number
        samplesReturned: number
        samplesComplete: boolean
      }[]
    }
    const tag = payload.rules.find((rule) => rule.ruleId === 'columns[5].allowed-values')
    expect(tag).toBeDefined()
    expect(tag?.failCount).toBe(110) // the FULL violation count, not the bound
    expect(tag?.samplesReturned).toBe(100) // the engine hard max
    expect(tag?.samplesComplete).toBe(false)

    const human = runCli([
      'validate',
      files.validation,
      '--contract',
      files.validationContract,
      '--sample-limit',
      '500',
    ])
    expect(human.exitCode).toBe(1)
    expect(human.stdout).toContain('… 10 more failures not shown (sample limit 500 clamped to 100)')
  })
})

describe('agreement — the Node backend vs the m5-2 CLI-derived expectations', () => {
  it('per-rule {failCount, failPercent} matches the CLI-1.5.5-derived pins exactly', async () => {
    const conn = await openConnection()
    try {
      const { schema } = await registerDataset(conn, files.validation)
      const parsed = parseContract(VALIDATION_CONTRACT)
      if (!parsed.ok) throw new Error('agreement contract must parse')
      const compiled = compileContract(parsed.contract, schema, {
        relation: PLAN_RELATION,
        sampleLimit: 20,
      })
      if (!compiled.ok) throw new Error('agreement contract must bind')
      // Two compiles are byte-identical (the determinism agreement rests on).
      const compiledAgain = compileContract(parsed.contract, schema, {
        relation: PLAN_RELATION,
        sampleLimit: 20,
      })
      expect(compiledAgain.ok ? compiledAgain.plan : null).toEqual(compiled.plan)

      const plan = preparePlan(compiled.plan, ['assay_t1'])
      const result = await runValidationPlan(conn, plan, schema)

      expect(result.rowCount).toBe(120)
      expect(result.valid).toBe(false)
      expect(result.rules.map((rule) => rule.ruleId)).toEqual(
        VALIDATION_BASE_COUNTS.map(([ruleId]) => ruleId),
      )
      const failPercentByRule = new Map(
        result.rules.map((rule) => [rule.ruleId, rule.failPercent] as const),
      )
      for (const [ruleId, failCount] of VALIDATION_BASE_COUNTS) {
        const actual = result.rules.find((rule) => rule.ruleId === ruleId)
        expect(actual, ruleId).toBeDefined()
        expect(actual?.failCount, ruleId).toBe(failCount)
        // failPercent equals the frozen formula over the pinned counts —
        // computed here independently of the CLI renderer.
        expect(failPercentByRule.get(ruleId), ruleId).toBe(failPercentFromCounts(failCount, 120))
      }
      // First-sample pins: row key (empty-anchor base grammar) + exact value.
      for (const [ruleId, rowKey, value] of VALIDATION_FIRST_SAMPLES) {
        const actual = result.rules.find((rule) => rule.ruleId === ruleId)
        const first = actual?.sampleFailures[0]
        expect(first, ruleId).toBeDefined()
        expect(first?.rowKey, ruleId).toBe(rowKey)
        expect(first?.value, ruleId).toEqual(value)
      }
      // The wire gate: every row key is the empty-anchor base grammar.
      for (const rule of result.rules) {
        for (const sample of rule.sampleFailures) {
          expect(sample.rowKey).toMatch(/^base:#\d+$/)
        }
      }

      // The spawned CLI's --format json reports the SAME per-rule numbers.
      const run = runCli([
        'validate',
        files.validation,
        '--contract',
        files.validationContract,
        '--format',
        'json',
      ])
      expect(run.exitCode).toBe(1)
      const payload = JSON.parse(run.stdout) as {
        valid: boolean
        datasetRows: number
        rules: { ruleId: string; failCount: number; failPercent: number; sampleValues: unknown[] }[]
      }
      expect(payload.valid).toBe(false)
      expect(payload.datasetRows).toBe(result.rowCount)
      for (const inProcess of result.rules) {
        const reported = payload.rules.find((rule) => rule.ruleId === inProcess.ruleId)
        expect(reported, inProcess.ruleId).toBeDefined()
        expect(reported?.failCount, inProcess.ruleId).toBe(inProcess.failCount)
        expect(reported?.failPercent, inProcess.ruleId).toBe(inProcess.failPercent)
        expect(reported?.sampleValues, inProcess.ruleId).toEqual(
          inProcess.sampleFailures.map((sample) => sample.value),
        )
      }
    } finally {
      try {
        conn.closeSync()
      } catch {
        // best-effort cleanup
      }
    }
  })

  it('two CLI runs are byte-identical (determinism)', () => {
    const args = [
      'validate',
      files.validation,
      '--contract',
      files.validationContract,
      '--format',
      'json',
    ]
    const first = runCli(args)
    const second = runCli(args)
    expect(first.exitCode).toBe(1)
    expect(second.stdout).toBe(first.stdout)
    expect(second.stderr).toBe(first.stderr)
  })
})
