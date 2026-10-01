/**
 * Browser harness for the M1-4 e2e proof (tests/e2e/engine-duckdb.spec.ts).
 * The M1-2 sections keep proving lazy boot + first Arrow batch; the M1-4
 * section proves the file lifecycle:
 *
 *   open (OPFS-staged genuine FileSystemFileHandle, same trick as the
 *   data-sources harness — a real handle without any native dialog, ADR 0017
 *   disposable-cache framing) → schema() (DuckDB type strings as-is) →
 *   fetchRange() first window incl. a NULL, a middle window (offset
 *   correctness), failed-query-then-reuse, and nested type-string passthrough.
 *
 * Everything renders through the Arrow API / plain protocol fields. Privacy
 * (ADR 0001/0025): no file names are rendered anywhere in this UI — buttons
 * say "fixture", results show table ids, formats, types, and values only.
 * Not a shipped surface — it exists only in this package's `vite build`.
 */
import {
  engineConformanceScenarioNames,
  pipelineRunnerConformanceScenarioNames,
  runEngineConformanceScenarios,
  runPipelineRunnerConformanceScenarios,
} from '@assay/testing'
import { DuckDbEngineClient, quotedIdentifier } from '../src/index'
import type {
  EngineFileSource,
  EngineQueryResult,
  EngineRangeWindow,
  EngineTableHandle,
  PipelineRunCompilers,
} from '../src/index'
import { compileContract } from '@assay/validation'
import type { ContractV1 } from '@assay/contracts'
import type { PipelineV1 } from '@assay/pipeline'
import type { EditOp, RowId } from '@assay/domain'
import { createDuckDbConformanceSubject } from './conformance-subject'
import { createPipelineRunnerSubject } from './pipeline-runner-subject'
import {
  VALIDATION_BASE,
  VALIDATION_FIX_ALL_OPS,
  VALIDATION_SAMPLE_LIMIT,
  buildValidationJsonl,
  compileValidationPlan,
} from './validation-dataset'

const client = new DuckDbEngineClient()

const statusEl = requiredElement<HTMLElement>('[data-testid="engine-status"]')
const runSmokeButton = requiredElement<HTMLButtonElement>('#run-smoke-query')
const runRangeButton = requiredElement<HTMLButtonElement>('#run-range-query')
const openFlatButton = requiredElement<HTMLButtonElement>('#open-flat')
const schemaFlatButton = requiredElement<HTMLButtonElement>('#schema-flat')
const rangeFirstButton = requiredElement<HTMLButtonElement>('#range-first')
const rangeMiddleButton = requiredElement<HTMLButtonElement>('#range-middle')
const errorReuseButton = requiredElement<HTMLButtonElement>('#error-then-reuse')
const openNestedButton = requiredElement<HTMLButtonElement>('#open-nested')
const schemaNestedButton = requiredElement<HTMLButtonElement>('#schema-nested')

runSmokeButton.addEventListener('click', () => {
  void runSmokeQuery()
})
runRangeButton.addEventListener('click', () => {
  void runRangeQuery()
})
openFlatButton.addEventListener('click', () => {
  void openFixture('/fixtures/customers.parquet', 'flat.parquet', 'flat')
})
openNestedButton.addEventListener('click', () => {
  void openFixture('/fixtures/nested.parquet', 'nested.parquet', 'nested')
})
schemaFlatButton.addEventListener('click', () => {
  void readSchema('flat')
})
schemaNestedButton.addEventListener('click', () => {
  void readSchema('nested')
})
rangeFirstButton.addEventListener('click', () => {
  void runRangeWindow('first', 0, 5)
})
rangeMiddleButton.addEventListener('click', () => {
  void runRangeWindow('middle', 2, 4)
})
errorReuseButton.addEventListener('click', () => {
  void runFailedQueryThenReuse()
})
requiredElement<HTMLButtonElement>('#run-parallel-calls').addEventListener('click', () => {
  void runParallelCalls()
})

// ── m2-2 filtered/sorted windows (tests/e2e/engine-filtered-windows.spec.ts) ──
//
// Drives the REAL client against the opened flat fixture: filtered window,
// sorted window (DuckDB's NULL-last default), filter+sort combined, the
// filtered rowCount, and the invalid-predicate error path with reuse.
// Predicates are engine-SQL text (grid contracts v1); results render through
// the Arrow API as JSON — ids/counts/values only, never a file name.

interface FilteredWindowEvidence {
  rows?: number
  customerIds?: (string | null)[]
  incomes?: (string | null)[]
  hasMore?: boolean
  error?: string
  rowCount?: number
  rejected?: boolean
  rowCountAfterReuse?: number
  fatal?: string
}

/** NULL-preserving rendered values of one named column, via the Arrow API. */
function evidenceColumn(result: EngineQueryResult, columnName: string): (string | null)[] {
  const index = result.batch.schema.fields.findIndex((field) => field.name === columnName)
  const column = index >= 0 ? result.batch.getChildAt(index) : null
  if (column === null) throw new Error(`window result is missing column ${columnName}`)
  const values: (string | null)[] = []
  for (let row = 0; row < column.length; row++) {
    const value: unknown = column.get(row)
    values.push(value === null || value === undefined ? null : String(value))
  }
  return values
}

async function evidenceFilteredWindow(kind: 'filtered' | 'sorted' | 'filterSort'): Promise<void> {
  const evidence: FilteredWindowEvidence = {}
  try {
    const table = handles.get('flat')
    if (table === undefined) throw new Error('open the flat fixture first')
    const window: EngineRangeWindow =
      kind === 'filtered'
        ? { startRow: 0, endRow: 1000, filters: [{ column: 'income', predicate: '> 50000' }] }
        : kind === 'sorted'
          ? { startRow: 0, endRow: 1000, sort: [{ column: 'income', direction: 'desc' }] }
          : {
              startRow: 0,
              endRow: 1000,
              filters: [{ column: 'country', predicate: "= 'US'" }],
              sort: [{ column: 'income', direction: 'desc' }],
            }
    const result = await client.fetchRange(table, window)
    evidence.rows = result.batch.numRows
    evidence.hasMore = result.hasMore
    evidence.customerIds = evidenceColumn(result, 'customer_id')
    evidence.incomes = evidenceColumn(result, 'income')
  } catch (error) {
    evidence.error = errorMessage(error)
  }
  setText(
    `${kind === 'filtered' ? 'filtered' : kind === 'sorted' ? 'sorted' : 'filter-sort'}-window-result`,
    JSON.stringify(evidence),
  )
}

async function evidenceFilteredRowCount(): Promise<void> {
  try {
    const table = handles.get('flat')
    if (table === undefined) throw new Error('open the flat fixture first')
    const rowCount = await client.rowCount(table, {
      filters: [{ column: 'income', predicate: '> 50000' }],
    })
    setText('filtered-row-count-result', String(rowCount))
  } catch (error) {
    setText('filtered-row-count-result', `error: ${errorMessage(error)}`)
  }
}

async function evidencePredicateErrorThenReuse(): Promise<void> {
  const evidence: FilteredWindowEvidence = {}
  try {
    const table = handles.get('flat')
    if (table === undefined) throw new Error('open the flat fixture first')
    try {
      await client.fetchRange(table, {
        startRow: 0,
        endRow: 1000,
        filters: [{ column: 'income', predicate: ')) FROM ( (' }],
      })
      evidence.rejected = false
    } catch (error) {
      evidence.rejected = true
      evidence.error = errorMessage(error)
    }
    // The engine must still answer the benign filtered count afterwards.
    evidence.rowCountAfterReuse = await client.rowCount(table, {
      filters: [{ column: 'income', predicate: '> 50000' }],
    })
    statusEl.textContent = client.status
  } catch (error) {
    evidence.fatal = errorMessage(error)
  }
  setText('predicate-error-result', JSON.stringify(evidence))
}

requiredElement<HTMLButtonElement>('#filtered-window').addEventListener('click', () => {
  void evidenceFilteredWindow('filtered')
})
requiredElement<HTMLButtonElement>('#sorted-window').addEventListener('click', () => {
  void evidenceFilteredWindow('sorted')
})
requiredElement<HTMLButtonElement>('#filter-sort-window').addEventListener('click', () => {
  void evidenceFilteredWindow('filterSort')
})
requiredElement<HTMLButtonElement>('#filtered-row-count').addEventListener('click', () => {
  void evidenceFilteredRowCount()
})
requiredElement<HTMLButtonElement>('#predicate-error-reuse').addEventListener('click', () => {
  void evidencePredicateErrorThenReuse()
})

// ── m2-5 dataset profiling (tests/e2e/engine-profile.spec.ts) ───────────────
//
// Drives the REAL client's profile() against the opened fixtures: the flat
// fixture (numeric stats, categorical top-k incl. the SG/US count tie, a
// NULL income, DATE-as-categorical), the nested fixture (STRUCT degrades to
// kind 'other' with no payloads), and the unknown-handle error path with
// reuse. Results render as JSON — kinds/counts/stats only, never a file name.

interface ProfileEvidence {
  rowCount?: number
  columns?: readonly unknown[]
  error?: string
  rejected?: boolean
  rowCountAfterReuse?: number
  fatal?: string
}

async function evidenceProfile(key: 'flat' | 'nested'): Promise<void> {
  const evidence: ProfileEvidence = {}
  try {
    const table = handles.get(key)
    if (table === undefined) throw new Error(`open the ${key} fixture first`)
    const profile = await client.profile(table)
    evidence.rowCount = profile.rowCount
    evidence.columns = profile.columns
  } catch (error) {
    evidence.error = errorMessage(error)
  }
  setText(`profile-${key}-result`, JSON.stringify(evidence))
}

async function evidenceProfileUnknownHandleThenReuse(): Promise<void> {
  const evidence: ProfileEvidence = {}
  try {
    const table = handles.get('flat')
    if (table === undefined) throw new Error('open the flat fixture first')
    try {
      await client.profile({ kind: 'table', id: 'assay-no-such-table' })
      evidence.rejected = false
    } catch (error) {
      evidence.rejected = true
      evidence.error = errorMessage(error)
    }
    // The engine must still answer a real profile afterwards (reuse).
    evidence.rowCountAfterReuse = (await client.profile(table)).rowCount
    statusEl.textContent = client.status
  } catch (error) {
    evidence.fatal = errorMessage(error)
  }
  setText('profile-error-reuse-result', JSON.stringify(evidence))
}

requiredElement<HTMLButtonElement>('#profile-flat').addEventListener('click', () => {
  void evidenceProfile('flat')
})
requiredElement<HTMLButtonElement>('#profile-nested').addEventListener('click', () => {
  void evidenceProfile('nested')
})
requiredElement<HTMLButtonElement>('#profile-error-reuse').addEventListener('click', () => {
  void evidenceProfileUnknownHandleThenReuse()
})

// ── T2 worker-side serialization (tests/e2e/engine-parallel.spec.ts) ───────
//
// Fires four operations CONCURRENTLY against the opened flat fixture — a
// query, a fetchRange window, a rowCount, and a deliberately failing query —
// then disposes last. The worker serializes them through the single
// pending-query channel, so every settlement must be correct: the three
// successful ops return their own results (no cross-contamination from the
// failing op), the failing op rejects with its own error, and dispose
// completes gracefully afterwards. Renders each settlement as JSON in
// `parallel-result`; privacy as above (ids/counts only, no file names).
interface ParallelSettlements {
  queryValue?: string
  queryError?: string
  rangeRows?: number
  rangeFirstValue?: string
  rangeError?: string
  rowCount?: number
  rowCountError?: string
  failingRejected?: boolean
  failingMessage?: string
  disposed?: boolean
  fatal?: string
}

async function runParallelCalls(): Promise<void> {
  const settlements: ParallelSettlements = {}
  try {
    const table = handles.get('flat')
    if (table === undefined) throw new Error('parallel: open the flat fixture first')
    const [query, range, count, failing] = await Promise.allSettled([
      client.query('SELECT 42 AS answer'),
      client.fetchRange(table, { startRow: 0, endRow: 5 }),
      client.rowCount(table),
      client.query('SELECT * FROM __assay_no_such_table__'),
    ])
    if (query.status === 'fulfilled') {
      settlements.queryValue = String(query.value.batch.getChildAt(0)?.get(0))
    } else {
      settlements.queryError = errorMessage(query.reason)
    }
    if (range.status === 'fulfilled') {
      settlements.rangeRows = range.value.batch.numRows
      settlements.rangeFirstValue = String(range.value.batch.getChildAt(0)?.get(0))
    } else {
      settlements.rangeError = errorMessage(range.reason)
    }
    if (count.status === 'fulfilled') {
      settlements.rowCount = count.value
    } else {
      settlements.rowCountError = errorMessage(count.reason)
    }
    settlements.failingRejected = failing.status === 'rejected'
    if (failing.status === 'rejected') {
      settlements.failingMessage = errorMessage(failing.reason)
    }
    // Dispose last: graceful shutdown after every concurrent op settled.
    await client.dispose()
    settlements.disposed = true
    statusEl.textContent = client.status
  } catch (error) {
    settlements.fatal = errorMessage(error)
  }
  setText('parallel-result', JSON.stringify(settlements))
}

// ── m2-7 head-of-line measurement (tests/e2e/engine-head-of-line.spec.ts) ──
//
// Quantifies the single-lane head-of-line cost: the interactive ops
// (fetchRange / rowCount / schema — the grid's scroll traffic) fired while a
// long user `query()` runs, measured against their idle-engine baseline.
// Per repeat: baseline timings first (engine idle), then the long query
// starts, a short delay guarantees it owns the lane head, then the three
// interactive ops fire CONCURRENTLY and their fire→settle waits are
// recorded, then the long query's start→settle duration. The per-repeat
// settle order is architecture evidence: under one shared FIFO the queued
// ops cannot settle before the query; with a dedicated second connection
// they can. Magnitude: the m2-4-calibrated ~2.8 s 400M-pair aggregate (mvp
// bundle; native DuckDB answers in ~0.3 s) — reliably in the 2–5 s band the
// task calls for. Privacy (ADR 0001/0025): timings, counts, and ids only.
const HEAD_OF_LINE_SQL =
  'SELECT sum(a.i * b.i) AS s FROM range(20000) AS a(i), range(20000) AS b(i)'
const HEAD_OF_LINE_REPEATS = 5
const HEAD_OF_LINE_HEAD_START_MS = 100

interface HeadOfLineRepeat {
  /** Idle-engine baselines: the same ops, unqueued. */
  baselineRangeMs: number
  baselineCountMs: number
  baselineSchemaMs: number
  /** fire→settle waits while the long query owns the lane head. */
  queuedRangeMs: number
  queuedCountMs: number
  queuedSchemaMs: number
  /** Correctness anchor: the burst window is the real 5-row fixture window. */
  queuedRangeRows: number
  /** The long query's start→settle duration. */
  longQueryMs: number
  /** Op names in settlement order (architecture evidence). */
  settleOrder: string[]
  error?: string
}

interface HeadOfLineEvidence {
  repeats: HeadOfLineRepeat[]
  fatal?: string
}

async function runHeadOfLineMeasurement(): Promise<void> {
  const evidence: HeadOfLineEvidence = { repeats: [] }
  try {
    const table = handles.get('flat')
    if (table === undefined) throw new Error('head-of-line: open the flat fixture first')
    for (let repeat = 0; repeat < HEAD_OF_LINE_REPEATS; repeat++) {
      try {
        evidence.repeats.push(await measureHeadOfLineRepeat(table))
      } catch (error) {
        evidence.repeats.push({ error: errorMessage(error) } as HeadOfLineRepeat)
      }
    }
  } catch (error) {
    evidence.fatal = errorMessage(error)
  }
  setText('head-of-line-result', JSON.stringify(evidence))
}

async function measureHeadOfLineRepeat(table: EngineTableHandle): Promise<HeadOfLineRepeat> {
  const repeat: HeadOfLineRepeat = {
    baselineRangeMs: 0,
    baselineCountMs: 0,
    baselineSchemaMs: 0,
    queuedRangeMs: 0,
    queuedCountMs: 0,
    queuedSchemaMs: 0,
    queuedRangeRows: 0,
    longQueryMs: 0,
    settleOrder: [],
  }
  // Idle baselines: the same ops with nothing else in flight.
  let startedAt = performance.now()
  await client.fetchRange(table, { startRow: 0, endRow: 5 })
  repeat.baselineRangeMs = benchMs(startedAt)
  startedAt = performance.now()
  await client.rowCount(table)
  repeat.baselineCountMs = benchMs(startedAt)
  startedAt = performance.now()
  await client.schema(table)
  repeat.baselineSchemaMs = benchMs(startedAt)

  // The long query takes the lane. Its settle-order probe attaches FIRST so
  // settlement order maps to push order; its failure would be a broken
  // engine, not a measurement mode — the await below propagates it.
  const order = repeat.settleOrder
  const longStartedAt = performance.now()
  const longQuery = client.query(HEAD_OF_LINE_SQL)
  void longQuery.then(
    () => {
      repeat.longQueryMs = benchMs(longStartedAt)
      order.push('query')
    },
    () => {
      repeat.longQueryMs = benchMs(longStartedAt)
      order.push('query')
    },
  )

  // Guarantee the query owns the lane head before the burst arrives.
  await new Promise((resolve) => setTimeout(resolve, HEAD_OF_LINE_HEAD_START_MS))

  // The interactive burst, all waits fire→settle.
  const burstStartedAt = performance.now()
  const rangePromise = client.fetchRange(table, { startRow: 0, endRow: 5 }).then((result) => {
    repeat.queuedRangeMs = benchMs(burstStartedAt)
    repeat.queuedRangeRows = result.batch.numRows
    order.push('range')
  })
  const countPromise = client.rowCount(table).then(() => {
    repeat.queuedCountMs = benchMs(burstStartedAt)
    order.push('count')
  })
  const schemaPromise = client.schema(table).then(() => {
    repeat.queuedSchemaMs = benchMs(burstStartedAt)
    order.push('schema')
  })
  await Promise.all([rangePromise, countPromise, schemaPromise])
  await longQuery.catch(() => undefined)
  return repeat
}

requiredElement<HTMLButtonElement>('#run-head-of-line').addEventListener('click', () => {
  void runHeadOfLineMeasurement()
})

// ── T1 engine conformance suite (tests/e2e/engine-conformance.spec.ts) ──────
//
// Each button runs ONE scenario from the shared suite in @assay/testing
// against a fresh DuckDbEngineClient (fresh worker). Results render as JSON
// (`ConformanceScenarioResult`); the spec asserts each scenario's `passed`,
// `detail`, and scenario-specific `facts`. The suite — not this harness —
// owns the scenario logic; this wiring only hosts the DuckDB subject adapter.

const conformanceSubject = createDuckDbConformanceSubject({
  goodFixtureUrl: '/fixtures/customers.parquet',
  nestedFixtureUrl: '/fixtures/nested.jsonl',
})

async function runConformanceScenario(
  name: (typeof engineConformanceScenarioNames)[number],
): Promise<void> {
  const report = await runEngineConformanceScenarios(conformanceSubject, [name])
  const result = report.results[0]
  if (result !== undefined) {
    setText(`conformance-result-${name}`, JSON.stringify(result, null, 2))
  }
}

async function runAllConformanceScenarios(): Promise<void> {
  const report = await runEngineConformanceScenarios(conformanceSubject)
  setText('conformance-run-all', JSON.stringify(report, null, 2))
}

for (const name of engineConformanceScenarioNames) {
  requiredElement<HTMLButtonElement>(`#conformance-${name}`).addEventListener('click', () => {
    void runConformanceScenario(name)
  })
}
requiredElement<HTMLButtonElement>('#conformance-run-all').addEventListener('click', () => {
  void runAllConformanceScenarios()
})

// ── m5-2 validation journey (tests/e2e/validation-journey.spec.ts) ──────────
//
// Open the on-demand dirty dataset (runtime-built JSONL, never committed),
// compile the contract with the real m5-1 compiler against the engine's own
// schema, then validate three times over the SAME plan: the plain base view,
// a one-edit overlay, and a fix-everything overlay. The per-step JSON proves
// the edit→re-validate→verdict-flip journey the m5-3 panel builds on.
// Privacy (ADR 0001/0025): rule ids, counts, and row counts only — sample
// values stay out of the evidence entirely.

interface ValidationStepEvidence {
  step: string
  valid?: boolean
  rowCount?: number
  failingRules?: number
  changedFromPrevious?: string[]
  error?: string
}

/** ruleId → "failCount/failPercent" summary (counts only, never values). */
function summarizeRules(result: {
  valid: boolean
  rowCount: number
  rules: readonly { ruleId: string; failCount: number; failPercent: number }[]
}): { valid: boolean; rowCount: number; failingRules: number; rules: Record<string, string> } {
  const rules: Record<string, string> = {}
  let failingRules = 0
  for (const rule of result.rules) {
    rules[rule.ruleId] = `${String(rule.failCount)}/${String(rule.failPercent)}`
    if (rule.failCount > 0) failingRules += 1
  }
  return { valid: result.valid, rowCount: result.rowCount, failingRules, rules }
}

async function runValidationJourney(): Promise<void> {
  const evidence: ValidationStepEvidence[] = []
  try {
    // Stage the runtime-built dirty dataset and open it through the engine.
    const bytes = buildValidationJsonl()
    const root = await navigator.storage.getDirectory()
    const fileHandle = await root.getFileHandle('assay-journey-validation.jsonl', {
      create: true,
    })
    const writable = await fileHandle.createWritable()
    const chunk = new Uint8Array(bytes.byteLength)
    chunk.set(bytes)
    await writable.write(chunk)
    await writable.close()
    const table: EngineTableHandle = await client.open(fileHandle)

    // The plan is the real compiler's output for the engine's own schema.
    const schema = await client.schema(table)
    const plan = compileValidationPlan(schema, VALIDATION_SAMPLE_LIMIT)
    const overlayOf = (
      ops: readonly EditOp[],
    ): { base: typeof VALIDATION_BASE; ops: readonly EditOp[] } => ({
      base: VALIDATION_BASE,
      ops,
    })

    // Step 1: the plain base view.
    const base = summarizeRules(await client.validate(table, plan))
    evidence.push({ step: 'base', ...base })

    // Step 2: one edit fixes one violation (region #4 XX -> SG).
    const fixOne = summarizeRules(
      await client.validate(
        table,
        plan,
        overlayOf([
          {
            kind: 'cell-set',
            rowId: 'base:val-anchor-v1#4' as RowId,
            column: 'region',
            value: { kind: 'string', value: 'SG' },
          },
        ]),
      ),
    )
    evidence.push({
      step: 'fix-one',
      ...fixOne,
      changedFromPrevious: Object.keys(fixOne.rules).filter(
        (ruleId) => (fixOne.rules[ruleId] ?? '') !== (base.rules[ruleId] ?? ''),
      ),
    })

    // Step 3: fix every violating cell — the verdict flips to valid.
    const fixAll = summarizeRules(
      await client.validate(table, plan, overlayOf(VALIDATION_FIX_ALL_OPS)),
    )
    evidence.push({
      step: 'fix-all',
      ...fixAll,
      changedFromPrevious: Object.keys(fixAll.rules).filter(
        (ruleId) => (fixAll.rules[ruleId] ?? '') !== (fixOne.rules[ruleId] ?? ''),
      ),
    })
  } catch (error) {
    evidence.push({ step: 'error', error: errorMessage(error) })
  }
  statusEl.textContent = client.status
  setText('validate-journey-result', JSON.stringify(evidence))
}

requiredElement<HTMLButtonElement>('#validate-journey').addEventListener('click', () => {
  void runValidationJourney()
})

// ── p-3 pipeline runner (tests/e2e/pipeline-runner-journey.spec.ts) ──────────
//
// Two pieces of evidence against the REAL engine:
//
// 1. The journey: ONE explicit user-triggered `client.runPipeline` of a
//    3-node pipeline (source → transform filter → sql projection). The
//    OPFS-staged fixture is registered as the source relation through the
//    engine's registration path, each compiled node materializes as a named
//    view in topological order (CREATE OR REPLACE VIEW), and the final
//    relation's rows are read back through the query lane. A second
//    identical run proves idempotency: the relations are recreated, never
//    appended (ADR 0032 discipline).
// 2. The pipeline-runner conformance suite from @assay/testing, hosted by
//    `pipeline-runner-subject.ts` — the suite's scenarios (success, mid-DAG
//    failure, cancel, refusals, relation handle, validate pass/gated, publish
//    gate, diff node, table/export materialization, mode refusals), each on
//    its own fresh client.
//
// Privacy (ADR 0001/0025): evidence is node ids, relations, and counts —
// plus the synthetic fixture's id column the journey explicitly reads back;
// no file names anywhere.
interface PipelineJourneyNodeEvidence {
  nodeId: string
  relation: string
  rowCount: number
}

interface PipelineJourneyEvidence {
  status?: string
  nodes?: PipelineJourneyNodeEvidence[]
  finalRows?: string[]
  reRunStatus?: string
  reRunRowCounts?: number[]
  reRunFinalRows?: string[]
  error?: string
}

const PIPELINE_JOURNEY_PIPELINE: PipelineV1 = {
  version: 1,
  pipeline: 'harness-journey',
  nodes: [
    { id: 'customers', type: 'source', source: { kind: 'file' } },
    {
      id: 'sg',
      type: 'transform',
      inputs: ['customers'],
      operation: {
        operation: 'filter',
        args: { predicates: [{ column: 'country', operator: 'equals', value: 'SG' }] },
      },
    },
    {
      id: 'out',
      type: 'sql',
      inputs: ['sg'],
      sql: 'SELECT customer_id FROM sg ORDER BY customer_id',
    },
  ],
}

/** One relation column as rendered text (the Arrow API, NULLs as null). */
async function readPipelineJourneyColumn(relation: string, column: string): Promise<string[]> {
  const result = await client.query(
    `SELECT CAST(${quotedIdentifier(column)} AS VARCHAR) AS "value" FROM ${quotedIdentifier(relation)}`,
  )
  const vector = result.batch.getChildAt(0)
  const values: string[] = []
  if (vector === null) return values
  for (let row = 0; row < vector.length; row++) {
    const value: unknown = vector.get(row)
    values.push(value === null || value === undefined ? 'null' : String(value))
  }
  return values
}

async function runPipelineJourney(): Promise<void> {
  const evidence: PipelineJourneyEvidence = {}
  try {
    const handle = await stageFixtureInOpfs(
      '/fixtures/customers.parquet',
      'assay-pipeline-journey.parquet',
    )
    const sources = [{ nodeId: 'customers', source: handle }]
    const first = await client.runPipeline(PIPELINE_JOURNEY_PIPELINE, { sources })
    evidence.status = first.status
    evidence.nodes = first.nodes.map((node) => ({
      nodeId: node.nodeId,
      relation: node.relation,
      rowCount: node.rowCount,
    }))
    evidence.finalRows = await readPipelineJourneyColumn('out', 'customer_id')
    // Idempotent re-run: same relations recreated, same rows — never appended.
    const second = await client.runPipeline(PIPELINE_JOURNEY_PIPELINE, { sources })
    evidence.reRunStatus = second.status
    evidence.reRunRowCounts = second.nodes.map((node) => node.rowCount)
    evidence.reRunFinalRows = await readPipelineJourneyColumn('out', 'customer_id')
    statusEl.textContent = client.status
  } catch (error) {
    evidence.error = errorMessage(error)
  }
  setText('pipeline-journey-result', JSON.stringify(evidence))
}

requiredElement<HTMLButtonElement>('#pipeline-journey').addEventListener('click', () => {
  void runPipelineJourney()
})

// ── p2-4 gate journey (tests/e2e/pipeline-gate-journey.spec.ts) ──────────────
//
// One explicit gated pipeline on the real engine: the OPFS-staged fixture is
// registered, the SG filter materializes, and the validate node runs the M5
// machinery with a FAILING contract (a NULL income on row 3) — the publish
// that requires the validate is `gated` (`publish-blocked`), the failed
// verdict and the named partial state are visible, and the publish gate does
// not pass. Re-running with a PASSING contract completes and the publish
// gate passes (re-run-after-fix). Evidence is value-free: ids, relations,
// counts, and the gate verdicts only.
const PIPELINE_GATE_JOURNEY: PipelineV1 = {
  version: 1,
  pipeline: 'harness-gate-journey',
  nodes: [
    { id: 'customers', type: 'source', source: { kind: 'file' } },
    {
      id: 'sg',
      type: 'transform',
      inputs: ['customers'],
      operation: {
        operation: 'filter',
        args: { predicates: [{ column: 'country', operator: 'equals', value: 'SG' }] },
      },
    },
    { id: 'gate', type: 'validate', input: 'sg', contract: 'contracts/gate.yaml' },
    { id: 'out', type: 'publish', input: 'sg', requires: ['gate'] },
  ],
}

const GATE_PASS_CONTRACT: ContractV1 = {
  format: 'v1',
  metadata: { name: 'harness-gate-pass', version: 1 },
  columns: [{ name: 'customer_id', required: true, unique: true }],
}
const GATE_FAIL_CONTRACT: ContractV1 = {
  format: 'v1',
  metadata: { name: 'harness-gate-fail', version: 1 },
  columns: [{ name: 'income', required: true }],
}

/** The M5 contract compiler the host supplies (the engine stays pure). */
const GATE_JOURNEY_COMPILERS: PipelineRunCompilers = {
  validate: (input) => {
    const compiled = compileContract(input.contract as ContractV1, [...input.columns], {
      relation: input.relation,
    })
    return compiled.ok ? { ok: true, plan: compiled.plan } : { ok: false }
  },
}

interface PipelineGateJourneyEvidence {
  status?: string
  gatedAt?: string
  gate?: string
  nodes?: { nodeId: string; relation: string; rowCount: number; materialization: string }[]
  gateValid?: boolean
  publishBlockedGates?: number
  reRunStatus?: string
  reRunNodes?: string[]
  reRunGateValid?: boolean
  reRunPublishGateBlocked?: number
  error?: string
}

async function runPipelineGateJourney(): Promise<void> {
  const evidence: PipelineGateJourneyEvidence = {}
  try {
    const handle = await stageFixtureInOpfs(
      '/fixtures/customers.parquet',
      'assay-pipeline-gate-journey.parquet',
    )
    const sources = [{ nodeId: 'customers', source: handle }]
    const first = await client.runPipeline(PIPELINE_GATE_JOURNEY, {
      sources,
      contracts: [{ nodeId: 'gate', contract: GATE_FAIL_CONTRACT }],
      compilers: GATE_JOURNEY_COMPILERS,
    })
    evidence.status = first.status
    if (first.status === 'gated') {
      evidence.gatedAt = first.gatedAt
      evidence.gate = first.gate
    }
    evidence.nodes = first.nodes.map((node) => ({
      nodeId: node.nodeId,
      relation: node.relation,
      rowCount: node.rowCount,
      materialization: node.materialization,
    }))
    const firstGate = first.nodes.find((node) => node.nodeId === 'gate')?.gate
    evidence.gateValid = firstGate?.class === 'validate' ? firstGate.valid : undefined
    const firstPublish = first.nodes.find((node) => node.nodeId === 'out')?.gate
    evidence.publishBlockedGates =
      firstPublish?.class === 'publish' ? firstPublish.blockedGates.length : -1

    // Fix the contract and re-run: the gate passes and the publish runs.
    const second = await client.runPipeline(PIPELINE_GATE_JOURNEY, {
      sources,
      contracts: [{ nodeId: 'gate', contract: GATE_PASS_CONTRACT }],
      compilers: GATE_JOURNEY_COMPILERS,
    })
    evidence.reRunStatus = second.status
    evidence.reRunNodes = second.nodes.map((node) => node.nodeId)
    const reRunGate = second.nodes.find((node) => node.nodeId === 'gate')?.gate
    evidence.reRunGateValid = reRunGate?.class === 'validate' ? reRunGate.valid : undefined
    const publish = second.nodes.find((node) => node.nodeId === 'out')?.gate
    evidence.reRunPublishGateBlocked =
      publish?.class === 'publish' ? publish.blockedGates.length : -1
  } catch (error) {
    evidence.error = errorMessage(error)
  }
  setText('pipeline-gate-journey-result', JSON.stringify(evidence))
}

requiredElement<HTMLButtonElement>('#pipeline-gate-journey').addEventListener('click', () => {
  void runPipelineGateJourney()
})

const pipelineRunnerSubject = createPipelineRunnerSubject({
  fixtureUrl: '/fixtures/customers.parquet',
})

async function runPipelineConformanceScenario(
  name: (typeof pipelineRunnerConformanceScenarioNames)[number],
): Promise<void> {
  const report = await runPipelineRunnerConformanceScenarios(pipelineRunnerSubject, [name])
  const result = report.results[0]
  if (result !== undefined) {
    setText(`pipeline-conformance-result-${name}`, JSON.stringify(result, null, 2))
  }
}

async function runAllPipelineConformanceScenarios(): Promise<void> {
  const report = await runPipelineRunnerConformanceScenarios(pipelineRunnerSubject)
  setText('pipeline-conformance-run-all', JSON.stringify(report, null, 2))
}

for (const name of pipelineRunnerConformanceScenarioNames) {
  requiredElement<HTMLButtonElement>(`#pipeline-conformance-${name}`).addEventListener(
    'click',
    () => {
      void runPipelineConformanceScenario(name)
    },
  )
}
requiredElement<HTMLButtonElement>('#pipeline-conformance-run-all').addEventListener(
  'click',
  () => {
    void runAllPipelineConformanceScenarios()
  },
)

// ── M1-7 bench hooks (tests/e2e/bench-ttfr.spec.ts) ──────────────────────────
//
// One button per engine-path step; each step is timed in-page with
// performance.now() (excludes CDP round-trip noise) and accumulated into a
// JSON blob rendered into `bench-result` so the spec can read it between
// steps (it takes CDP heap checkpoints in between). The steps share the
// client, so each fresh page = a fresh engine worker = a cold measurement.

interface BenchWindowSample {
  readonly offset: number
  readonly ms: number
  readonly rows: number
}

interface BenchTimings {
  bootMs?: number
  openMs?: number
  schemaMs?: number
  schemaColumns?: number
  rowCountMs?: number
  rowCount?: number
  ttfrMs?: number
  ttfrRows?: number
  ttfrFirstId?: string
  projectedMs?: number
  projectedRows?: number
  filteredMs?: number
  filteredRows?: number
  filteredMatchingRows?: number
  windowsTotalMs?: number
  windows?: BenchWindowSample[]
}

const benchTimings: BenchTimings = {}
let benchTable: EngineTableHandle | null = null
let benchViewName: string | null = null
let benchRowCount = 0

const benchPhaseEl = requiredElement<HTMLElement>('[data-testid="bench-phase"]')
const benchErrorEl = requiredElement<HTMLElement>('[data-testid="bench-error"]')
const benchResultEl = requiredElement<HTMLElement>('[data-testid="bench-result"]')
const benchFileInput = requiredElement<HTMLInputElement>('[data-testid="bench-file-input"]')

/** Column-name contract with tests/e2e/support/big-fixture.ts. */
const BENCH_PROJECTION = ['id', 'label'] as const
const BENCH_FILTER_COLUMN = 'value'
/**
 * max(value) = 999_999 / 7 ≈ 142_857.1; the threshold keeps ~0.6% of rows, so
 * Parquet zone maps on this pseudo-random column cannot prune row groups and
 * the filter measures an honest (near-)full scan of the file.
 */
const BENCH_FILTER_THRESHOLD = '142000.0'
const BENCH_WINDOW_ROWS = 1000
const BENCH_WINDOW_FRACTIONS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99] as const

function benchMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10
}

function benchDone(phase: string): void {
  benchPhaseEl.textContent = phase
  benchErrorEl.textContent = ''
  benchResultEl.textContent = JSON.stringify(benchTimings)
}

function benchFail(error: unknown): void {
  benchPhaseEl.textContent = 'error'
  benchErrorEl.textContent = errorMessage(error)
}

function requireBenchTable(): EngineTableHandle {
  if (benchTable === null) throw new Error('bench: open a file first')
  return benchTable
}

/** Double-quoted SQL identifier (view/column names are engine-side values). */
function benchQuoteIdentifier(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"'
}

/**
 * The generated view name for the opened table (e.g. "v1"). Discovered via
 * duckdb_views() so the harness never hard-codes the registry's naming —
 * there is exactly one user view per bench page (one open per repeat).
 */
async function benchResolveViewName(): Promise<string> {
  if (benchViewName !== null) return benchViewName
  const result = await client.query('SELECT view_name FROM duckdb_views() WHERE internal = false')
  const column = readArrowColumn(result, 'view_name')
  if (column === null) throw new Error('bench: view discovery returned an unexpected shape')
  const names: string[] = []
  for (let row = 0; row < column.length; row++) names.push(String(column.get(row)))
  const [viewName] = names
  if (names.length !== 1 || viewName === undefined) {
    throw new Error(`bench: expected exactly one user view, found ${String(names.length)}`)
  }
  benchViewName = viewName
  return benchViewName
}

/** Read a named column out of a query result via the Arrow API. */
function readArrowColumn(
  result: EngineQueryResult,
  columnName: string,
): ReturnType<EngineQueryResult['batch']['getChildAt']> {
  const index = result.batch.schema.fields.findIndex((field) => field.name === columnName)
  return index >= 0 ? result.batch.getChildAt(index) : null
}

async function benchBoot(): Promise<void> {
  try {
    const startedAt = performance.now()
    await client.ensureReady()
    benchTimings.bootMs = benchMs(startedAt)
    benchDone('boot-done')
  } catch (error) {
    benchFail(error)
  }
}

async function benchOpen(): Promise<void> {
  try {
    const file = benchFileInput.files?.[0]
    if (file === undefined) throw new Error('bench: no file selected')
    // Privacy (ADR 0025): the file name only feeds the engine's extension
    // detection and is never rendered; the table id is the public handle.
    const source: EngineFileSource = { name: file.name, getFile: async () => file }
    const startedAt = performance.now()
    benchTable = await client.open(source)
    benchTimings.openMs = benchMs(startedAt)
    benchDone('open-done')
  } catch (error) {
    benchFail(error)
  }
}

async function benchSchemaAndCount(): Promise<void> {
  try {
    const table = requireBenchTable()
    const schemaStarted = performance.now()
    const columns = await client.schema(table)
    benchTimings.schemaMs = benchMs(schemaStarted)
    benchTimings.schemaColumns = columns.length
    const countStarted = performance.now()
    benchRowCount = await client.rowCount(table)
    benchTimings.rowCountMs = benchMs(countStarted)
    benchTimings.rowCount = benchRowCount
    benchDone('schema-done')
  } catch (error) {
    benchFail(error)
  }
}

/** Time-to-first-row: the first fetchRange window incl. IPC + reconstitution. */
async function benchTtfr(): Promise<void> {
  try {
    const table = requireBenchTable()
    const startedAt = performance.now()
    const result = await client.fetchRange(table, { startRow: 0, endRow: BENCH_WINDOW_ROWS })
    benchTimings.ttfrMs = benchMs(startedAt)
    benchTimings.ttfrRows = result.batch.numRows
    // Correctness anchor: id = row index in the deterministic fixture.
    benchTimings.ttfrFirstId = String(result.batch.getChildAt(0)?.get(0))
    benchDone('ttfr-done')
  } catch (error) {
    benchFail(error)
  }
}

/** Projected query: two of seven columns, first batch of a LIMIT window. */
async function benchProjected(): Promise<void> {
  try {
    const view = await benchResolveViewName()
    const projection = BENCH_PROJECTION.map(benchQuoteIdentifier).join(', ')
    const sql =
      `SELECT ${projection} FROM ${benchQuoteIdentifier(view)}` +
      ` LIMIT ${String(BENCH_WINDOW_ROWS)}`
    const startedAt = performance.now()
    const result = await client.query(sql)
    benchTimings.projectedMs = benchMs(startedAt)
    benchTimings.projectedRows = result.batch.numRows
    benchDone('projected-done')
  } catch (error) {
    benchFail(error)
  }
}

/** Filtered query: near-full scan (see BENCH_FILTER_THRESHOLD), 1-row batch. */
async function benchFiltered(): Promise<void> {
  try {
    const view = await benchResolveViewName()
    const sql =
      `SELECT count(*) AS matching FROM ${benchQuoteIdentifier(view)}` +
      ` WHERE ${benchQuoteIdentifier(BENCH_FILTER_COLUMN)} > ${BENCH_FILTER_THRESHOLD}`
    const startedAt = performance.now()
    const result = await client.query(sql)
    const rawCount = result.batch.getChildAt(0)?.get(0)
    const matching = typeof rawCount === 'bigint' ? Number(rawCount) : rawCount
    benchTimings.filteredMs = benchMs(startedAt)
    benchTimings.filteredRows = result.batch.numRows
    benchTimings.filteredMatchingRows = typeof matching === 'number' ? matching : -1
    benchDone('filtered-done')
  } catch (error) {
    benchFail(error)
  }
}

/** Sequential windowed fetches spread across the whole file (grid pattern). */
async function benchWindows(): Promise<void> {
  try {
    const table = requireBenchTable()
    if (benchRowCount <= 0) throw new Error('bench: run the schema/rowCount step first')
    const samples: BenchWindowSample[] = []
    const totalStarted = performance.now()
    for (const fraction of BENCH_WINDOW_FRACTIONS) {
      const maxOffset = benchRowCount - BENCH_WINDOW_ROWS
      const offset = Math.max(0, Math.min(maxOffset, Math.floor(fraction * benchRowCount)))
      const startedAt = performance.now()
      const result = await client.fetchRange(table, {
        startRow: offset,
        endRow: offset + BENCH_WINDOW_ROWS,
      })
      samples.push({ offset, ms: benchMs(startedAt), rows: result.batch.numRows })
    }
    benchTimings.windowsTotalMs = benchMs(totalStarted)
    benchTimings.windows = samples
    benchDone('windows-done')
  } catch (error) {
    benchFail(error)
  }
}

requiredElement<HTMLButtonElement>('#bench-boot').addEventListener('click', () => {
  void benchBoot()
})
requiredElement<HTMLButtonElement>('#bench-open').addEventListener('click', () => {
  void benchOpen()
})
requiredElement<HTMLButtonElement>('#bench-schema').addEventListener('click', () => {
  void benchSchemaAndCount()
})
requiredElement<HTMLButtonElement>('#bench-ttfr').addEventListener('click', () => {
  void benchTtfr()
})
requiredElement<HTMLButtonElement>('#bench-projected').addEventListener('click', () => {
  void benchProjected()
})
requiredElement<HTMLButtonElement>('#bench-filtered').addEventListener('click', () => {
  void benchFiltered()
})
requiredElement<HTMLButtonElement>('#bench-windows').addEventListener('click', () => {
  void benchWindows()
})

/** Latest open per fixture kind, so independent steps can address tables. */
const handles = new Map<string, EngineTableHandle>()

async function runSmokeQuery(): Promise<void> {
  try {
    const ready = await client.ensureReady()
    const result = await client.query('SELECT 42 AS answer')
    statusEl.textContent = client.status
    setText('duckdb-version', ready.duckdbVersion)
    renderResult('', result)
  } catch (error) {
    statusEl.textContent = client.status
    setText('duckdb-version', `error: ${errorMessage(error)}`)
  }
}

/**
 * Multi-batch query: `range(5000)` produces more Arrow record batches than
 * the single transported first batch (hasMore=true, tail cancelled inside the
 * worker). The follow-up query proves the connection stayed usable.
 */
async function runRangeQuery(): Promise<void> {
  try {
    const result = await client.query('SELECT i FROM range(5000) AS t(i)')
    statusEl.textContent = client.status
    renderResult('-range', result)
    const followUp = await client.query('SELECT 7 AS seven')
    setText('post-cancel-value', String(followUp.batch.getChildAt(0)?.get(0)))
  } catch (error) {
    statusEl.textContent = client.status
    setText('post-cancel-value', `error: ${errorMessage(error)}`)
  }
}

/**
 * Fetch the fixture bytes served from this harness's public dir, stage them
 * in the OPFS sandbox, and return the *genuine* FileSystemFileHandle (no
 * dialog, no DataTransfer synthesis — see the data-sources harness).
 */
async function stageFixtureInOpfs(
  fixtureUrl: string,
  stagedName: string,
): Promise<FileSystemFileHandle> {
  const response = await fetch(fixtureUrl)
  if (!response.ok) throw new Error(`fixture fetch failed: HTTP ${response.status}`)
  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(stagedName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(await response.blob())
  await writable.close()
  return fileHandle
}

/**
 * Open one fixture through the engine: the FileSystemFileHandle satisfies the
 * `EngineFileSource` seam structurally (`{ name, getFile(): Promise<File> }`).
 * Renders table id + detected format — never the file name.
 */
async function openFixture(fixtureUrl: string, stagedName: string, key: string): Promise<void> {
  try {
    const handle = await stageFixtureInOpfs(fixtureUrl, stagedName)
    const table = await client.open(handle)
    handles.set(key, table)
    statusEl.textContent = client.status
    setText(`open-table-id-${key}`, table.id)
    setText(`open-status-${key}`, 'opened')
  } catch (error) {
    statusEl.textContent = client.status
    setText(`open-status-${key}`, `error: ${errorMessage(error)}`)
  }
}

/** DESCRIBE-backed schema: DuckDB type strings passed through unchanged. */
async function readSchema(key: string): Promise<void> {
  const table = handles.get(key)
  if (table === undefined) {
    setText(`schema-${key}`, 'error: no table opened for this fixture yet')
    return
  }
  try {
    const columns = await client.schema(table)
    setText(`schema-${key}`, columns.map((column) => `${column.name}:${column.type}`).join(', '))
    setText(`schema-count-${key}`, String(columns.length))
  } catch (error) {
    setText(`schema-${key}`, `error: ${errorMessage(error)}`)
  }
}

/**
 * Windowed fetchRange: values are read via the Arrow vector API in renderRow
 * — NULLs come back as JS null and are rendered as the literal marker `null`.
 */
async function runRangeWindow(
  key: 'first' | 'middle',
  startRow: number,
  endRow: number,
): Promise<void> {
  const table = handles.get('flat')
  if (table === undefined) {
    setText(`range-${key}-values`, 'error: open the flat fixture first')
    return
  }
  try {
    const result = await client.fetchRange(table, { startRow, endRow })
    setText(`range-${key}-values`, renderColumn(result, 'customer_id'))
    setText(`range-${key}-countries`, renderColumn(result, 'country'))
    setText(`range-${key}-income`, renderColumn(result, 'income'))
    setText(`range-${key}-num-rows`, String(result.batch.numRows))
    setText(`range-${key}-has-more`, String(result.hasMore))
  } catch (error) {
    setText(`range-${key}-values`, `error: ${errorMessage(error)}`)
  }
}

/**
 * Failed-query-then-reuse: an invalid SQL must reject with the engine error
 * (via the typed protocol), and a follow-up query must still answer — the
 * connection and worker survive an error (m1-2 reviewer-note cleanup path).
 */
async function runFailedQueryThenReuse(): Promise<void> {
  try {
    await client.query('SELECT * FROM __assay_no_such_table__')
    setText('query-error', 'no error reported (unexpected)')
  } catch (error) {
    setText('query-error', errorMessage(error))
  }
  try {
    const followUp = await client.query('SELECT 7 AS seven')
    setText('post-error-value', String(followUp.batch.getChildAt(0)?.get(0)))
  } catch (error) {
    setText('post-error-value', `error: ${errorMessage(error)}`)
  }
  statusEl.textContent = client.status // still 'ready': the engine survived
}

/** Render a result strictly through the Arrow API (never a scalar-row dump). */
function renderResult(suffix: string, result: EngineQueryResult): void {
  setText(
    `arrow-schema${suffix}`,
    result.batch.schema.fields.map((field) => `${field.name}:${field.type}`).join(','),
  )
  setText(`arrow-num-rows${suffix}`, String(result.batch.numRows))
  setText(`arrow-value${suffix}`, String(result.batch.getChildAt(0)?.get(0)))
  setText(`query-has-more${suffix}`, String(result.hasMore))
}

function renderColumn(result: EngineQueryResult, columnName: string): string {
  const index = result.batch.schema.fields.findIndex((field) => field.name === columnName)
  const column = index >= 0 ? result.batch.getChildAt(index) : null
  if (column === null) return 'missing column'
  const values: string[] = []
  for (let row = 0; row < column.length; row++) {
    const value: unknown = column.get(row)
    values.push(value === null || value === undefined ? 'null' : String(value))
  }
  return values.join('|')
}

function setText(testId: string, value: string): void {
  requiredElement<HTMLElement>(`[data-testid="${testId}"]`).textContent = value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) {
    throw new Error(`harness is missing element ${selector}`)
  }
  return element
}
