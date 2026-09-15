/**
 * Node-side proof of the data-engine conformance suite itself: the scenarios
 * run green against a *compliant in-memory fake engine* (proving the suite is
 * engine-agnostic and its logic sound), and each scenario detects a
 * deliberately non-compliant fake (proving the assertions bite). The
 * real-engine proof for engine-duckdb lives in the browser harness + e2e
 * (DuckDB-WASM cannot run under Node vitest).
 */
import { tableFromArrays } from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import type { Table } from 'apache-arrow'
import {
  engineConformanceScenarioNames,
  runEngineConformanceScenario,
  runEngineConformanceScenarios,
} from './engine-conformance'
import type {
  ConformanceBatchResult,
  ConformanceEngineClient,
  ConformanceFileSource,
  ConformanceScenarioName,
  ConformanceTableHandle,
  ConformanceWindow,
  EngineConformanceSubject,
} from './engine-conformance'

/** Category-tagged errors so the fake can mirror the classification contract. */
class FakeOperationError extends Error {}
class FakeQueryError extends Error {}
class FakeDisposedError extends Error {}

/** Mutation knobs that make the fake non-compliant in one specific way. */
interface FakeMutations {
  /** createClient() returns an already-booted client (breaks laziness). */
  startReady?: boolean
  /** rowCount() lies about the total (breaks the lifecycle scenario). */
  rowCountDelta?: number
  /** Invalid windows resolve instead of rejecting. */
  acceptInvalidWindows?: boolean
  /** Oversized windows return everything instead of clamping to the cap. */
  ignoreWindowCap?: boolean
  /** Corrupt (shorter-than-good) bytes open successfully. */
  acceptCorruptFiles?: boolean
  /** Invalid SQL resolves instead of rejecting. */
  resolveFailingSql?: boolean
  /** Post-dispose rejections use a generic error, not the disposed category. */
  genericDisposeErrors?: boolean
  /** After the mid-stream failure the connection stays wedged. */
  wedgeAfterMidStreamFailure?: boolean
}

const GOOD_DATASET = {
  rowCount: 5,
  columns: [
    { name: 'id', type: 'Int32', values: ['1', '2', '3', '4', '5'] },
    { name: 'label', type: 'Utf8', values: ['a', 'b', null, 'd', 'e'] },
    { name: 'note', type: 'Utf8' }, // no declared values (name-order assertion only)
  ],
}

const MAX_WINDOW_ROWS = 1000
const WIDE_ROW_COUNT = 1500
const FAILING_SQL = 'SELECT * FROM __no_such_table__'
const MID_STREAM_SQL = 'SELECT fail_after_first_batch()'
const SMOKE_SQL = 'SELECT 42 AS answer'
const SMOKE_VALUE = '42'

/** Mutable staging state shared between the fake subject and its clients. */
const subjectState = {
  staged: new Map<string, Uint8Array>(),
  goodBytes: new Uint8Array([80, 65, 82, 49, 1, 2, 3, 4]), // "PAR1" + payload
}

/**
 * In-memory fake engine that satisfies the *contract* the suite asserts:
 * lazy boot, classified errors, window clamping, Arrow batches (NULL-safe,
 * declared column order), registry rollback for corrupt bytes, and
 * post-mid-stream-failure reusability.
 */
class FakeEngineClient implements ConformanceEngineClient {
  status = 'idle'
  private nextTableId = 1
  /** tableId → staged file name for successfully opened tables. */
  private readonly registered = new Map<string, string>()
  private midStreamFailed = false

  constructor(private readonly mutations: FakeMutations) {}

  async ensureReady(): Promise<unknown> {
    if (this.status === 'disposed') throw new FakeDisposedError('engine client was disposed')
    this.status = 'ready'
    return { version: 'fake-1.0.0' }
  }

  async open(source: ConformanceFileSource): Promise<ConformanceTableHandle> {
    await this.ensureReady()
    if (!/\.(parquet|csv)$/.test(source.name)) {
      throw new FakeOperationError('unsupported dataset format')
    }
    const bytes = subjectState.staged.get(source.name)
    if (bytes === undefined) {
      throw new FakeOperationError('staged file missing')
    }
    // The suite corrupts by truncation, so "shorter than the good bytes" is
    // the fake's stand-in for "unreadable at view-bind time" — the fake rolls
    // the open back (nothing is registered) exactly like a compliant engine.
    if (!this.mutations.acceptCorruptFiles && bytes.length < subjectState.goodBytes.length) {
      throw new FakeOperationError('no magic bytes at end of file')
    }
    const tableId = `fake-t${this.nextTableId++}`
    this.registered.set(tableId, source.name)
    return { kind: 'table', id: tableId }
  }

  async schema(handle: ConformanceTableHandle): Promise<readonly { name: string; type: string }[]> {
    this.requireRegistered(handle)
    return GOOD_DATASET.columns.map((column) => ({ name: column.name, type: column.type }))
  }

  async rowCount(handle: ConformanceTableHandle): Promise<number> {
    this.requireRegistered(handle)
    const base = this.isWide(handle) ? WIDE_ROW_COUNT : GOOD_DATASET.rowCount
    return base + (this.mutations.rowCountDelta ?? 0)
  }

  async fetchRange(
    handle: ConformanceTableHandle,
    window: ConformanceWindow,
  ): Promise<ConformanceBatchResult> {
    this.requireRegistered(handle)
    if (
      !isRowIndex(window.startRow) ||
      !isRowIndex(window.endRow) ||
      window.endRow < window.startRow
    ) {
      if (this.mutations.acceptInvalidWindows) {
        return { batch: emptyGoodTable(), hasMore: false }
      }
      throw new FakeOperationError('invalid row window')
    }
    const cap = this.mutations.ignoreWindowCap ? Number.MAX_SAFE_INTEGER : MAX_WINDOW_ROWS
    const end = Math.min(window.endRow, window.startRow + cap)
    if (this.isWide(handle)) {
      const ids = Array.from({ length: WIDE_ROW_COUNT }, (_, i) => i)
      return { batch: wideTable(ids.slice(window.startRow, end)), hasMore: false }
    }
    return { batch: goodTable(window.startRow, end), hasMore: false }
  }

  async query(sql: string): Promise<ConformanceBatchResult> {
    await this.ensureReady()
    if (sql === FAILING_SQL) {
      if (this.mutations.resolveFailingSql) return { batch: wideTable([1]), hasMore: false }
      throw new FakeQueryError('Parser Error')
    }
    if (sql === MID_STREAM_SQL) {
      // Contract stand-in: the first batch succeeded (invisible at this API
      // level — the real engine's first-batch-ok is proven in the browser
      // e2e); the stream then failed. The fake models the observable part:
      // rejection as a query error + the reusability (or wedge) that follows.
      this.midStreamFailed = true
      throw new FakeQueryError('mid-stream failure')
    }
    if (sql === SMOKE_SQL) {
      if (this.mutations.wedgeAfterMidStreamFailure && this.midStreamFailed) {
        throw new FakeQueryError('connection wedged')
      }
      return { batch: tableFromArrays({ answer: [SMOKE_VALUE] }), hasMore: false }
    }
    throw new FakeQueryError('unknown SQL')
  }

  async dispose(): Promise<void> {
    this.status = 'disposed'
    this.registered.clear()
  }

  /** The fake subject's registry probe reads the live set (same class). */
  registeredCount(): number {
    return this.registered.size
  }

  private isWide(handle: ConformanceTableHandle): boolean {
    return this.registered.get(handle.id) === 'wide.csv'
  }

  private requireRegistered(handle: ConformanceTableHandle): void {
    if (this.status === 'disposed') {
      if (this.mutations.genericDisposeErrors) {
        throw new Error('client already closed')
      }
      throw new FakeDisposedError('engine client was disposed')
    }
    if (!this.registered.has(handle.id)) {
      throw new FakeOperationError(`unknown table handle: ${handle.id}`)
    }
  }
}

function isRowIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The good dataset as an Arrow table (declared column order, NULL-safe). */
function goodTable(start: number, end: number): Table {
  const ids = GOOD_DATASET.columns[0]!.values!
  const labels = GOOD_DATASET.columns[1]!.values!
  const sliceIds: number[] = []
  const sliceLabels: (string | null)[] = []
  const sliceNotes: string[] = []
  for (let row = start; row < end; row++) {
    sliceIds.push(Number(ids[row]))
    sliceLabels.push(labels[row] ?? null)
    sliceNotes.push(`note-${String(row)}`)
  }
  return tableFromArrays({
    id: Int32Array.from(sliceIds),
    label: sliceLabels,
    note: sliceNotes,
  })
}

function emptyGoodTable(): Table {
  return goodTable(0, 0)
}

function wideTable(ids: readonly number[]): Table {
  return tableFromArrays({ id: Int32Array.from(ids) })
}

function makeSubject(mutations: FakeMutations = {}): EngineConformanceSubject {
  subjectState.staged.clear()
  return {
    name: 'fake-engine',
    createClient: () => {
      const client = new FakeEngineClient(mutations)
      if (mutations.startReady) void client.ensureReady()
      return client
    },
    isIdle: (client) => client.status === 'idle',
    isReady: (client) => client.status === 'ready',
    errors: {
      operation: (error) => error instanceof FakeOperationError,
      query: (error) => error instanceof FakeQueryError,
      disposed: (error) => error instanceof FakeDisposedError,
    },
    dataset: GOOD_DATASET,
    maxWindowRows: MAX_WINDOW_ROWS,
    wideRowCount: WIDE_ROW_COUNT,
    stageGoodFile: async () => {
      const name = 'good.parquet'
      subjectState.staged.set(name, subjectState.goodBytes)
      return fileSource(name)
    },
    stageWideFile: async () => {
      const name = 'wide.csv'
      // Length is the fake's readability stand-in; content is irrelevant.
      subjectState.staged.set(name, new Uint8Array(WIDE_ROW_COUNT))
      return fileSource(name)
    },
    goodParquetBytes: async () => subjectState.goodBytes,
    stageBytes: async (bytes, name) => {
      subjectState.staged.set(name, bytes)
      return fileSource(name)
    },
    failingSql: () => FAILING_SQL,
    midStreamFailureSql: () => MID_STREAM_SQL,
    smokeSql: () => SMOKE_SQL,
    smokeSqlValue: SMOKE_VALUE,
    registeredTableCount: async (client) =>
      client instanceof FakeEngineClient ? client.registeredCount() : null,
  }
}

function fileSource(name: string): ConformanceFileSource {
  return { name, getFile: () => Promise.resolve({}) }
}

async function runOne(
  mutations: FakeMutations,
  name: ConformanceScenarioName,
): Promise<{ passed: boolean; detail: string }> {
  const result = await runEngineConformanceScenario(makeSubject(mutations), name)
  return { passed: result.passed, detail: result.detail }
}

describe('engine conformance suite (compliant fake engine)', () => {
  it('runs every scenario green against a contract-compliant in-memory engine', async () => {
    const report = await runEngineConformanceScenarios(makeSubject())
    expect(report.subject).toBe('fake-engine')
    expect(report.results.map((result) => result.name)).toEqual([...engineConformanceScenarioNames])
    expect(report.allPassed, JSON.stringify(report.results, null, 2)).toBe(true)
    for (const result of report.results) {
      expect(result.detail).toBe('passed')
      expect(Object.keys(result.facts).length).toBeGreaterThan(0)
    }
  })

  it('exposes scenario-level evidence (clamped rows, registry counts, follow-up value)', async () => {
    const subject = makeSubject()
    const clamping = await runEngineConformanceScenario(subject, 'window-clamping')
    expect(clamping.facts['clampedRows']).toBe(MAX_WINDOW_ROWS)
    expect(clamping.facts['tailRows']).toBe(3)
    const rollback = await runEngineConformanceScenario(subject, 'corrupt-file-rollback')
    expect(rollback.facts['registeredAfterFailedOpen']).toBe(0)
    expect(rollback.facts['registeredAfterGoodOpen']).toBe(1)
    const midStream = await runEngineConformanceScenario(subject, 'mid-stream-error-reuse')
    expect(midStream.facts['followUpValue']).toBe(SMOKE_VALUE)
  })
})

describe('engine conformance suite (detects non-compliant engines)', () => {
  it('lazy-boot: detects a client that boots on construction', async () => {
    const { passed, detail } = await runOne({ startReady: true }, 'lazy-boot')
    expect(passed).toBe(false)
    expect(detail).toContain('idle')
  })

  it('file-lifecycle: detects a lying rowCount', async () => {
    const { passed, detail } = await runOne({ rowCountDelta: 1 }, 'file-lifecycle')
    expect(passed).toBe(false)
    expect(detail).toContain('rowCount')
  })

  it('file-lifecycle: detects post-dispose rejections outside the disposed category', async () => {
    const { passed, detail } = await runOne({ genericDisposeErrors: true }, 'file-lifecycle')
    expect(passed).toBe(false)
    expect(detail).toContain('disposed error category')
  })

  it('error-classes: detects swallowed query errors', async () => {
    const { passed, detail } = await runOne({ resolveFailingSql: true }, 'error-classes')
    expect(passed).toBe(false)
    expect(detail).toContain('invalid SQL must reject')
  })

  it('window-clamping: detects a missing window cap', async () => {
    const { passed, detail } = await runOne({ ignoreWindowCap: true }, 'window-clamping')
    expect(passed).toBe(false)
    expect(detail).toContain('clamped to the window cap')
  })

  it('window-clamping: detects invalid windows resolving instead of rejecting', async () => {
    const { passed, detail } = await runOne({ acceptInvalidWindows: true }, 'window-clamping')
    expect(passed).toBe(false)
    expect(detail).toContain('invalid window')
  })

  it('arrow-shape: detects a batch whose columns are shuffled', async () => {
    // The fake always serves the declared column order, so a subject whose
    // declared order differs must make the scenario fail on field 0.
    const subject = makeSubject()
    const mismatched: EngineConformanceSubject = {
      ...subject,
      dataset: {
        rowCount: GOOD_DATASET.rowCount,
        columns: [GOOD_DATASET.columns[1]!, GOOD_DATASET.columns[0]!, GOOD_DATASET.columns[2]!],
      },
    }
    const result = await runEngineConformanceScenario(mismatched, 'arrow-shape')
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('Arrow field 0 name')
  })

  it('corrupt-file-rollback: detects engines that keep corrupt registrations', async () => {
    const { passed, detail } = await runOne({ acceptCorruptFiles: true }, 'corrupt-file-rollback')
    expect(passed).toBe(false)
    expect(detail).toContain('corrupt Parquet must reject')
  })

  it('mid-stream-error-reuse: detects a connection that stays wedged after cleanup', async () => {
    const { passed, detail } = await runOne(
      { wedgeAfterMidStreamFailure: true },
      'mid-stream-error-reuse',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('follow-up query')
  })
})
