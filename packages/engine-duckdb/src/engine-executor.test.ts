import { Table, tableFromArrays, tableFromIPC } from 'apache-arrow'
import type { RecordBatch } from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import { EngineOpExecutor } from './engine-executor'
import type {
  EngineConnectionLike,
  EngineExecutorDeps,
  EngineResultReaderLike,
  EngineSessionLike,
} from './engine-executor'
import type { EngineRequest, EngineResponse } from './protocol'

/**
 * T2 worker-side concurrency tests: interleaved query/fetchRange/rowCount/
 * schema/dispose driven through the real executor (`EngineOpExecutor`) — the
 * exact class the worker entry wires to DuckDB-WASM — against a fake
 * connection that models duckdb-wasm 1.32's single-pending-query-per-
 * connection constraint.
 *
 * Determinism: every connection `send` parks on an explicitly-resolved gate,
 * so interleavings are scripted step by step — no timers, no real DuckDB.
 *
 * The collision guard: the fake connection records `busy` from a `send` (or
 * `query`, which is send + drain) until the reader is drained and cancelled.
 * A second `send`/`query` while busy pushes into `collisions` and throws —
 * so ANY test that lets two operations overlap fails loudly. Every test
 * asserts `collisions` stays empty.
 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush microtask chains to a macrotask boundary. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Single-column int32 table (the shape the fake streams yield). */
function intTable(values: readonly number[]): Table {
  return tableFromArrays({ value: Int32Array.from(values) })
}

/** DESCRIBE-shaped table (all-VARCHAR, as DuckDB reports it). */
function describeTable(): Table {
  return tableFromArrays({
    column_name: ['customer_id', 'country'],
    column_type: ['BIGINT', 'VARCHAR'],
  })
}

/** The single count(*) value as DuckDB's BIGINT would arrive. */
function countTable(count: bigint): Table {
  return tableFromArrays({ row_count: BigInt64Array.from([count]) })
}

/** One query's result stream: explicit batches plus a scripted failure. */
class FakeStream {
  /** Index into the batch sequence whose `next()` call rejects. */
  failNextAt = -1
  readonly failure = new Error('assay fake mid-stream failure')
  constructor(
    readonly schema: Table['schema'],
    readonly batches: RecordBatch[],
  ) {}

  /** A stream over all batches of `table`. */
  static of(table: Table): FakeStream {
    return new FakeStream(table.schema, [...table.batches])
  }

  /** A stream with no batches at all (the "engine produced nothing" case). */
  static empty(): FakeStream {
    return new FakeStream(tableFromArrays({}).schema, [])
  }
}

class FakeReader implements EngineResultReaderLike {
  private index = 0
  cancelled = false

  constructor(
    readonly stream: FakeStream,
    private readonly release: () => void,
  ) {}

  async next(): Promise<IteratorResult<RecordBatch, undefined>> {
    if (this.stream.failNextAt === this.index) {
      this.index += 1
      throw this.stream.failure
    }
    const batch = this.stream.batches[this.index]
    this.index += 1
    if (batch === undefined) {
      return { done: true, value: undefined }
    }
    return { done: false, value: batch }
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    // Cancelling (or fully draining) is what frees the connection's single
    // pending-query slot.
    this.release()
  }
}

interface PendingSend {
  readonly sql: string
  readonly gate: Deferred<FakeStream>
}

class FakeConnection implements EngineConnectionLike {
  private busy = false
  private readonly pendingSends: PendingSend[] = []

  /** SQL strings in exact execution (not arrival) order. */
  readonly sentSqls: string[] = []
  /** The T2 guard: any entry here means two ops overlapped on the connection. */
  readonly collisions: string[] = []
  cancelSentCalls = 0

  async send(sql: string): Promise<EngineResultReaderLike> {
    this.sentSqls.push(sql)
    if (this.busy) {
      // Mirrors duckdb-wasm 1.32: `startPendingQuery` on an occupied
      // connection cannot run — two pending queries on one connection is the
      // collision this task exists to prevent. Fail loudly instead of
      // misattributing results.
      this.collisions.push(sql)
      throw new Error('pending-query collision: connection already busy')
    }
    this.busy = true
    const gate = deferred<FakeStream>()
    const send: PendingSend = { sql, gate }
    this.pendingSends.push(send)
    try {
      const stream = await gate.promise
      return new FakeReader(stream, () => {
        this.busy = false
      })
    } catch (error) {
      // A failed start frees the slot (as duckdb-wasm's pending query does).
      this.busy = false
      throw error
    }
  }

  async query(sql: string): Promise<Table> {
    // duckdb-wasm's conn.query is send + full drain; the busy window spans
    // both, exactly like the real pending-query slot.
    const reader = await this.send(sql)
    if (!(reader instanceof FakeReader)) {
      throw new Error('fake query: unexpected reader type')
    }
    const batches: RecordBatch[] = []
    for (;;) {
      const chunk = await reader.next()
      if (chunk.done) break
      batches.push(chunk.value)
    }
    await reader.cancel()
    return new Table(reader.stream.schema, batches)
  }

  async cancelSent(): Promise<unknown> {
    this.cancelSentCalls += 1
    return true
  }

  /** Test side: the n-th send's gate (must exist — flush first). */
  sendAt(index: number): PendingSend {
    const send = this.pendingSends[index]
    if (send === undefined) {
      throw new Error(`no pending send at index ${index} (sent: ${this.sentSqls.join(' | ')})`)
    }
    return send
  }

  /** Test side: release the n-th send with the given result table. */
  resolveSend(index: number, table: Table): void {
    this.sendAt(index).gate.resolve(FakeStream.of(table))
  }

  /** Test side: fail the n-th send at `startPendingQuery` time. */
  rejectSend(index: number, error: unknown): void {
    this.sendAt(index).gate.reject(error)
  }
}

class FakeDeps implements EngineExecutorDeps {
  readonly postedResponses: EngineResponse[] = []
  readonly postedTransfers: Array<ArrayBuffer[] | undefined> = []
  readonly registeredFiles: Array<{ name: string; file: File }> = []
  readonly droppedFiles: string[] = []
  readonly connection = new FakeConnection()
  registerFileError: unknown = null
  sessionGate: Deferred<void> | null = null
  /** `ensureSession` calls by the executor (one per op). */
  bootCalls = 0
  /** Actual boots (the memoization mirrors worker.ts's `ensureSession`). */
  boots = 0
  private sessionPromise: Promise<EngineSessionLike> | null = null

  ensureSession(): Promise<EngineSessionLike> {
    this.bootCalls += 1
    this.sessionPromise ??= (async () => {
      this.boots += 1
      if (this.sessionGate !== null) await this.sessionGate.promise
      return {
        getVersion: async () => 'vX-test',
        conn: this.connection,
      }
    })()
    return this.sessionPromise
  }

  registerFileHandle(registeredFileName: string, file: File): Promise<void> {
    this.registeredFiles.push({ name: registeredFileName, file })
    if (this.registerFileError !== null) {
      return Promise.reject(this.registerFileError)
    }
    return Promise.resolve()
  }

  dropFile(registeredFileName: string): Promise<unknown> {
    this.droppedFiles.push(registeredFileName)
    return Promise.resolve(null)
  }

  post(response: EngineResponse, transfer?: ArrayBuffer[]): void {
    this.postedResponses.push(response)
    this.postedTransfers.push(transfer)
  }
}

function makeExecutor(): { executor: EngineOpExecutor; deps: FakeDeps } {
  const deps = new FakeDeps()
  return { executor: new EngineOpExecutor(deps), deps }
}

// ---- request builders ----

const FLAT_FILE = new File([new Uint8Array([1, 2, 3])], 'flat.parquet')

function openRequest(id: number): EngineRequest {
  return { type: 'engine/open', requestId: id, name: 'flat.parquet', file: FLAT_FILE }
}
function queryRequest(id: number, sql: string): EngineRequest {
  return { type: 'engine/query', requestId: id, sql }
}
function rangeRequest(id: number, startRow = 0, endRow = 5): EngineRequest {
  return { type: 'engine/range', requestId: id, tableId: 't1', startRow, endRow }
}
function rowCountRequest(id: number): EngineRequest {
  return { type: 'engine/row-count', requestId: id, tableId: 't1' }
}
function schemaRequest(id: number): EngineRequest {
  return { type: 'engine/schema', requestId: id, tableId: 't1' }
}
function disposeRequest(id: number): EngineRequest {
  return { type: 'engine/dispose', requestId: id }
}

// ---- assertion helpers ----

async function awaitPosted(deps: FakeDeps, requestId: number): Promise<EngineResponse> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = deps.postedResponses.find((response) => response.requestId === requestId)
    if (found !== undefined) return found
    await flush()
  }
  throw new Error(`no response was posted for request ${requestId}`)
}

async function awaitSends(connection: FakeConnection, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && connection.sentSqls.length < count; attempt += 1) {
    await flush()
  }
  if (connection.sentSqls.length < count) {
    throw new Error(`expected ${count} sends, saw ${connection.sentSqls.length}`)
  }
}

/** Values of the first column of a posted Arrow IPC payload, via the Arrow API. */
function firstColumnValues(batchIpc: Uint8Array): number[] {
  const column = tableFromIPC(batchIpc).getChildAt(0)
  if (column === null) throw new Error('posted batch has no first column')
  return Array.from({ length: column.length }, (_, index) => column.get(index))
}

/**
 * Open one table through the full open flow (register + CREATE VIEW) and wait
 * for the open result. Used to seed the registry for the handle-addressed ops.
 */
async function openFlatTable(executor: EngineOpExecutor, deps: FakeDeps): Promise<void> {
  executor.accept(openRequest(1))
  await awaitSends(deps.connection, 1) // CREATE VIEW "assay_t1" …
  expect(deps.connection.sentSqls[0]).toMatch(/CREATE VIEW "assay_t1"/)
  deps.connection.resolveSend(0, intTable([]))
  const posted = await awaitPosted(deps, 1)
  expect(posted).toMatchObject({ type: 'engine/open-result', tableId: 't1', format: 'parquet' })
}

describe('EngineOpExecutor concurrency (T2 worker-side serialization)', () => {
  it('interleaved query, fetchRange, and rowCount complete with correct results, FIFO, no overlap', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    expect(deps.connection.collisions).toEqual([])

    // Three ops arrive concurrently (single postMessage burst order).
    executor.accept(queryRequest(2, 'SELECT 42 AS value'))
    executor.accept(rangeRequest(3, 0, 5))
    executor.accept(rowCountRequest(4))
    await awaitSends(deps.connection, 2) // only the query's send so far
    expect(deps.connection.sentSqls).toHaveLength(2) // range/rowCount still queued

    // Release the query; assert range starts only after it fully finished.
    deps.connection.resolveSend(1, intTable([42]))
    const queryResponse = await awaitPosted(deps, 2)
    expect(queryResponse.type).toBe('engine/query-result')
    await awaitSends(deps.connection, 3)
    expect(deps.connection.sentSqls[2]).toBe('SELECT * FROM "assay_t1" LIMIT 5 OFFSET 0')

    // Range: window slices arrive correctly via the Arrow API.
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(2, intTable([1, 2, 3, 4, 5]))
    const rangeResponse = await awaitPosted(deps, 3)
    expect(rangeResponse.type).toBe('engine/range-result')
    if (rangeResponse.type === 'engine/range-result') {
      expect(rangeResponse.hasMore).toBe(false)
      expect(firstColumnValues(rangeResponse.batchIpc)).toEqual([1, 2, 3, 4, 5])
    }

    // Row count: BIGINT arrives, converts to a safe number.
    await awaitSends(deps.connection, 4)
    expect(deps.connection.sentSqls[3]).toBe('SELECT count(*)::BIGINT AS row_count FROM "assay_t1"')
    deps.connection.resolveSend(3, countTable(1500n))
    const countResponse = await awaitPosted(deps, 4)
    expect(countResponse).toMatchObject({ type: 'engine/row-count-result', rowCount: 1500 })

    // The collision guard held across the whole burst.
    expect(deps.connection.collisions).toEqual([])
  })

  it('a failing query errors only its own request; a queued op is unaffected', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELEC 1'))
    executor.accept(rangeRequest(3, 0, 2))
    await awaitSends(deps.connection, 2)

    // The query fails at startPendingQuery time (its own gate rejects).
    deps.connection.rejectSend(1, new Error('Parser Error: syntax error at or near "SELEC"'))
    const errorResponse = await awaitPosted(deps, 2)
    expect(errorResponse).toMatchObject({
      type: 'engine/error',
      message: 'Parser Error: syntax error at or near "SELEC"',
    })

    // The queued range then runs on the freed connection and succeeds.
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(2, intTable([1, 2]))
    const rangeResponse = await awaitPosted(deps, 3)
    expect(rangeResponse.type).toBe('engine/range-result')
    if (rangeResponse.type === 'engine/range-result') {
      expect(firstColumnValues(rangeResponse.batchIpc)).toEqual([1, 2])
    }
    expect(deps.connection.collisions).toEqual([])

    // The engine is reusable after the error.
    executor.accept(queryRequest(4, 'SELECT 7 AS value'))
    await awaitSends(deps.connection, 4)
    deps.connection.resolveSend(3, intTable([7]))
    expect(await awaitPosted(deps, 4)).toMatchObject({ type: 'engine/query-result' })
    expect(deps.connection.collisions).toEqual([])
  })

  it('a mid-stream failure errors only its own op, releases the reader, and never corrupts a sibling', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // A query whose SECOND next() rejects (batch one arrives fine) — the same
    // shape as the T1 mid-stream conformance scenario.
    executor.accept(queryRequest(2, 'SELECT i FROM range(5000)'))
    executor.accept(rangeRequest(3, 0, 1)) // sibling, queued behind
    await awaitSends(deps.connection, 2)

    const stream = new FakeStream(intTable(Array.from({ length: 16 }, (_, i) => i)).schema, [
      ...intTable(Array.from({ length: 16 }, (_, i) => i)).batches,
    ])
    stream.failNextAt = 1 // the peek call
    deps.connection.sendAt(1).gate.resolve(stream)

    const errorResponse = await awaitPosted(deps, 2)
    expect(errorResponse).toMatchObject({
      type: 'engine/error',
      message: 'assay fake mid-stream failure',
    })

    // The sibling range still completes with its own correct result.
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(2, intTable([9]))
    const rangeResponse = await awaitPosted(deps, 3)
    if (rangeResponse.type === 'engine/range-result') {
      expect(firstColumnValues(rangeResponse.batchIpc)).toEqual([9])
    }
    expect(deps.connection.collisions).toEqual([])

    // Follow-up query works: the connection was released deterministically.
    executor.accept(queryRequest(4, 'SELECT 5 AS value'))
    await awaitSends(deps.connection, 4)
    deps.connection.resolveSend(3, intTable([5]))
    expect(await awaitPosted(deps, 4)).toMatchObject({ type: 'engine/query-result' })
  })

  it('first-batch transport is unchanged: multi-batch results set hasMore and cancel the tail', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELECT i FROM range(5000)'))
    await awaitSends(deps.connection, 2)
    // A stream with two batches: the peek sees batch two → hasMore=true and
    // cancelSent frees the connection (m1-2 behavior, now under serialization).
    const first = intTable([1, 2, 3]).batches[0]!
    const second = intTable([4, 5, 6]).batches[0]!
    deps.connection.sendAt(1).gate.resolve(new FakeStream(first.schema, [first, second]))
    const response = await awaitPosted(deps, 2)
    expect(response.type).toBe('engine/query-result')
    if (response.type === 'engine/query-result') {
      expect(response.hasMore).toBe(true)
      // Only the FIRST batch is transported; the tail is reported, not sent.
      expect(firstColumnValues(response.batchIpc)).toEqual([1, 2, 3])
    }
    expect(deps.connection.cancelSentCalls).toBe(1)

    executor.accept(queryRequest(3, 'SELECT 9 AS value'))
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(2, intTable([9]))
    const single = await awaitPosted(deps, 3)
    if (single.type === 'engine/query-result') {
      expect(single.hasMore).toBe(false)
      expect(firstColumnValues(single.batchIpc)).toEqual([9])
    }
    // Single-batch result: nothing to free beyond the reader — no cancelSent.
    expect(deps.connection.cancelSentCalls).toBe(1)
    expect(deps.connection.collisions).toEqual([])
  })

  it('an empty stream errors its own op with the honest no-batches message', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELECT 1 AS value WHERE 1 = 0'))
    await awaitSends(deps.connection, 2)
    deps.connection.sendAt(1).gate.resolve(FakeStream.empty())
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'query produced no record batches',
    })
    expect(deps.connection.collisions).toEqual([])

    executor.accept(queryRequest(3, 'SELECT 1 AS value'))
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(2, intTable([1]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
  })

  it('dispose during in-flight ops runs last: in-flight op settles first, then cleanup, then clean errors', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(rangeRequest(2, 1, 3)) // in-flight, held at its send
    executor.accept(disposeRequest(3)) // queued behind the range
    await awaitSends(deps.connection, 2)

    // Dispose must NOT have touched the connection yet (FIFO behind range).
    expect(deps.connection.sentSqls).toHaveLength(2)

    deps.connection.resolveSend(1, intTable([2, 3]))
    const rangeResponse = await awaitPosted(deps, 2)
    expect(rangeResponse.type).toBe('engine/range-result')
    // Dispose's own turn: it drops the view (its send needs releasing), then
    // posts the graceful reply.
    await awaitSends(deps.connection, 3)
    expect(deps.connection.sentSqls[2]).toBe('DROP VIEW IF EXISTS "assay_t1"')
    deps.connection.resolveSend(2, intTable([]))
    const disposedResponse = await awaitPosted(deps, 3)
    expect(disposedResponse).toMatchObject({ type: 'engine/disposed' })
    // Deterministic order: the range result was posted before the disposed
    // reply (FIFO), and the file registration was dropped.
    expect(deps.postedResponses.findIndex((r) => r.requestId === 2)).toBeLessThan(
      deps.postedResponses.findIndex((r) => r.requestId === 3),
    )
    expect(deps.droppedFiles).toEqual(['t1'])

    // Anything after dispose sees an empty registry: a clean per-request
    // error for its own caller — never a crash, never another op's reply.
    executor.accept(rangeRequest(4, 0, 2))
    await flush()
    expect(await awaitPosted(deps, 4)).toMatchObject({
      type: 'engine/error',
      message: 'unknown table handle: t1',
    })
    expect(deps.connection.collisions).toEqual([])
  })

  it('concurrent first ops share one session boot', async () => {
    const { executor, deps } = makeExecutor()
    deps.sessionGate = deferred<void>()

    executor.accept({ type: 'engine/init', requestId: 1 })
    executor.accept(queryRequest(2, 'SELECT 42 AS value'))
    await flush()
    expect(deps.boots).toBe(1) // the init op's boot
    expect(deps.bootCalls).toBe(1) // the query op is still queued behind init

    deps.sessionGate.resolve(undefined)
    const ready = await awaitPosted(deps, 1)
    expect(ready).toMatchObject({ type: 'engine/ready', duckdbVersion: 'vX-test' })

    await awaitSends(deps.connection, 1)
    deps.connection.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })
    // Both ops called ensureSession but only ONE boot happened (memoized).
    expect(deps.boots).toBe(1)
    expect(deps.bootCalls).toBe(2)
    expect(deps.connection.collisions).toEqual([])
  })

  it('a failed open rolls back its registration and never blocks the queued op', async () => {
    const { executor, deps } = makeExecutor()

    executor.accept(openRequest(1))
    executor.accept(queryRequest(2, 'SELECT 42 AS value'))
    await awaitSends(deps.connection, 1) // CREATE VIEW (open is first in FIFO)

    // View creation fails → open rolls back: registry entry removed, file
    // dropped — and the queued query runs untouched afterwards.
    deps.connection.rejectSend(0, new Error('Parquet magic bytes not found'))
    expect(await awaitPosted(deps, 1)).toMatchObject({
      type: 'engine/error',
      message: 'Parquet magic bytes not found',
    })
    expect(deps.droppedFiles).toEqual(['t1'])

    await awaitSends(deps.connection, 2)
    expect(deps.connection.sentSqls[1]).toBe('SELECT 42 AS value')
    deps.connection.resolveSend(1, intTable([42]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })

    // The rolled-back handle is gone; a retry open takes the NEXT id (t2) —
    // no collision with the phantom t1.
    executor.accept(openRequest(3))
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(2, intTable([]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/open-result', tableId: 't2' })
    expect(deps.connection.collisions).toEqual([])
  })

  it('an invalid row window errors its own op without ever touching the connection', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(rangeRequest(2, 5, 2)) // inverted window
    executor.accept(queryRequest(3, 'SELECT 1 AS value'))
    await awaitSends(deps.connection, 2)
    // The only send so far is the queued query — the invalid range never
    // reached the connection.
    expect(deps.connection.sentSqls[1]).toBe('SELECT 1 AS value')

    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'invalid row window: endRow must be greater than or equal to startRow',
    })
    deps.connection.resolveSend(1, intTable([1]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expect(deps.connection.collisions).toEqual([])
  })

  it('schema passthrough runs serialized between other ops and reports DuckDB types verbatim', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELECT 42 AS value'))
    executor.accept(schemaRequest(3))
    await awaitSends(deps.connection, 2)
    deps.connection.resolveSend(1, intTable([42]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })

    await awaitSends(deps.connection, 3)
    expect(deps.connection.sentSqls[2]).toBe('DESCRIBE "assay_t1"')
    deps.connection.resolveSend(2, describeTable())
    const schemaResponse = await awaitPosted(deps, 3)
    expect(schemaResponse).toMatchObject({
      type: 'engine/schema-result',
      columns: [
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'country', type: 'VARCHAR' },
      ],
    })
    expect(deps.connection.collisions).toEqual([])
  })

  it('oversized range windows are re-clamped in the SQL the executor builds', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(rangeRequest(2, 10_000, 10_000_000))
    await awaitSends(deps.connection, 2)
    // LIMIT capped to MAX_RANGE_ROWS, OFFSET preserved.
    expect(deps.connection.sentSqls[1]).toBe('SELECT * FROM "assay_t1" LIMIT 1000 OFFSET 10000')
    deps.connection.resolveSend(1, intTable([]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/range-result' })
    expect(deps.connection.collisions).toEqual([])
  })
})

// ---- m2-2: filtered/sorted windows and filtered row counts ----

/** Range request carrying filter/sort specs (the raw protocol shape). */
function filteredRangeRequest(
  id: number,
  extra: {
    startRow?: number
    endRow?: number
    filters?: Array<{ column: string; predicate: string }>
    sort?: Array<{ column: string; direction: 'asc' | 'desc' }>
    columns?: string[]
  },
): EngineRequest {
  return {
    type: 'engine/range',
    requestId: id,
    tableId: 't1',
    startRow: extra.startRow ?? 0,
    endRow: extra.endRow ?? 5,
    ...(extra.filters === undefined ? {} : { filters: extra.filters }),
    ...(extra.sort === undefined ? {} : { sort: extra.sort }),
    ...(extra.columns === undefined ? {} : { columns: extra.columns }),
  }
}

function filteredRowCountRequest(
  id: number,
  filters?: Array<{ column: string; predicate: string }>,
): EngineRequest {
  return {
    type: 'engine/row-count',
    requestId: id,
    tableId: 't1',
    ...(filters === undefined ? {} : { filters }),
  }
}

describe('EngineOpExecutor filtered/sorted windows (m2-2)', () => {
  it('composes filtered+sorted window SQL over the registered view and streams the result', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(
      filteredRangeRequest(2, {
        filters: [
          { column: 'country', predicate: "= 'US'" },
          { column: 'income', predicate: '> 50000' },
        ],
        sort: [{ column: 'income', direction: 'desc' }],
      }),
    )
    await awaitSends(deps.connection, 2)
    // Predicates are WHERE content; the column identifiers are quoted; the
    // view name is the engine-generated one.
    expect(deps.connection.sentSqls[1]).toBe(
      'SELECT * FROM "assay_t1" ' +
        `WHERE ("country" = 'US') AND ("income" > 50000) ` +
        'ORDER BY "income" desc ' +
        'LIMIT 5 OFFSET 0',
    )
    deps.connection.resolveSend(1, intTable([5, 2]))
    const response = await awaitPosted(deps, 2)
    expect(response.type).toBe('engine/range-result')
    if (response.type === 'engine/range-result') {
      expect(response.hasMore).toBe(false)
      expect(firstColumnValues(response.batchIpc)).toEqual([5, 2])
    }
    expect(deps.connection.collisions).toEqual([])
  })

  it('composes byte-identical legacy SQL when filters/sort are absent or empty', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(filteredRangeRequest(2, { filters: [], sort: [] }))
    await awaitSends(deps.connection, 2)
    expect(deps.connection.sentSqls[1]).toBe('SELECT * FROM "assay_t1" LIMIT 5 OFFSET 0')
    deps.connection.resolveSend(1, intTable([1, 2, 3, 4, 5]))

    executor.accept(filteredRowCountRequest(3, []))
    await awaitSends(deps.connection, 3)
    expect(deps.connection.sentSqls[2]).toBe('SELECT count(*)::BIGINT AS row_count FROM "assay_t1"')
    deps.connection.resolveSend(2, countTable(5n))
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/row-count-result',
      rowCount: 5,
    })
    expect(deps.connection.collisions).toEqual([])
  })

  it('re-clamps oversized windows with filters present (LIMIT capped, WHERE kept)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(
      filteredRangeRequest(2, {
        startRow: 500,
        endRow: 10_000_000,
        filters: [{ column: 'income', predicate: 'IS NOT NULL' }],
      }),
    )
    await awaitSends(deps.connection, 2)
    expect(deps.connection.sentSqls[1]).toBe(
      'SELECT * FROM "assay_t1" WHERE ("income" IS NOT NULL) LIMIT 1000 OFFSET 500',
    )
    deps.connection.resolveSend(1, intTable([]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/range-result' })
    expect(deps.connection.collisions).toEqual([])
  })

  it('composes the filtered count SQL for engine/row-count', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(filteredRowCountRequest(2, [{ column: 'income', predicate: '> 50000' }]))
    await awaitSends(deps.connection, 2)
    expect(deps.connection.sentSqls[1]).toBe(
      'SELECT count(*)::BIGINT AS row_count FROM "assay_t1" WHERE ("income" > 50000)',
    )
    deps.connection.resolveSend(1, countTable(3n))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/row-count-result',
      rowCount: 3,
    })
    expect(deps.connection.collisions).toEqual([])
  })

  it('a failing predicate errors only its own op with the engine message and the engine stays usable', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(
      filteredRangeRequest(2, { filters: [{ column: 'income', predicate: ')) FROM ((' }] }),
    )
    executor.accept(filteredRowCountRequest(3, [{ column: 'income', predicate: '> 1' }]))
    await awaitSends(deps.connection, 2)

    deps.connection.rejectSend(1, new Error('Parser Error: syntax error at or near "))"'))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'Parser Error: syntax error at or near "))"',
    })

    // The queued filtered count runs afterwards on the freed connection.
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(2, countTable(4n))
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/row-count-result',
      rowCount: 4,
    })
    expect(deps.connection.collisions).toEqual([])
  })

  it('silently drops requests whose filters/sort arrive malformed (no reply, no send)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(
      filteredRangeRequest(2, {
        startRow: 0,
        endRow: 5,
        // Raw hostile message: filter spec missing its predicate string.
        filters: [{ column: 'income' } as unknown as { column: string; predicate: string }],
      }),
    )
    await flush()
    expect(deps.connection.sentSqls).toHaveLength(1) // only the open's CREATE VIEW
    expect(deps.postedResponses.find((response) => response.requestId === 2)).toBeUndefined()

    // The channel was never occupied by the dropped message: a follow-up op runs.
    executor.accept(queryRequest(3, 'SELECT 42 AS value'))
    await awaitSends(deps.connection, 2)
    deps.connection.resolveSend(1, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expect(deps.connection.collisions).toEqual([])
  })
})

// ---- m2-5: dataset profiling ----

function profileRequest(id: number, tableId = 't1'): EngineRequest {
  return { type: 'engine/profile', requestId: id, tableId }
}

/** DESCRIBE-shaped table for a numeric-only schema (id BIGINT). */
function numericOnlyDescribeTable(): Table {
  return tableFromArrays({ column_name: ['id'], column_type: ['BIGINT'] })
}

/**
 * The one-row base-aggregate result for the flat schema (customer_id BIGINT
 * numeric + country VARCHAR categorical): slot layout per profile-query.ts —
 * row count, then the numeric block (nn, distinct, min, max, mean, stddev,
 * DOUBLE[4] quantiles), then the plain block (nn, distinct).
 */
function profileBaseTable(row: {
  rowCount: bigint
  id: {
    nn: bigint
    d: bigint
    min: number
    max: number
    mean: number
    std: number
    q: readonly [number, number, number, number]
  }
  country: { nn: bigint; d: bigint }
}): Table {
  return tableFromArrays({
    c0: BigInt64Array.from([row.rowCount]),
    c1: BigInt64Array.from([row.id.nn]),
    c2: BigInt64Array.from([row.id.d]),
    c3: Float64Array.from([row.id.min]),
    c4: Float64Array.from([row.id.max]),
    c5: Float64Array.from([row.id.mean]),
    c6: Float64Array.from([row.id.std]),
    c7: [row.id.q],
    c8: BigInt64Array.from([row.country.nn]),
    c9: BigInt64Array.from([row.country.d]),
  })
}

/** A top-k result (`"v"` rendered values + `"n"` BIGINT counts). */
function topKTable(entries: ReadonlyArray<readonly [string, bigint]>): Table {
  return tableFromArrays({
    v: entries.map(([value]) => value),
    n: BigInt64Array.from(entries.map(([, count]) => count)),
  })
}

describe('EngineOpExecutor profile (m2-5)', () => {
  it('composes DESCRIBE + ONE base aggregate + one top-k scan per categorical column and posts the assembled stats', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2))
    // Send 2: DESCRIBE (metadata only).
    await awaitSends(deps.connection, 2)
    expect(deps.connection.sentSqls[1]).toBe('DESCRIBE "assay_t1"')
    deps.connection.resolveSend(1, describeTable())

    // Send 3: the combined base aggregate — the single data scan (all
    // nulls/distinct/numeric stats of both columns in one query).
    await awaitSends(deps.connection, 3)
    expect(deps.connection.sentSqls[2]).toBe(
      'SELECT count(*)::BIGINT AS "c0", ' +
        'count("customer_id")::BIGINT AS "c1", count(DISTINCT "customer_id")::BIGINT AS "c2", ' +
        'min("customer_id")::DOUBLE AS "c3", max("customer_id")::DOUBLE AS "c4", ' +
        'avg("customer_id")::DOUBLE AS "c5", stddev_samp("customer_id")::DOUBLE AS "c6", ' +
        'quantile_cont("customer_id", [0.5,0.9,0.95,0.99])::DOUBLE[] AS "c7", ' +
        'count("country")::BIGINT AS "c8", count(DISTINCT "country")::BIGINT AS "c9" ' +
        'FROM "assay_t1"',
    )
    deps.connection.resolveSend(
      2,
      profileBaseTable({
        rowCount: 5n,
        id: {
          nn: 5n,
          d: 5n,
          min: 1,
          max: 5,
          mean: 3,
          std: 1.5811388300841898,
          q: [3, 4.6, 4.8, 4.96],
        },
        country: { nn: 4n, d: 3n }, // one NULL country → nullCount 1
      }),
    )

    // Send 4: exactly one top-k scan — for the categorical column only.
    await awaitSends(deps.connection, 4)
    expect(deps.connection.sentSqls[3]).toBe(
      'SELECT CAST("country" AS VARCHAR) AS "v", count(*)::BIGINT AS "n" ' +
        'FROM "assay_t1" WHERE "country" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 10',
    )
    deps.connection.resolveSend(
      3,
      topKTable([
        ['SG', 2n],
        ['US', 2n],
        ['DE', 1n],
      ]),
    )

    const response = await awaitPosted(deps, 2)
    expect(response).toEqual({
      type: 'engine/profile-result',
      requestId: 2,
      rowCount: 5,
      columns: [
        {
          name: 'customer_id',
          type: 'BIGINT',
          kind: 'numeric',
          nullCount: 0,
          distinctCount: 5,
          numeric: {
            min: 1,
            max: 5,
            mean: 3,
            stddev: 1.5811388300841898,
            quantiles: { p50: 3, p90: 4.6, p95: 4.8, p99: 4.96 },
          },
        },
        {
          name: 'country',
          type: 'VARCHAR',
          kind: 'categorical',
          nullCount: 1,
          distinctCount: 3,
          categorical: {
            topK: [
              { value: 'SG', count: 2 },
              { value: 'US', count: 2 },
              { value: 'DE', count: 1 },
            ],
          },
        },
      ],
    })
    expect(deps.connection.collisions).toEqual([])
  })

  it('a numeric-only schema sends exactly the DESCRIBE + base scan (no top-k)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2))
    await awaitSends(deps.connection, 2)
    deps.connection.resolveSend(1, numericOnlyDescribeTable())
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(
      2,
      tableFromArrays({
        c0: BigInt64Array.from([3n]),
        c1: BigInt64Array.from([3n]),
        c2: BigInt64Array.from([3n]),
        c3: Float64Array.from([10]),
        c4: Float64Array.from([30]),
        c5: Float64Array.from([20]),
        c6: Float64Array.from([10]),
        c7: [[20, 20, 20, 20]],
      }),
    )
    // The profile completes without any further send: no categorical column,
    // no top-k query — the documented 1-scan minimum.
    const response = await awaitPosted(deps, 2)
    expect(response).toMatchObject({
      type: 'engine/profile-result',
      rowCount: 3,
      columns: [
        {
          name: 'id',
          kind: 'numeric',
          nullCount: 0,
          distinctCount: 3,
          numeric: { quantiles: { p50: 20, p90: 20, p95: 20, p99: 20 } },
        },
      ],
    })
    expect(deps.connection.sentSqls).toHaveLength(3)
    expect(deps.connection.collisions).toEqual([])
  })

  it('profiles of unknown handles error their own op without ever touching the connection', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2, 'nope'))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'unknown table handle: nope',
    })
    expect(deps.connection.sentSqls).toHaveLength(1) // only the open's CREATE VIEW

    // The engine is reusable: a real profile still answers.
    executor.accept(profileRequest(3))
    await awaitSends(deps.connection, 2)
    deps.connection.resolveSend(1, describeTable())
    await awaitSends(deps.connection, 3)
    deps.connection.resolveSend(
      2,
      profileBaseTable({
        rowCount: 5n,
        id: { nn: 5n, d: 5n, min: 1, max: 5, mean: 3, std: 1.58, q: [3, 4.6, 4.8, 4.96] },
        country: { nn: 5n, d: 3n },
      }),
    )
    await awaitSends(deps.connection, 4)
    deps.connection.resolveSend(3, topKTable([['SG', 2n]]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/profile-result' })
    expect(deps.connection.collisions).toEqual([])
  })

  it('a malformed aggregate slot fails the op loudly and the engine stays usable', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2))
    await awaitSends(deps.connection, 2)
    deps.connection.resolveSend(1, describeTable())
    await awaitSends(deps.connection, 3)
    // A count slot arriving as a string is an engine deviation: the op fails
    // loudly instead of leaking a bogus stat into the response.
    deps.connection.resolveSend(
      2,
      tableFromArrays({
        c0: ['not-a-count'],
        c1: BigInt64Array.from([5n]),
        c2: BigInt64Array.from([5n]),
        c3: Float64Array.from([1]),
        c4: Float64Array.from([5]),
        c5: Float64Array.from([3]),
        c6: Float64Array.from([1.58]),
        c7: [[3, 4.6, 4.8, 4.96]],
        c8: BigInt64Array.from([5n]),
        c9: BigInt64Array.from([3n]),
      }),
    )
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'profile aggregate returned an unexpected shape',
    })

    // The channel/connection were never wedged: a follow-up query answers.
    executor.accept(queryRequest(3, 'SELECT 42 AS value'))
    await awaitSends(deps.connection, 4)
    deps.connection.resolveSend(3, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expect(deps.connection.collisions).toEqual([])
  })
})
