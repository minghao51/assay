// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration tests for `assay pipeline validate|run` (p-4): every test
 * SPAWNS the COMPILED CLI (`node --import tsx dist/index.js …`, ADR 0042)
 * against temp-authored pipeline files plus the golden runnable fixture
 * `fixtures/pipeline/cli_run.yaml` (source paths resolve relative to the
 * pipeline file, so the fixture's `../csv/customers.csv` resolves inside the
 * repository). Outputs are BYTE-PINNED where they are path-free (the
 * renderers keep the CLI's own arguments out of stdout and quote only the
 * pipeline document's authored structure), so these pins are exact bytes.
 *
 * Exit classes pinned end-to-end:
 * - 0 — validate: DAG validates + plan compiles; run: every node
 *   materialized on the REAL Node engine (`@duckdb/node-api`) through the
 *   `./node` seam binding of the p-3 runner;
 * - 1 — validate: DAG/compile errors (the report IS the result); run: the
 *   same refusals, or a typed mid-run node failure (`PipelineRunError`);
 * - 2 — malformed IR (located, sanitized stderr), unreadable file,
 *   unresolvable sources (C2: disclosed, never guessed), bad usage.
 *
 * The run journey executes `SELECT … GROUP BY` over the registered CSV —
 * a real query-lane execution, not a mock — and pins the per-node row
 * counts (5 → 5 → 2 → 1) and the output relation listing.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = join(CLI_DIR, '..', '..')
const GOLDEN_PIPELINE = join(REPO_DIR, 'fixtures', 'pipeline', 'cli_run.yaml')
const GOLDEN_GATED = join(REPO_DIR, 'fixtures', 'pipeline', 'cli_gated.yaml')
const GOLDEN_GATED_PASS = join(REPO_DIR, 'fixtures', 'pipeline', 'cli_gated_pass.yaml')
const GOLDEN_DATASET = join(REPO_DIR, 'fixtures', 'csv', 'customers.csv')

/** The package's own version — the `--version` single source of truth (q-4). */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')) as { version: string }
).version

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

/**
 * True when the text carries a RAW C0 control byte other than the message's
 * own line separators (the sanitizer must have escaped every embedded control
 * character — tabs included). Written as a code-point scan, not a regex, so
 * the lint rule against control characters IN regexes stays clean while the
 * assertion stays exact.
 */
function hasRawControlByte(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x0a) continue // authored message line breaks
    if (
      (code >= 0x00 && code <= 0x08) ||
      (code >= 0x09 && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true
    }
  }
  return false
}

let dir: string
let files: Record<string, string>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'assay-p-4-'))
  const write = (name: string, text: string): string => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }
  files = {
    // DAG failure: a data input that names no declared node.
    dagError: write(
      'dag-error.yaml',
      `version: 1
pipeline: dag_error
nodes:
  a:
    type: sql
    inputs: [ghost]
    sql: SELECT 1
`,
    ),
    // Compile refusal: the reserved validate class (P2).
    compileRefusal: write(
      'compile-refusal.yaml',
      `version: 1
pipeline: compile_refusal
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./x.csv
  gate:
    type: validate
    input: a
    contract: contracts/x.yaml
`,
    ),
    malformed: write('malformed.yaml', 'version: 1\npipeline: broken\nnodes: [ unclosed\n'),
    // A source that resolves to a missing file (relative to the pipeline).
    missingSource: write(
      'missing-source.yaml',
      `version: 1
pipeline: missing_source
nodes:
  a:
    type: source
    source:
      kind: file
      path: ./datasets/missing.csv
`,
    ),
    badKind: write(
      'bad-kind.yaml',
      `version: 1
pipeline: bad_kind
nodes:
  a:
    type: source
    source:
      kind: warehouse
      path: ./x.csv
`,
    ),
    noPath: write(
      'no-path.yaml',
      `version: 1
pipeline: no_path
nodes:
  a:
    type: source
    source:
      kind: file
`,
    ),
    // Two broken sources at once: every failure is collected and disclosed.
    twoBrokenSources: write(
      'two-broken-sources.yaml',
      `version: 1
pipeline: two_broken
nodes:
  a_bad:
    type: source
    source:
      kind: warehouse
      path: ./x.csv
  z_missing:
    type: source
    source:
      kind: file
      path: ./datasets/missing.csv
`,
    ),
    // A runnable pipeline whose sql node fails at execution (unknown column):
    // a typed node failure after the run began. The source uses an ABSOLUTE
    // path (absolute paths pass through — documented rule).
    nodeFailure: write(
      'node-failure.yaml',
      `version: 1
pipeline: node_failure
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET).replaceAll('"', '')}
  broken:
    type: sql
    inputs: [a]
    sql: SELECT no_such_column FROM a
`,
    ),
    // p2-5 diff gate: source → filter(SG) → diff(sg against a). The keys are
    // supplied with --key (the IR carries none), never inferred (C2).
    diffPipeline: write(
      'diff-pipeline.yaml',
      `version: 1
pipeline: diff_pipeline
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET).replaceAll('"', '')}
  sg:
    type: transform
    inputs: [a]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
  compare:
    type: diff
    input: sg
    against: a
`,
    ),
    // p2-5 export-mode node (no consumers): the Node surface has no OPFS
    // export op, so the runner refuses it as a typed mode refusal.
    exportPipeline: write(
      'export-pipeline.yaml',
      `version: 1
pipeline: export_pipeline
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET).replaceAll('"', '')}
  exp:
    type: transform
    inputs: [a]
    materialization: export
    operation:
      rename:
        columns:
          customer_id: customer_ref
`,
    ),
    // p2-5: a validate node whose contract is unparseable YAML carrying a raw
    // control character — the disclosure must be sanitized at every surface.
    badContractFile: write(
      'bad-contract.yaml',
      'format: v1\nname: "bad\u001bname"\nversion: 1\ncolumns: [ { name: a\n',
    ),
    badContractPipeline: write(
      'bad-contract-pipeline.yaml',
      `version: 1
pipeline: bad_contract
nodes:
  a:
    type: source
    source:
      kind: file
      path: ${JSON.stringify(GOLDEN_DATASET).replaceAll('"', '')}
  gate:
    type: validate
    input: a
    contract: ./bad-contract.yaml
`,
    ),
  }
})

describe('pipeline validate — byte-pinned happy path (the golden fixture)', () => {
  it('human report: the DAG validates and the plan compiles — nothing executed (exit 0)', () => {
    const run = runCli(['pipeline', 'validate', GOLDEN_PIPELINE])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `pipeline: cli_run
nodes: 4
plan:
  1. customers — source — relation "customers" — view (file: ../csv/customers.csv)
  2. renamed — transform — relation "renamed" — view (op: rename)
  3. sg_only — transform — relation "sg_only" — view (op: filter)
  4. by_country — sql — relation "by_country" — view
verdict: VALID — the DAG validates and the plan compiles (nothing was executed)
`,
    )
  })

  it('json report: the pinned envelope (exit 0)', () => {
    const run = runCli(['pipeline', 'validate', GOLDEN_PIPELINE, '--format', 'json'])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `{
  "report": "assay-pipeline-validate-report",
  "reportVersion": "${PACKAGE_VERSION}",
  "pipeline": "cli_run",
  "nodeCount": 4,
  "valid": true,
  "order": [
    "customers",
    "renamed",
    "sg_only",
    "by_country"
  ],
  "nodes": [
    {
      "nodeId": "customers",
      "kind": "source",
      "relation": "customers",
      "sourceKind": "file",
      "sourcePath": "../csv/customers.csv",
      "operation": null,
      "materialization": "view"
    },
    {
      "nodeId": "renamed",
      "kind": "transform",
      "relation": "renamed",
      "sourceKind": null,
      "sourcePath": null,
      "operation": "rename",
      "materialization": "view"
    },
    {
      "nodeId": "sg_only",
      "kind": "transform",
      "relation": "sg_only",
      "sourceKind": null,
      "sourcePath": null,
      "operation": "filter",
      "materialization": "view"
    },
    {
      "nodeId": "by_country",
      "kind": "sql",
      "relation": "by_country",
      "sourceKind": null,
      "sourcePath": null,
      "operation": null,
      "materialization": "view"
    }
  ],
  "gates": [],
  "gateErrors": [],
  "errors": []
}
`,
    )
  })
})

describe('pipeline validate — exit 1 (the report is the result)', () => {
  it('DAG errors: located, one line each, empty stderr (exit 1)', () => {
    const run = runCli(['pipeline', 'validate', files.dagError ?? ''])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `pipeline: dag_error
nodes: 0
errors: 1
  nodes.a: nodes.a: data input "ghost" names no declared node
verdict: INVALID — 1 error
`,
    )
  })

  it('DAG errors in --format json: the pinned error envelope (exit 1)', () => {
    const run = runCli(['pipeline', 'validate', files.dagError ?? '', '--format', 'json'])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `{
  "report": "assay-pipeline-validate-report",
  "reportVersion": "${PACKAGE_VERSION}",
  "pipeline": "dag_error",
  "nodeCount": 0,
  "valid": false,
  "order": [],
  "nodes": [],
  "gates": [],
  "gateErrors": [],
  "errors": [
    {
      "code": "unresolved-reference",
      "message": "nodes.a: data input \\"ghost\\" names no declared node",
      "path": "nodes.a",
      "line": null,
      "column": null,
      "nodeId": "a"
    }
  ]
}
`,
    )
  })

  it('gate-visibility: a missing validate contract is disclosed as a would-fail (exit 1)', () => {
    const run = runCli(['pipeline', 'validate', files.compileRefusal ?? ''])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    // The data subgraph compiles; the gate binding is the would-fail. The
    // contract path resolves relative to the pipeline file, so the disclosed
    // location is machine-local — asserted by shape, not by exact path.
    expect(run.stdout).toContain('pipeline: compile_refusal')
    expect(run.stdout).toContain('2. gate — validate — relation "gate"')
    expect(run.stdout).toContain('gates:')
    expect(run.stdout).toContain('gate — validate — contract "contracts/x.yaml" (missing)')
    expect(run.stdout).toContain('gate errors: 1')
    expect(run.stdout).toContain('gate: contract file not found:')
    expect(run.stdout).toContain('verdict: INVALID — 1 error')
  })
})

describe('pipeline validate — exit 2 (malformed input, readable sanitized stderr)', () => {
  it('malformed YAML: located errors on stderr with control bytes escaped', () => {
    const run = runCli(['pipeline', 'validate', files.malformed ?? ''])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr.startsWith('pipeline could not be parsed:\nerror: document:')).toBe(true)
    expect(run.stderr).toContain('YAML syntax error')
    // The sanitizer boundary: the yaml library's raw excerpt (control
    // characters included) is escaped — no raw C0 byte reaches stderr.
    expect(hasRawControlByte(run.stderr)).toBe(false)
    expect(run.stderr).toContain('\\u000a')
  })

  it('an unreadable pipeline file echoes the path (the caller typed it)', () => {
    const run = runCli(['pipeline', 'validate', join(dir, 'no-such-pipeline.yaml')])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toBe(`pipeline file not readable: ${join(dir, 'no-such-pipeline.yaml')}\n`)
  })

  it('usage errors: no subcommand, unknown subcommand, missing/extra file', () => {
    const noSubcommand = runCli(['pipeline'])
    expect(noSubcommand.exitCode).toBe(2)
    expect(noSubcommand.stderr).toBe(
      'pipeline requires a subcommand: validate or run (see --help)\n',
    )

    const unknown = runCli(['pipeline', 'frobnicate', 'x.yaml'])
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr).toBe(
      "unknown pipeline subcommand 'frobnicate' (expected validate or run; see --help)\n",
    )

    const noFile = runCli(['pipeline', 'validate'])
    expect(noFile.exitCode).toBe(2)
    expect(noFile.stderr).toBe('pipeline validate requires a pipeline file path (see --help)\n')

    const extra = runCli(['pipeline', 'validate', 'a.yaml', 'b.yaml'])
    expect(extra.exitCode).toBe(2)
    expect(extra.stderr).toBe('pipeline validate takes exactly one pipeline file path (got 2)\n')
  })

  it('cross-command flags are rejected, not silently ignored (no --infer anything)', () => {
    const contract = runCli(['pipeline', 'validate', 'x.yaml', '--contract', 'c.yaml'])
    expect(contract.exitCode).toBe(2)
    expect(contract.stderr).toBe(
      'pipeline does not take --contract (did you mean `assay validate`? see --help)\n',
    )

    const infer = runCli(['pipeline', 'run', 'x.yaml', '--infer'])
    expect(infer.exitCode).toBe(2)
    expect(infer.stderr).toBe(
      'pipeline does not take --infer — a pipeline is executed exactly as authored (see --help)\n',
    )

    const limit = runCli(['pipeline', 'validate', 'x.yaml', '--sample-limit', '5'])
    expect(limit.exitCode).toBe(2)
    expect(limit.stderr).toBe('pipeline does not take --sample-limit (see --help)\n')

    const format = runCli(['pipeline', 'validate', 'x.yaml', '--format', 'xml'])
    expect(format.exitCode).toBe(2)
    expect(format.stderr).toBe("--format must be 'human' or 'json' (got 'xml')\n")
  })
})

describe('pipeline run — end-to-end on the golden fixture (the real Node engine)', () => {
  it('human report: per-node outcomes, the output relation, the session note (exit 0)', () => {
    const run = runCli(['pipeline', 'run', GOLDEN_PIPELINE])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `pipeline: cli_run
nodes: 4
run:
  1. customers — source — materialized — 5 rows
  2. renamed — transform — materialized — 5 rows
  3. sg_only — transform — materialized — 2 rows
  4. by_country — sql — materialized — 1 row
outputs (addressable relations):
  by_country — 1 row
note: relations live in this run's in-memory session and end when the process exits
verdict: COMPLETED — 4 of 4 nodes materialized
`,
    )
  })

  it('json report: the pinned envelope with per-node row counts and outputs (exit 0)', () => {
    const run = runCli(['pipeline', 'run', GOLDEN_PIPELINE, '--format', 'json'])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `{
  "report": "assay-pipeline-run-report",
  "reportVersion": "${PACKAGE_VERSION}",
  "pipeline": "cli_run",
  "sessionLifetime": "process",
  "nodeCount": 4,
  "status": "completed",
  "order": [
    "customers",
    "renamed",
    "sg_only",
    "by_country"
  ],
  "nodes": [
    {
      "nodeId": "customers",
      "kind": "source",
      "relation": "customers",
      "status": "materialized",
      "rowCount": 5,
      "materialization": "source",
      "gate": null
    },
    {
      "nodeId": "renamed",
      "kind": "transform",
      "relation": "renamed",
      "status": "materialized",
      "rowCount": 5,
      "materialization": "view",
      "gate": null
    },
    {
      "nodeId": "sg_only",
      "kind": "transform",
      "relation": "sg_only",
      "status": "materialized",
      "rowCount": 2,
      "materialization": "view",
      "gate": null
    },
    {
      "nodeId": "by_country",
      "kind": "sql",
      "relation": "by_country",
      "status": "materialized",
      "rowCount": 1,
      "materialization": "view",
      "gate": null
    }
  ],
  "outputs": [
    {
      "nodeId": "by_country",
      "relation": "by_country",
      "rowCount": 1
    }
  ],
  "failingNode": null,
  "nextNodeId": null,
  "gatedAt": null,
  "gate": null,
  "refusal": null,
  "refusalNode": null
}
`,
    )
  })
})

describe('pipeline run — exit 1 (refusals and typed node failures)', () => {
  it('a DAG/compile refusal on run reports the validate surface and exits 1 (nothing ran)', () => {
    const run = runCli(['pipeline', 'run', files.dagError ?? ''])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toContain('verdict: INVALID — 1 error')
    expect(run.stdout).toContain('nodes.a: data input "ghost" names no declared node')
  })

  it('a mid-run node failure: typed, node-attributed, partial state listed, empty stderr', () => {
    const run = runCli(['pipeline', 'run', files.nodeFailure ?? ''])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `pipeline: node_failure
nodes: 2
run:
  1. a — source — materialized
  2. broken — sql — FAILED
note: the failing node left no relation; earlier nodes left named relations in this run's in-memory session, which end when the process exits
verdict: FAILED — node "broken" could not be materialized
`,
    )
  })

  it('the failing run in --format json pins the failure envelope (exit 1)', () => {
    const run = runCli(['pipeline', 'run', files.nodeFailure ?? '', '--format', 'json'])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `{
  "report": "assay-pipeline-run-report",
  "reportVersion": "${PACKAGE_VERSION}",
  "pipeline": "node_failure",
  "sessionLifetime": "process",
  "nodeCount": 2,
  "status": "failed",
  "order": [
    "a",
    "broken"
  ],
  "nodes": [
    {
      "nodeId": "a",
      "kind": "source",
      "relation": "a",
      "status": "materialized",
      "rowCount": null,
      "materialization": "view",
      "gate": null
    },
    {
      "nodeId": "broken",
      "kind": "sql",
      "relation": "broken",
      "status": "failed",
      "rowCount": null,
      "materialization": "view",
      "gate": null
    }
  ],
  "outputs": [],
  "failingNode": "broken",
  "nextNodeId": null,
  "gatedAt": null,
  "gate": null,
  "refusal": null,
  "refusalNode": null
}
`,
    )
  })
})

describe('pipeline run — exit 2 (C2: sources disclosed and refused, never guessed)', () => {
  it('a missing dataset file is disclosed with the resolved path', () => {
    const run = runCli(['pipeline', 'run', files.missingSource ?? ''])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      `pipeline sources could not be resolved (nothing was executed):\n  a: dataset file not found: ${join(dir, 'datasets', 'missing.csv')}\n`,
    )
  })

  it('an unsupported source kind is refused — kinds are never guessed at', () => {
    const run = runCli(['pipeline', 'run', files.badKind ?? ''])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toBe(
      `pipeline sources could not be resolved (nothing was executed):\n  a: unsupported source kind 'warehouse' — this command resolves file sources only\n`,
    )
  })

  it('a source without a usable path is refused', () => {
    const run = runCli(['pipeline', 'run', files.noPath ?? ''])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toBe(
      'pipeline sources could not be resolved (nothing was executed):\n' +
        "  a: the source's path is missing or not a string — a file source declares path: <relative or absolute path>\n",
    )
  })

  it('ALL resolution failures are collected and disclosed at once, in node order', () => {
    const run = runCli(['pipeline', 'run', files.twoBrokenSources ?? ''])
    expect(run.exitCode).toBe(2)
    expect(run.stderr).toBe(
      'pipeline sources could not be resolved (nothing was executed):\n' +
        "  a_bad: unsupported source kind 'warehouse' — this command resolves file sources only\n" +
        `  z_missing: dataset file not found: ${join(dir, 'datasets', 'missing.csv')}\n`,
    )
  })
})

describe('pipeline validate — gate visibility (the golden gated fixture)', () => {
  it('human report lists the gate binding and is VALID (the contract resolves)', () => {
    const run = runCli(['pipeline', 'validate', GOLDEN_GATED])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `pipeline: cli_gated
nodes: 3
plan:
  1. customers — source — relation "customers" — view (file: ../csv/customers.csv)
  2. sg_only — transform — relation "sg_only" — view (op: filter)
  3. quality — validate — relation "quality"
gates:
  quality — validate — contract "contracts/sg_min_rows_fail.yaml" (resolved)
verdict: VALID — the DAG validates and the plan compiles (nothing was executed)
`,
    )
  })

  it('json report pins the gate-visibility envelope (exit 0)', () => {
    const run = runCli(['pipeline', 'validate', GOLDEN_GATED, '--format', 'json'])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `{
  "report": "assay-pipeline-validate-report",
  "reportVersion": "${PACKAGE_VERSION}",
  "pipeline": "cli_gated",
  "nodeCount": 3,
  "valid": true,
  "order": [
    "customers",
    "sg_only",
    "quality"
  ],
  "nodes": [
    {
      "nodeId": "customers",
      "kind": "source",
      "relation": "customers",
      "sourceKind": "file",
      "sourcePath": "../csv/customers.csv",
      "operation": null,
      "materialization": "view"
    },
    {
      "nodeId": "sg_only",
      "kind": "transform",
      "relation": "sg_only",
      "sourceKind": null,
      "sourcePath": null,
      "operation": "filter",
      "materialization": "view"
    },
    {
      "nodeId": "quality",
      "kind": "validate",
      "relation": "quality",
      "sourceKind": null,
      "sourcePath": null,
      "operation": null,
      "materialization": null
    }
  ],
  "gates": [
    {
      "nodeId": "quality",
      "kind": "validate",
      "input": "sg_only",
      "against": null,
      "contract": "contracts/sg_min_rows_fail.yaml",
      "contractStatus": "resolved",
      "requires": null,
      "bound": true
    }
  ],
  "gateErrors": [],
  "errors": []
}
`,
    )
  })
})

describe('pipeline run — the gated golden journey on the real Node engine', () => {
  it('a failing validate gate is a first-class gated result (exit 1, empty stderr)', () => {
    const run = runCli(['pipeline', 'run', GOLDEN_GATED])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `pipeline: cli_gated
nodes: 3
run:
  1. customers — source — materialized — 5 rows
  2. sg_only — transform — materialized — 2 rows
  3. quality — validate — GATED — 1 rule violated
note: the run stopped at the gate; later nodes were not run; relations already materialized live in this run's in-memory session, which end when the process exits
verdict: GATED — the run stopped at validation-failed gate "quality"
`,
    )
  })

  it('the gated run json envelope pins the verdict, the gate, and the partial state', () => {
    const run = runCli(['pipeline', 'run', GOLDEN_GATED, '--format', 'json'])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `{
  "report": "assay-pipeline-run-report",
  "reportVersion": "${PACKAGE_VERSION}",
  "pipeline": "cli_gated",
  "sessionLifetime": "process",
  "nodeCount": 3,
  "status": "gated",
  "order": [
    "customers",
    "sg_only",
    "quality"
  ],
  "nodes": [
    {
      "nodeId": "customers",
      "kind": "source",
      "relation": "customers",
      "status": "materialized",
      "rowCount": 5,
      "materialization": "source",
      "gate": null
    },
    {
      "nodeId": "sg_only",
      "kind": "transform",
      "relation": "sg_only",
      "status": "materialized",
      "rowCount": 2,
      "materialization": "view",
      "gate": null
    },
    {
      "nodeId": "quality",
      "kind": "validate",
      "relation": "sg_only",
      "status": "gated",
      "rowCount": 2,
      "materialization": "gate",
      "gate": {
        "class": "validate",
        "input": "sg_only",
        "against": null,
        "valid": false,
        "violatedRules": 1,
        "added": null,
        "removed": null,
        "changed": null,
        "blockedGates": null
      }
    }
  ],
  "outputs": [],
  "failingNode": null,
  "nextNodeId": null,
  "gatedAt": "quality",
  "gate": "validation-failed",
  "refusal": null,
  "refusalNode": null
}
`,
    )
  })

  it('the passing variant completes (the gated-then-passing pair)', () => {
    const run = runCli(['pipeline', 'run', GOLDEN_GATED_PASS])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `pipeline: cli_gated_pass
nodes: 3
run:
  1. customers — source — materialized — 5 rows
  2. sg_only — transform — materialized — 2 rows
  3. quality — validate — passed
outputs (addressable relations):
  sg_only — 2 rows
note: relations live in this run's in-memory session and end when the process exits
verdict: COMPLETED — 3 of 3 nodes materialized
`,
    )
  })
})

describe('pipeline run — diff gates and materialization-mode refusals (p2-5)', () => {
  it('a diff node runs with an explicit --key set and surfaces value-free counts', () => {
    const run = runCli(['pipeline', 'run', files.diffPipeline ?? '', '--key', 'customer_id'])
    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toContain('3. compare — diff — passed — added 3, removed 0, changed 0')
    expect(run.stdout).toContain('outputs (addressable relations):')
    expect(run.stdout).toContain('  sg — 2 rows')
    expect(run.stdout).toContain('verdict: COMPLETED — 3 of 3 nodes materialized')
  })

  it('a diff node without an explicit key set is disclosed and refused (exit 2)', () => {
    const run = runCli(['pipeline', 'run', files.diffPipeline ?? ''])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe(
      'pipeline gates could not be resolved (nothing was executed):\n' +
        '  compare: a diff node requires an explicit key set (--key <column>); keys are never inferred\n',
    )
  })

  it('an export-mode node is a typed mode refusal, never an internal error', () => {
    const run = runCli(['pipeline', 'run', files.exportPipeline ?? ''])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe(
      `pipeline: export_pipeline
nodes: 0
verdict: REFUSED — the pipeline declares a materialization mode this surface cannot execute (export/publish); nothing was executed
`,
    )

    const json = runCli(['pipeline', 'run', files.exportPipeline ?? '', '--format', 'json'])
    expect(json.exitCode).toBe(1)
    expect(json.stderr).toBe('')
    expect(json.stdout).toContain('"status": "refused"')
    expect(json.stdout).toContain('"refusal": "unsupported-materialization"')
    expect(json.stdout).toContain('"refusalNode": "exp"')
  })

  it('a validate contract parse failure is sanitized on stderr (no raw control bytes)', () => {
    const run = runCli(['pipeline', 'run', files.badContractPipeline ?? ''])
    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('pipeline gates could not be resolved (nothing was executed):')
    expect(run.stderr).toContain('gate: contract could not be parsed:')
    expect(hasRawControlByte(run.stderr)).toBe(false)
  })
})

describe('pipeline — determinism and help', () => {
  it('two validate runs are byte-identical (json)', () => {
    const args = ['pipeline', 'validate', GOLDEN_PIPELINE, '--format', 'json']
    const first = runCli(args)
    const second = runCli(args)
    expect(first.exitCode).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(second.stderr).toBe(first.stderr)
  })

  it('two run executions are byte-identical (human)', () => {
    const args = ['pipeline', 'run', GOLDEN_PIPELINE]
    const first = runCli(args)
    const second = runCli(args)
    expect(first.exitCode).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(second.stderr).toBe(first.stderr)
  })

  it('--help advertises the pipeline command, its options, and its exit codes', () => {
    const run = runCli(['--help'])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain('  assay pipeline validate <file> [options]')
    expect(run.stdout).toContain('  assay pipeline run <file> [options]')
    expect(run.stdout).toContain(
      '  pipeline          validate or run an Assay pipeline IR file (YAML):',
    )
    expect(run.stdout).toContain('pipeline options:')
    expect(run.stdout).toContain('--key <column>')
    expect(run.stdout).toContain('disclosed and refused — never guessed')
    expect(run.stdout).toContain(
      'pipeline exit codes: validate — 0 valid (would run), 1 DAG/data-compile',
    )
  })
})
