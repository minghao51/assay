import { Table, tableFromArrays, tableFromIPC } from 'apache-arrow'
import type { RecordBatch } from 'apache-arrow'
import { baseRowId, insertRowId } from '@assay/domain'
import type { EditOp } from '@assay/domain'
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
 * T2 worker-side concurrency tests, two lanes since m2-7: interleaved
 * query/fetchRange/rowCount/schema/dispose driven through the real executor
 * (`EngineOpExecutor`) — the exact class the worker entry wires to
 * DuckDB-WASM — against TWO fake connections (one per lane) that model
 * duckdb-wasm 1.32's single-pending-query-per-connection constraint.
 *
 * Determinism: every connection `send` parks on an explicitly-resolved gate,
 * so interleavings are scripted step by step — no timers, no real DuckDB.
 *
 * The collision guard: each fake connection records `busy` from a `send` (or
 * `query`, which is send + drain) until the reader is drained and cancelled.
 * A second `send`/`query` while busy pushes into that connection's
 * `collisions` and throws — so ANY test that lets two operations overlap on
 * one connection fails loudly. Every test asserts `collisions` stays empty on
 * BOTH lanes; cross-lane overlap (query lane vs registry lane) is legitimate
 * since m2-7 and is exactly what the two-lane tests pin.
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
  /** Registry-lane connection: open/schema/range/rowCount/dispose. */
  readonly conn = new FakeConnection()
  /** Query-lane connection: engine/query + engine/profile (m2-7). */
  readonly queryConn = new FakeConnection()
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
        conn: this.conn,
        queryConn: this.queryConn,
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

  // m4-2 export seams: the wasm-side byte read + the OPFS scratch write.
  readonly copiedExportBytes: string[] = []
  readonly writtenExports: Array<{ path: string; bytes: Uint8Array }> = []
  copyExportBytesError: unknown = null

  copyExportBytes(registeredFileName: string): Promise<Uint8Array> {
    this.copiedExportBytes.push(registeredFileName)
    if (this.copyExportBytesError !== null) return Promise.reject(this.copyExportBytesError)
    return Promise.resolve(new TextEncoder().encode('assay-export-bytes'))
  }

  writeExportFile(path: string, bytes: Uint8Array): Promise<void> {
    this.writtenExports.push({ path, bytes })
    return Promise.resolve()
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

/** Both lanes' collision guards, for the standard closing assertion. */
function expectNoCollisions(deps: FakeDeps): void {
  expect(deps.conn.collisions, 'registry-lane collisions').toEqual([])
  expect(deps.queryConn.collisions, 'query-lane collisions').toEqual([])
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
    throw new Error(
      `expected ${count} sends, saw ${connection.sentSqls.length} ` +
        `(${connection.sentSqls.join(' | ')})`,
    )
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
  await awaitSends(deps.conn, 1) // CREATE VIEW "assay_t1" … (registry lane)
  expect(deps.conn.sentSqls[0]).toMatch(/CREATE VIEW "assay_t1"/)
  deps.conn.resolveSend(0, intTable([]))
  const posted = await awaitPosted(deps, 1)
  expect(posted).toMatchObject({ type: 'engine/open-result', tableId: 't1', format: 'parquet' })
}

describe('EngineOpExecutor two-lane concurrency (T2 guarantees, m2-7 lanes)', () => {
  it('an interactive burst on the registry lane completes while a long query is parked on the query lane (m2-7 head-of-line relief)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // The long query parks at its send gate (query lane)…
    executor.accept(queryRequest(2, 'SELECT sum(a.i * b.i) FROM range(20000) a, range(20000) b'))
    await awaitSends(deps.queryConn, 1)
    // …and the registry lane is NOT blocked by it: the window and count ops
    // start (and complete) while the query is still pending.
    executor.accept(rangeRequest(3, 0, 5))
    executor.accept(rowCountRequest(4))
    await awaitSends(deps.conn, 2) // range SQL + count SQL (registry lane)
    expect(deps.conn.sentSqls[1]).toBe('SELECT * FROM "assay_t1" LIMIT 5 OFFSET 0')
    deps.conn.resolveSend(1, intTable([1, 2, 3, 4, 5]))
    const rangeResponse = await awaitPosted(deps, 3)
    expect(rangeResponse.type).toBe('engine/range-result')
    if (rangeResponse.type === 'engine/range-result') {
      expect(firstColumnValues(rangeResponse.batchIpc)).toEqual([1, 2, 3, 4, 5])
    }
    deps.conn.resolveSend(2, countTable(5n))
    expect(await awaitPosted(deps, 4)).toMatchObject({
      type: 'engine/row-count-result',
      rowCount: 5,
    })

    // Registry-lane registry-window per-lane FIFO: rowCount ran only after
    // the range finished (they shared the lane).
    expect(deps.conn.sentSqls[2]).toBe('SELECT count(*)::BIGINT AS row_count FROM "assay_t1"')

    // The query was never touched by the burst; it settles last, correctly.
    expect(deps.queryConn.sentSqls).toHaveLength(1)
    expect(deps.postedResponses.find((response) => response.requestId === 2)).toBeUndefined()
    deps.queryConn.resolveSend(0, intTable([42]))
    const queryResponse = await awaitPosted(deps, 2)
    expect(queryResponse.type).toBe('engine/query-result')
    if (queryResponse.type === 'engine/query-result') {
      expect(firstColumnValues(queryResponse.batchIpc)).toEqual([42])
    }
    expectNoCollisions(deps)
  })

  it('queries serialize per lane: a second query only starts after the first settles', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELECT 41 AS value'))
    executor.accept(queryRequest(3, 'SELECT 1 AS value'))
    await awaitSends(deps.queryConn, 1)
    // Per-lane FIFO (T2): the second query cannot be pending on the same
    // connection while the first holds its pending-query slot.
    expect(deps.queryConn.sentSqls).toHaveLength(1)
    deps.queryConn.resolveSend(0, intTable([41]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })
    await awaitSends(deps.queryConn, 2)
    expect(deps.queryConn.sentSqls[1]).toBe('SELECT 1 AS value')
    deps.queryConn.resolveSend(1, intTable([1]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('a failing query errors only its own request; a concurrent registry-lane op is unaffected', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELEC 1'))
    executor.accept(rangeRequest(3, 0, 2))
    // Different lanes: both sends happen concurrently.
    await awaitSends(deps.queryConn, 1)
    await awaitSends(deps.conn, 2)

    // The query fails at startPendingQuery time (its own gate rejects).
    deps.queryConn.rejectSend(0, new Error('Parser Error: syntax error at or near "SELEC"'))
    const errorResponse = await awaitPosted(deps, 2)
    expect(errorResponse).toMatchObject({
      type: 'engine/error',
      message: 'Parser Error: syntax error at or near "SELEC"',
    })

    // The concurrent range on the other lane runs and succeeds regardless.
    deps.conn.resolveSend(1, intTable([1, 2]))
    const rangeResponse = await awaitPosted(deps, 3)
    expect(rangeResponse.type).toBe('engine/range-result')
    if (rangeResponse.type === 'engine/range-result') {
      expect(firstColumnValues(rangeResponse.batchIpc)).toEqual([1, 2])
    }

    // The query LANE itself is reusable after the error (per-lane T2
    // guarantee: the lane tail always settles).
    executor.accept(queryRequest(4, 'SELECT 7 AS value'))
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, intTable([7]))
    expect(await awaitPosted(deps, 4)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('a mid-stream failure errors only its own op, releases the reader, and never corrupts the other lane', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // A query whose SECOND next() rejects (batch one arrives fine) — the same
    // shape as the T1 mid-stream conformance scenario.
    executor.accept(queryRequest(2, 'SELECT i FROM range(5000)'))
    executor.accept(rangeRequest(3, 0, 1)) // sibling, on the registry lane
    await awaitSends(deps.queryConn, 1)
    await awaitSends(deps.conn, 2)

    const stream = new FakeStream(intTable(Array.from({ length: 16 }, (_, i) => i)).schema, [
      ...intTable(Array.from({ length: 16 }, (_, i) => i)).batches,
    ])
    stream.failNextAt = 1 // the peek call
    deps.queryConn.sendAt(0).gate.resolve(stream)

    const errorResponse = await awaitPosted(deps, 2)
    expect(errorResponse).toMatchObject({
      type: 'engine/error',
      message: 'assay fake mid-stream failure',
    })

    // The sibling range on the other lane still completes with its own
    // correct result.
    deps.conn.resolveSend(1, intTable([9]))
    const rangeResponse = await awaitPosted(deps, 3)
    if (rangeResponse.type === 'engine/range-result') {
      expect(firstColumnValues(rangeResponse.batchIpc)).toEqual([9])
    }

    // Follow-up query works: the query-lane connection was released
    // deterministically.
    executor.accept(queryRequest(4, 'SELECT 5 AS value'))
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, intTable([5]))
    expect(await awaitPosted(deps, 4)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('first-batch transport is unchanged: multi-batch results set hasMore and cancel the tail', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELECT i FROM range(5000)'))
    await awaitSends(deps.queryConn, 1)
    // A stream with two batches: the peek sees batch two → hasMore=true and
    // cancelSent frees the connection (m1-2 behavior, now on the query lane).
    const first = intTable([1, 2, 3]).batches[0]!
    const second = intTable([4, 5, 6]).batches[0]!
    deps.queryConn.sendAt(0).gate.resolve(new FakeStream(first.schema, [first, second]))
    const response = await awaitPosted(deps, 2)
    expect(response.type).toBe('engine/query-result')
    if (response.type === 'engine/query-result') {
      expect(response.hasMore).toBe(true)
      // Only the FIRST batch is transported; the tail is reported, not sent.
      expect(firstColumnValues(response.batchIpc)).toEqual([1, 2, 3])
    }
    expect(deps.queryConn.cancelSentCalls).toBe(1)

    executor.accept(queryRequest(3, 'SELECT 9 AS value'))
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, intTable([9]))
    const single = await awaitPosted(deps, 3)
    if (single.type === 'engine/query-result') {
      expect(single.hasMore).toBe(false)
      expect(firstColumnValues(single.batchIpc)).toEqual([9])
    }
    // Single-batch result: nothing to free beyond the reader — no cancelSent.
    expect(deps.queryConn.cancelSentCalls).toBe(1)
    expectNoCollisions(deps)
  })

  it('an empty stream errors its own op with the honest no-batches message', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELECT 1 AS value WHERE 1 = 0'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.sendAt(0).gate.resolve(FakeStream.empty())
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'query produced no record batches',
    })

    executor.accept(queryRequest(3, 'SELECT 1 AS value'))
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, intTable([1]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('dispose during in-flight registry ops runs last on its lane: in-flight op settles first, then cleanup, then clean errors', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(rangeRequest(2, 1, 3)) // in-flight on the registry lane
    executor.accept(disposeRequest(3)) // queued behind the range (same lane)
    await awaitSends(deps.conn, 2)

    // Dispose must NOT have touched the connection yet (FIFO behind range).
    expect(deps.conn.sentSqls).toHaveLength(2)

    deps.conn.resolveSend(1, intTable([2, 3]))
    const rangeResponse = await awaitPosted(deps, 2)
    expect(rangeResponse.type).toBe('engine/range-result')
    // Dispose's own turn: the query-lane barrier resolves immediately (empty
    // lane), it drops the view (its send needs releasing), then posts the
    // graceful reply.
    await awaitSends(deps.conn, 3)
    expect(deps.conn.sentSqls[2]).toBe('DROP VIEW IF EXISTS "assay_t1"')
    deps.conn.resolveSend(2, intTable([]))
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
    expectNoCollisions(deps)
  })

  it('dispose waits for an in-flight query (query-lane barrier) before dropping views', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELECT i FROM range(5000)')) // parked
    await awaitSends(deps.queryConn, 1)
    executor.accept(disposeRequest(3))
    await flush()
    // The barrier holds: no DROP VIEW while the query is still in flight.
    expect(deps.conn.sentSqls).toHaveLength(1) // only the open's CREATE VIEW
    expect(deps.postedResponses.find((response) => response.requestId === 3)).toBeUndefined()

    // The query settles, and only then does dispose drop the view on the
    // registry lane.
    deps.queryConn.resolveSend(0, intTable([1]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })
    await awaitSends(deps.conn, 2)
    expect(deps.conn.sentSqls[1]).toBe('DROP VIEW IF EXISTS "assay_t1"')
    deps.conn.resolveSend(1, intTable([]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/disposed' })
    expect(deps.droppedFiles).toEqual(['t1'])
    expectNoCollisions(deps)
  })

  it('dispose barrier also waits for a failing query before dropping views', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELEC 1'))
    await awaitSends(deps.queryConn, 1)
    executor.accept(disposeRequest(3))
    await flush()
    expect(deps.conn.sentSqls).toHaveLength(1)

    // Even a failing query gates the barrier: its error reaches its own
    // caller, the lane tail settles, and dispose proceeds.
    deps.queryConn.rejectSend(0, new Error('Parser Error: syntax error at or near "SELEC"'))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/error' })
    await awaitSends(deps.conn, 2)
    deps.conn.resolveSend(1, intTable([]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/disposed' })
    expectNoCollisions(deps)
  })

  it('concurrent first ops share one session boot', async () => {
    const { executor, deps } = makeExecutor()
    deps.sessionGate = deferred<void>()

    executor.accept({ type: 'engine/init', requestId: 1 })
    executor.accept(queryRequest(2, 'SELECT 42 AS value'))
    await flush()
    expect(deps.boots).toBe(1) // the init op's boot
    // Both lanes dispatched; the query lane's ensureSession is memoized.
    expect(deps.bootCalls).toBe(2)

    deps.sessionGate.resolve(undefined)
    const ready = await awaitPosted(deps, 1)
    expect(ready).toMatchObject({ type: 'engine/ready', duckdbVersion: 'vX-test' })

    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })
    // Both ops called ensureSession but only ONE boot happened (memoized).
    expect(deps.boots).toBe(1)
    expect(deps.bootCalls).toBe(2)
    expectNoCollisions(deps)
  })

  it('a failed open rolls back its registration and never blocks the queued registry-lane op', async () => {
    const { executor, deps } = makeExecutor()

    executor.accept(openRequest(1))
    executor.accept(rowCountRequest(2)) // queued behind the open on the registry lane
    await awaitSends(deps.conn, 1) // CREATE VIEW (open is first in the lane)

    // View creation fails → open rolls back: registry entry removed, file
    // dropped — and the lane tail settles for the queued op.
    deps.conn.rejectSend(0, new Error('Parquet magic bytes not found'))
    expect(await awaitPosted(deps, 1)).toMatchObject({
      type: 'engine/error',
      message: 'Parquet magic bytes not found',
    })
    expect(deps.droppedFiles).toEqual(['t1'])

    // The rolled-back handle is gone: the queued op gets a clean per-request
    // error of its own (not a phantom success over the removed entry), and it
    // never touches the connection — the handle check precedes any SQL.
    expect(deps.conn.sentSqls).toHaveLength(1) // only the failed open's CREATE VIEW
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'unknown table handle: t1',
    })

    // A retry open takes the NEXT id (t2) — no collision with the phantom t1.
    executor.accept(openRequest(3))
    await awaitSends(deps.conn, 2)
    deps.conn.resolveSend(1, intTable([]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/open-result', tableId: 't2' })
    expectNoCollisions(deps)
  })

  it('an invalid row window errors its own op without ever touching its lane', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(rangeRequest(2, 5, 2)) // inverted window
    executor.accept(queryRequest(3, 'SELECT 1 AS value'))
    await awaitSends(deps.queryConn, 1)
    // The invalid range never reached the registry lane: the only traffic
    // there is the open's CREATE VIEW. The query runs on the query lane.
    expect(deps.conn.sentSqls).toHaveLength(1)
    expect(deps.queryConn.sentSqls[0]).toBe('SELECT 1 AS value')

    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'invalid row window: endRow must be greater than or equal to startRow',
    })
    deps.queryConn.resolveSend(0, intTable([1]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('schema runs on the registry lane, serialized with the other registry ops, reporting DuckDB types verbatim', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(schemaRequest(2))
    executor.accept(rowCountRequest(3)) // queued behind the schema (same lane)
    await awaitSends(deps.conn, 2)
    expect(deps.queryConn.sentSqls).toHaveLength(0) // the query lane is idle
    expect(deps.conn.sentSqls[1]).toBe('DESCRIBE "assay_t1"')
    deps.conn.resolveSend(1, describeTable())
    const schemaResponse = await awaitPosted(deps, 2)
    expect(schemaResponse).toMatchObject({
      type: 'engine/schema-result',
      columns: [
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'country', type: 'VARCHAR' },
      ],
    })

    // Per-lane FIFO: the count starts only after the schema finished.
    await awaitSends(deps.conn, 3)
    deps.conn.resolveSend(2, countTable(5n))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/row-count-result' })
    expectNoCollisions(deps)
  })

  it('oversized range windows are re-clamped in the SQL the executor builds', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(rangeRequest(2, 10_000, 10_000_000))
    await awaitSends(deps.conn, 2)
    // LIMIT capped to MAX_RANGE_ROWS, OFFSET preserved.
    expect(deps.conn.sentSqls[1]).toBe('SELECT * FROM "assay_t1" LIMIT 1000 OFFSET 10000')
    deps.conn.resolveSend(1, intTable([]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/range-result' })
    expectNoCollisions(deps)
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
    await awaitSends(deps.conn, 2)
    // Predicates are WHERE content; the column identifiers are quoted; the
    // view name is the engine-generated one.
    expect(deps.conn.sentSqls[1]).toBe(
      'SELECT * FROM "assay_t1" ' +
        `WHERE ("country" = 'US') AND ("income" > 50000) ` +
        'ORDER BY "income" desc ' +
        'LIMIT 5 OFFSET 0',
    )
    deps.conn.resolveSend(1, intTable([5, 2]))
    const response = await awaitPosted(deps, 2)
    expect(response.type).toBe('engine/range-result')
    if (response.type === 'engine/range-result') {
      expect(response.hasMore).toBe(false)
      expect(firstColumnValues(response.batchIpc)).toEqual([5, 2])
    }
    expectNoCollisions(deps)
  })

  it('composes byte-identical legacy SQL when filters/sort are absent or empty', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(filteredRangeRequest(2, { filters: [], sort: [] }))
    await awaitSends(deps.conn, 2)
    expect(deps.conn.sentSqls[1]).toBe('SELECT * FROM "assay_t1" LIMIT 5 OFFSET 0')
    deps.conn.resolveSend(1, intTable([1, 2, 3, 4, 5]))

    executor.accept(filteredRowCountRequest(3, []))
    await awaitSends(deps.conn, 3)
    expect(deps.conn.sentSqls[2]).toBe('SELECT count(*)::BIGINT AS row_count FROM "assay_t1"')
    deps.conn.resolveSend(2, countTable(5n))
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/row-count-result',
      rowCount: 5,
    })
    expectNoCollisions(deps)
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
    await awaitSends(deps.conn, 2)
    expect(deps.conn.sentSqls[1]).toBe(
      'SELECT * FROM "assay_t1" WHERE ("income" IS NOT NULL) LIMIT 1000 OFFSET 500',
    )
    deps.conn.resolveSend(1, intTable([]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/range-result' })
    expectNoCollisions(deps)
  })

  it('composes the filtered count SQL for engine/row-count', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(filteredRowCountRequest(2, [{ column: 'income', predicate: '> 50000' }]))
    await awaitSends(deps.conn, 2)
    expect(deps.conn.sentSqls[1]).toBe(
      'SELECT count(*)::BIGINT AS row_count FROM "assay_t1" WHERE ("income" > 50000)',
    )
    deps.conn.resolveSend(1, countTable(3n))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/row-count-result',
      rowCount: 3,
    })
    expectNoCollisions(deps)
  })

  it('a failing predicate errors only its own op with the engine message and the engine stays usable', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(
      filteredRangeRequest(2, { filters: [{ column: 'income', predicate: ')) FROM ((' }] }),
    )
    executor.accept(filteredRowCountRequest(3, [{ column: 'income', predicate: '> 1' }]))
    await awaitSends(deps.conn, 2)

    deps.conn.rejectSend(1, new Error('Parser Error: syntax error at or near "))"'))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'Parser Error: syntax error at or near "))"',
    })

    // The queued filtered count runs afterwards on the freed registry-lane
    // connection.
    await awaitSends(deps.conn, 3)
    deps.conn.resolveSend(2, countTable(4n))
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/row-count-result',
      rowCount: 4,
    })
    expectNoCollisions(deps)
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
    expect(deps.conn.sentSqls).toHaveLength(1) // only the open's CREATE VIEW
    expect(deps.postedResponses.find((response) => response.requestId === 2)).toBeUndefined()

    // The lane was never occupied by the dropped message: a follow-up query
    // runs on the query lane.
    executor.accept(queryRequest(3, 'SELECT 42 AS value'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
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

describe('EngineOpExecutor profile (m2-5; query lane since m2-7)', () => {
  it('composes DESCRIBE + ONE base aggregate + one top-k scan per categorical column and posts the assembled stats', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2))
    // Profile traffic runs on the QUERY lane (m2-7: a profile is a heavy
    // scan and must never sit on the registry lane beside the grid's
    // windows). Query-lane send 1: DESCRIBE (metadata only).
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe('DESCRIBE "assay_t1"')
    deps.queryConn.resolveSend(0, describeTable())

    // Query-lane send 2: the combined base aggregate — the single data scan
    // (all nulls/distinct/numeric stats of both columns in one query).
    await awaitSends(deps.queryConn, 2)
    expect(deps.queryConn.sentSqls[1]).toBe(
      'SELECT count(*)::BIGINT AS "c0", ' +
        'count("customer_id")::BIGINT AS "c1", count(DISTINCT "customer_id")::BIGINT AS "c2", ' +
        'min("customer_id")::DOUBLE AS "c3", max("customer_id")::DOUBLE AS "c4", ' +
        'avg("customer_id")::DOUBLE AS "c5", stddev_samp("customer_id")::DOUBLE AS "c6", ' +
        'quantile_cont("customer_id", [0.5,0.9,0.95,0.99])::DOUBLE[] AS "c7", ' +
        'count("country")::BIGINT AS "c8", count(DISTINCT "country")::BIGINT AS "c9" ' +
        'FROM "assay_t1"',
    )
    deps.queryConn.resolveSend(
      1,
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

    // Query-lane send 3: exactly one top-k scan — for the categorical
    // column only.
    await awaitSends(deps.queryConn, 3)
    expect(deps.queryConn.sentSqls[2]).toBe(
      'SELECT CAST("country" AS VARCHAR) AS "v", count(*)::BIGINT AS "n" ' +
        'FROM "assay_t1" WHERE "country" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 10',
    )
    deps.queryConn.resolveSend(
      2,
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
    // The profile never touched the registry-lane connection: its only
    // traffic remains the open's CREATE VIEW.
    expect(deps.conn.sentSqls).toHaveLength(1)
    expectNoCollisions(deps)
  })

  it('a numeric-only schema sends exactly the DESCRIBE + base scan (no top-k)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, numericOnlyDescribeTable())
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(
      1,
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
    expect(deps.queryConn.sentSqls).toHaveLength(2)
    expectNoCollisions(deps)
  })

  it('maps non-finite numeric stat slots (NaN/±Infinity) to null instead of leaking them', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, describeTable())
    await awaitSends(deps.queryConn, 2)
    // Extreme magnitudes: DuckDB can answer NaN/±Infinity stat slots; the
    // profile contract is finite-number-or-null JSON data (protocol
    // invariant), so every non-finite slot degrades to null — only here,
    // in the executor, is that mapping pinned.
    deps.queryConn.resolveSend(
      1,
      profileBaseTable({
        rowCount: 5n,
        id: {
          nn: 5n,
          d: 5n,
          min: Number.NaN,
          max: Number.POSITIVE_INFINITY,
          mean: 3,
          std: Number.NEGATIVE_INFINITY,
          q: [Number.NaN, 4.6, Number.POSITIVE_INFINITY, 4.96],
        },
        country: { nn: 5n, d: 3n },
      }),
    )
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, topKTable([['SG', 2n]]))

    // The op succeeds (no error): non-finite slots are null, finite ones pass.
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/profile-result',
      columns: [
        {
          name: 'customer_id',
          kind: 'numeric',
          numeric: {
            min: null,
            max: null,
            mean: 3,
            stddev: null,
            quantiles: { p50: null, p90: 4.6, p95: null, p99: 4.96 },
          },
        },
        {
          name: 'country',
          kind: 'categorical',
          categorical: { topK: [{ value: 'SG', count: 2 }] },
        },
      ],
    })
    expectNoCollisions(deps)
  })

  it('profiles of unknown handles error their own op without ever touching either lane', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2, 'nope'))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      message: 'unknown table handle: nope',
    })
    // Neither lane was touched: the registry lane only ever saw the open's
    // CREATE VIEW; the query lane saw nothing at all.
    expect(deps.conn.sentSqls).toHaveLength(1)
    expect(deps.queryConn.sentSqls).toHaveLength(0)

    // The engine is reusable: a real profile still answers.
    executor.accept(profileRequest(3))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, describeTable())
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(
      1,
      profileBaseTable({
        rowCount: 5n,
        id: { nn: 5n, d: 5n, min: 1, max: 5, mean: 3, std: 1.58, q: [3, 4.6, 4.8, 4.96] },
        country: { nn: 5n, d: 3n },
      }),
    )
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, topKTable([['SG', 2n]]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/profile-result' })
    expectNoCollisions(deps)
  })

  it('a malformed aggregate slot fails the op loudly and the engine stays usable', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(profileRequest(2))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, describeTable())
    await awaitSends(deps.queryConn, 2)
    // A count slot arriving as a string is an engine deviation: the op fails
    // loudly instead of leaking a bogus stat into the response.
    deps.queryConn.resolveSend(
      1,
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

    // The lane was never wedged: a follow-up query on the same lane answers.
    executor.accept(queryRequest(3, 'SELECT 42 AS value'))
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('queues behind a parked query: its DESCRIBE starts only after the query settles, on the query lane, with zero collisions', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // A user query parks on the query lane's connection…
    executor.accept(queryRequest(2, 'SELECT sum(a.i * b.i) FROM range(20000) a, range(20000) b'))
    await awaitSends(deps.queryConn, 1)
    // …and a profile is accepted while that query is still pending. The
    // profile must wait on the QUERY lane, not run: no send on either
    // connection (the query lane carries only the parked query; the registry
    // lane only the open's CREATE VIEW) and no reply for request 3 yet. This
    // pins profile's lane placement (the m2-7 fix-round drill): rerouting
    // `profile` to the registry lane either sends its DESCRIBE onto this
    // busy connection (a pending-query collision) or, with the connection
    // derived differently, runs the profile's scans while the user query is
    // still in flight instead of behind it.
    executor.accept(profileRequest(3))
    await flush()
    expect(deps.queryConn.sentSqls).toHaveLength(1)
    expect(deps.conn.sentSqls).toHaveLength(1)
    expect(deps.postedResponses.find((response) => response.requestId === 3)).toBeUndefined()

    // The query settles; only then does the profile's DESCRIBE start — on the
    // QUERY lane's connection, serialized behind the settled query.
    deps.queryConn.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })
    await awaitSends(deps.queryConn, 2)
    expect(deps.queryConn.sentSqls[1]).toBe('DESCRIBE "assay_t1"')
    deps.queryConn.resolveSend(1, describeTable())

    // The profile then proceeds normally on the query lane: the base
    // aggregate scan, one top-k for the categorical column, assembled result.
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(
      2,
      profileBaseTable({
        rowCount: 5n,
        id: { nn: 5n, d: 5n, min: 1, max: 5, mean: 3, std: 1.58, q: [3, 4.6, 4.8, 4.96] },
        country: { nn: 5n, d: 3n },
      }),
    )
    await awaitSends(deps.queryConn, 4)
    deps.queryConn.resolveSend(3, topKTable([['SG', 2n]]))
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/profile-result',
      rowCount: 5,
    })

    // Zero collisions on either connection — the profile's queries never
    // overlapped the parked query — and the registry lane's connection was
    // never touched by the profile at all.
    expect(deps.conn.sentSqls).toHaveLength(1)
    expectNoCollisions(deps)
  })
})

// ---- m4-2: overlay windows/counts/schema + export/rewrite -----------------

/** The scripted overlay ops the executor tests compose over t1 (2×2 base). */
const OVERLAY_OPS: readonly EditOp[] = [
  { kind: 'row-delete', rowId: baseRowId('b1', 1) },
  {
    kind: 'cell-set',
    rowId: baseRowId('b1', 0),
    column: 'label',
    value: { kind: 'string', value: 'edited' },
  },
  {
    kind: 'row-insert',
    rowId: insertRowId('o1', 0),
    position: { kind: 'start' },
    values: new Map([['id', { kind: 'number', value: 9 }]]),
  },
]

function overlayPayload() {
  return {
    base: {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'label', type: 'VARCHAR' },
      ],
      baseRowCount: 2,
    },
    ops: OVERLAY_OPS,
  }
}

function overlayRangeRequest(id: number, includeRowIds = false): EngineRequest {
  return {
    type: 'engine/overlay-range',
    requestId: id,
    tableId: 't1',
    overlay: overlayPayload(),
    startRow: 0,
    endRow: 5,
    ...(includeRowIds ? { includeRowIds: true } : {}),
  }
}

function overlayRowCountRequest(id: number): EngineRequest {
  return {
    type: 'engine/overlay-row-count',
    requestId: id,
    tableId: 't1',
    overlay: overlayPayload(),
  }
}

function overlaySchemaRequest(id: number): EngineRequest {
  return { type: 'engine/overlay-schema', requestId: id, tableId: 't1', overlay: overlayPayload() }
}

function overlayCastCheckRequest(
  id: number,
  column = 'label',
  targetType = 'BIGINT',
): EngineRequest {
  return {
    type: 'engine/overlay-cast-check',
    requestId: id,
    tableId: 't1',
    overlay: overlayPayload(),
    column,
    targetType,
  }
}

function exportRequest(
  id: number,
  format: 'parquet' | 'csv' | 'jsonl' | 'arrow',
  withOverlay = true,
): EngineRequest {
  return {
    type: 'engine/export',
    requestId: id,
    tableId: 't1',
    format,
    ...(withOverlay ? { overlay: overlayPayload() } : {}),
  }
}

/** The one-row BIGINT count relation DuckDB's COPY statement returns. */
function copyCountTable(count: bigint): Table {
  return tableFromArrays({ Count: BigInt64Array.from([count]) })
}

describe('EngineOpExecutor overlay surface (m4-2)', () => {
  it('composes the overlay window SQL over the registered view on the registry lane and streams the first batch', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayRangeRequest(2, true))
    await awaitSends(deps.conn, 2)
    expect(deps.conn.sentSqls[1]).toBe(
      'SELECT "assay_row_id", "id", "label" FROM (' +
        'SELECT "id" AS "id", ' +
        // Edited base cell as a typed CASE arm; the tombstoned ordinal excluded.
        `CASE WHEN assay_overlay_ord = 0 THEN CAST('edited' AS VARCHAR) ELSE "label" END AS "label", ` +
        '\'base:b1#\' || CAST(assay_overlay_ord AS VARCHAR) AS "assay_row_id", ' +
        '[0, assay_overlay_ord, 1] AS "assay_key" ' +
        'FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1") ' +
        'WHERE assay_overlay_ord NOT IN (1) ' +
        'UNION ALL ' +
        `SELECT CAST(9 AS BIGINT) AS "id", CAST(NULL AS VARCHAR) AS "label", 'ins:o1#0' AS "assay_row_id", [-1, 0, 1] AS "assay_key"` +
        ') ORDER BY "assay_key" LIMIT 5 OFFSET 0',
    )
    deps.conn.resolveSend(1, intTable([1, 9]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/overlay-range-result' })
    expectNoCollisions(deps)
  })

  it('composes the overlay count and schema SQL, re-checks the count shape, and passes DESCRIBE types through', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayRowCountRequest(2))
    await awaitSends(deps.conn, 2)
    expect(deps.conn.sentSqls[1]).toContain('SELECT count(*)::BIGINT AS row_count FROM (')
    expect(deps.conn.sentSqls[1]).toContain('WHERE assay_overlay_ord NOT IN (1)')
    expect(deps.conn.sentSqls[1]).toContain('UNION ALL')
    deps.conn.resolveSend(1, countTable(2n))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/overlay-row-count-result',
      rowCount: 2,
    })

    executor.accept(overlaySchemaRequest(3))
    await awaitSends(deps.conn, 3)
    expect(deps.conn.sentSqls[2]).toContain('DESCRIBE SELECT')
    expect(deps.conn.sentSqls[2]).toContain('AS "label"') // the edited projection
    deps.conn.resolveSend(2, describeTable())
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/overlay-schema-result',
      columns: [
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'country', type: 'VARCHAR' },
      ],
    })
    expectNoCollisions(deps)
  })

  it('a count that arrives in an unexpected shape errors its own op only', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayRowCountRequest(2))
    await awaitSends(deps.conn, 2)
    // A text cell: not the BIGINT count value the composer asks for.
    deps.conn.resolveSend(1, tableFromArrays({ row_count: ['oops'] }))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'count(*) returned an unexpected shape',
    })
    // The engine stays usable: the next op still answers.
    executor.accept(overlayRowCountRequest(3))
    await awaitSends(deps.conn, 3)
    deps.conn.resolveSend(2, countTable(2n))
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/overlay-row-count-result',
      rowCount: 2,
    })
    expectNoCollisions(deps)
  })

  it('composes the cast-check existence SQL on the query lane and reports the probe-row boolean (m4-4b)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayCastCheckRequest(2, 'label', 'BIGINT'))
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe(
      'SELECT 1 FROM (SELECT "id" AS "id", ' +
        `CASE WHEN assay_overlay_ord = 0 THEN CAST('edited' AS VARCHAR) ELSE "label" END AS "label" ` +
        'FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1") ' +
        'WHERE assay_overlay_ord NOT IN (1) ' +
        'UNION ALL ' +
        'SELECT CAST(9 AS BIGINT) AS "id", CAST(NULL AS VARCHAR) AS "label") ' +
        'WHERE "label" IS NOT NULL AND TRY_CAST("label" AS BIGINT) IS NULL LIMIT 1',
    )
    // One probe row: at least one value cannot convert.
    deps.queryConn.resolveSend(0, intTable([1]))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/overlay-cast-check-result',
      requestId: 2,
      hasNonConvertibleValues: true,
    })
    expectNoCollisions(deps)
  })

  it('reports false when the cast-check probe returns no row (all values convert)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayCastCheckRequest(2))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([]))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/overlay-cast-check-result',
      hasNonConvertibleValues: false,
    })
    expectNoCollisions(deps)
  })

  it('an unknown effective column errors the cast check before any SQL is composed', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayCastCheckRequest(2, 'no_such_column'))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'unknown overlay column: no_such_column',
    })
    expect(deps.queryConn.sentSqls).toHaveLength(0)
    expectNoCollisions(deps)
  })

  it('cast checks queue on the query lane behind a parked query (ADR 0040 lane policy)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // Park a long query on the query lane.
    executor.accept(queryRequest(2, 'SELECT long-running'))
    await awaitSends(deps.queryConn, 1)

    // The check is query-class (a worst-case full-column TRY_CAST scan): it
    // must NOT start while the query owns the lane.
    executor.accept(overlayCastCheckRequest(3))
    await flush()
    expect(deps.queryConn.sentSqls).toHaveLength(1)

    deps.queryConn.resolveSend(0, intTable([1]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, intTable([]))
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/overlay-cast-check-result',
      hasNonConvertibleValues: false,
    })
    expectNoCollisions(deps)
  })

  it('answers malformed recognised overlay/export requests with one typed error (m4-2 fix round 2)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // The reviewer's exact repro: a directly posted malformed
    // engine/overlay-schema with requestId 77. Before the fix
    // `parseEngineRequest` returned null and the executor silently returned,
    // leaving the caller hanging; now the envelope is preserved and answered.
    executor.accept({
      type: 'engine/overlay-schema',
      requestId: 77,
      tableId: 't1',
      overlay: { base: { baseAnchor: 'b1' } },
    })
    // A malformed export (unknown format) and a malformed overlay-range
    // (empty columns) are answered the same way.
    executor.accept({ type: 'engine/export', requestId: 78, tableId: 't1', format: 'xlsx' })
    executor.accept({
      type: 'engine/overlay-range',
      requestId: 79,
      tableId: 't1',
      overlay: overlayPayload(),
      startRow: 0,
      endRow: 5,
      columns: [],
    })
    // A cast check with a valid overlay but a malformed target type (and a
    // missing column variant) is a recognised request with a bad payload:
    // exactly one typed engine/error, never silence, never a composed probe.
    executor.accept({
      type: 'engine/overlay-cast-check',
      requestId: 80,
      tableId: 't1',
      overlay: overlayPayload(),
      column: 'label',
      targetType: 'VARCHAR()',
    })
    executor.accept({
      type: 'engine/overlay-cast-check',
      requestId: 81,
      tableId: 't1',
      overlay: overlayPayload(),
    })
    expect(deps.postedResponses.filter((response) => response.requestId === 77)).toHaveLength(1)
    expect(await awaitPosted(deps, 77)).toMatchObject({
      type: 'engine/error',
      requestId: 77,
      message: 'malformed engine/overlay-schema request',
    })
    expect(await awaitPosted(deps, 78)).toMatchObject({
      type: 'engine/error',
      requestId: 78,
      message: 'malformed engine/export request',
    })
    expect(await awaitPosted(deps, 79)).toMatchObject({
      type: 'engine/error',
      requestId: 79,
      message: 'malformed engine/overlay-range request',
    })
    expect(await awaitPosted(deps, 80)).toMatchObject({
      type: 'engine/error',
      requestId: 80,
      message: 'malformed engine/overlay-cast-check request',
    })
    expect(await awaitPosted(deps, 81)).toMatchObject({
      type: 'engine/error',
      requestId: 81,
      message: 'malformed engine/overlay-cast-check request',
    })
    // Nothing touched a connection: no SQL was composed for any of them.
    expect(deps.conn.sentSqls).toHaveLength(1) // only the open's CREATE VIEW
    expect(deps.queryConn.sentSqls).toHaveLength(0)
    expectNoCollisions(deps)
  })

  it('still ignores truly unrecognised messages (unchanged contract)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept({ type: 'engine/drop', requestId: 2 })
    // A recognised type with no correlatable requestId cannot be answered.
    executor.accept({ type: 'engine/overlay-schema', tableId: 't1' })
    executor.accept('not a message')
    await flush()
    // Only the open's own result was posted.
    expect(deps.postedResponses.filter((response) => response.requestId !== 1)).toEqual([])
    expect(deps.conn.sentSqls).toHaveLength(1)
    expect(deps.queryConn.sentSqls).toHaveLength(0)
  })

  it('an unknown table handle errors the overlay op without ever touching a connection', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept({
      type: 'engine/overlay-range',
      requestId: 2,
      tableId: 'assay-no-such-table',
      overlay: overlayPayload(),
      startRow: 0,
      endRow: 5,
    })
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'unknown table handle: assay-no-such-table',
    })
    expect(deps.conn.sentSqls).toHaveLength(1)
    expect(deps.queryConn.sentSqls).toHaveLength(0)
  })
})

describe('EngineOpExecutor export (m4-2; query lane)', () => {
  it('COPYs the effective view to a generated destination on the query lane, moves the bytes to OPFS scratch, and drops the wasm-side copy', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(exportRequest(2, 'parquet'))
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe(
      'COPY (SELECT "id", "label" FROM (SELECT "id" AS "id", ' +
        `CASE WHEN assay_overlay_ord = 0 THEN CAST('edited' AS VARCHAR) ELSE "label" END AS "label", ` +
        '[0, assay_overlay_ord, 1] AS "assay_key" ' +
        'FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1") ' +
        'WHERE assay_overlay_ord NOT IN (1) ' +
        'UNION ALL ' +
        `SELECT CAST(9 AS BIGINT) AS "id", CAST(NULL AS VARCHAR) AS "label", [-1, 0, 1] AS "assay_key") ` +
        'ORDER BY "assay_key"' +
        `) TO 'assay-export-1' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)`,
    )
    deps.queryConn.resolveSend(0, copyCountTable(2n))
    const response = await awaitPosted(deps, 2)
    expect(response).toMatchObject({
      type: 'engine/export-result',
      requestId: 2,
      path: 'assay-exports/assay-export-1.parquet',
      format: 'parquet',
      rowCount: 2,
      bytes: new TextEncoder().encode('assay-export-bytes').length,
    })
    // The wasm-side copy is dropped after the byte read (the registry-lane
    // dropFile seam), and the bytes landed in OPFS scratch under the same
    // generated path — never the source.
    expect(deps.droppedFiles).toContain('assay-export-1')
    expect(deps.writtenExports).toHaveLength(1)
    expect(deps.writtenExports[0]!.path).toBe('assay-exports/assay-export-1.parquet')
    expect(new TextDecoder().decode(deps.writtenExports[0]!.bytes)).toBe('assay-export-bytes')
    expectNoCollisions(deps)
  })

  it('falls back to an explicit count when the COPY result shape is unexpected, and cleans up on read failure', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(exportRequest(2, 'csv'))
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toContain('FORMAT CSV')
    deps.queryConn.resolveSend(0, intTable([1, 2])) // two rows: not the count relation
    await awaitSends(deps.queryConn, 2)
    expect(deps.queryConn.sentSqls[1]).toContain('count(*)::BIGINT AS row_count')
    deps.queryConn.resolveSend(1, countTable(2n))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/export-result',
      rowCount: 2,
    })

    // A byte-read failure errors the export but still drops the wasm copy.
    deps.copyExportBytesError = new Error('wasm fs read failed')
    executor.accept(exportRequest(3, 'csv'))
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, copyCountTable(2n))
    expect(await awaitPosted(deps, 3)).toMatchObject({
      type: 'engine/error',
      requestId: 3,
      message: 'wasm fs read failed',
    })
    expect(deps.droppedFiles.filter((name) => name === 'assay-export-2')).toHaveLength(1)
    expectNoCollisions(deps)
  })

  it('assembles the arrow export by draining the identical SELECT on the query lane', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(exportRequest(2, 'arrow'))
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe(
      'SELECT "id", "label" FROM (SELECT "id" AS "id", ' +
        `CASE WHEN assay_overlay_ord = 0 THEN CAST('edited' AS VARCHAR) ELSE "label" END AS "label", ` +
        '[0, assay_overlay_ord, 1] AS "assay_key" ' +
        'FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1") ' +
        'WHERE assay_overlay_ord NOT IN (1) ' +
        'UNION ALL ' +
        `SELECT CAST(9 AS BIGINT) AS "id", CAST(NULL AS VARCHAR) AS "label", [-1, 0, 1] AS "assay_key") ` +
        'ORDER BY "assay_key"',
    )
    // Two batches: the drain must consume both (honest rowCount 2).
    const twoBatches = new Table(intTable([1]).schema, [
      ...intTable([1]).batches,
      ...intTable([2]).batches,
    ])
    deps.queryConn.resolveSend(0, twoBatches)
    const response = await awaitPosted(deps, 2)
    expect(response).toMatchObject({
      type: 'engine/export-result',
      path: 'assay-exports/assay-export-1.arrow',
      format: 'arrow',
      rowCount: 2,
    })
    expect(deps.droppedFiles).toHaveLength(0) // no wasm-side copy for arrow
    expect(deps.writtenExports[0]!.path).toBe('assay-exports/assay-export-1.arrow')
    expectNoCollisions(deps)
  })

  it('exports the plain base view when no overlay is carried (DESCRIBE-derived composition)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(exportRequest(2, 'jsonl', false))
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe('DESCRIBE "assay_t1"')
    deps.queryConn.resolveSend(0, describeTable())
    await awaitSends(deps.queryConn, 2)
    expect(deps.queryConn.sentSqls[1]).toContain(`TO 'assay-export-1' (FORMAT JSON, ARRAY false)`)
    deps.queryConn.resolveSend(1, copyCountTable(5n))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/export-result',
      path: 'assay-exports/assay-export-1.jsonl',
      rowCount: 5,
    })
    expectNoCollisions(deps)
  })

  it('overlay windows answer on the registry lane while a query is parked; exports queue behind the parked query (ADR 0040 lane policy)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // Park a long query on the query lane.
    executor.accept(queryRequest(2, 'SELECT long-running'))
    await awaitSends(deps.queryConn, 1)

    // The overlay window answers NOW on the registry lane (grid class).
    executor.accept(overlayRangeRequest(3))
    await awaitSends(deps.conn, 2)
    deps.conn.resolveSend(1, intTable([7]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/overlay-range-result' })

    // The export's COPY must NOT interleave on the busy query connection.
    executor.accept(exportRequest(4, 'parquet'))
    await flush()
    expect(deps.queryConn.sentSqls).toHaveLength(1)

    // The parked query settles; only then does the COPY start (FIFO).
    deps.queryConn.resolveSend(0, intTable([1]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, copyCountTable(9n))
    expect(await awaitPosted(deps, 4)).toMatchObject({
      type: 'engine/export-result',
      rowCount: 9,
    })
    expectNoCollisions(deps)
  })
})
