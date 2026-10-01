// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Field,
  List,
  Table,
  Utf8,
  tableFromArrays,
  tableFromIPC,
  vectorFromArray,
} from 'apache-arrow'
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
import { compileRowDiffPlan } from '@assay/diff'
import type { EngineRowDiffPlan } from './diff-plan-wire'
import { MAX_OVERLAY_LIVE_INSERT_BRANCHES, OverlayLiveInsertLimitError } from './overlay-query'

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
  /** When non-null, `cancel()` rejects with this (after releasing the slot). */
  cancelError: unknown = null
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
    if (this.stream.cancelError !== null) throw this.stream.cancelError
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
  /** When non-null, `cancelSent()` rejects with this. */
  cancelSentError: unknown = null

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
    if (this.cancelSentError !== null) throw this.cancelSentError
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

  it('a failed reader.cancel() after the first batch is swallowed: the result and the lane survive', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(queryRequest(2, 'SELECT i FROM range(5000)'))
    await awaitSends(deps.queryConn, 1)
    const first = intTable([1, 2, 3]).batches[0]!
    const second = intTable([4, 5, 6]).batches[0]!
    const stream = new FakeStream(first.schema, [first, second])
    stream.cancelError = new Error('assay fake cancel failure')
    deps.queryConn.sendAt(0).gate.resolve(stream)

    // The successful first batch is reported; the cleanup failure is not the
    // op's rejection surface.
    const response = await awaitPosted(deps, 2)
    expect(response.type).toBe('engine/query-result')
    if (response.type === 'engine/query-result') {
      expect(response.hasMore).toBe(true)
      expect(firstColumnValues(response.batchIpc)).toEqual([1, 2, 3])
    }
    // The lane is free, so the next op runs normally (no collision).
    executor.accept(queryRequest(3, 'SELECT 9 AS value'))
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, intTable([9]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('a failed cancelSent() is swallowed too: the discarded-tail hasMore report stands', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    deps.queryConn.cancelSentError = new Error('assay fake cancelSent failure')
    executor.accept(queryRequest(2, 'SELECT i FROM range(5000)'))
    await awaitSends(deps.queryConn, 1)
    const first = intTable([1, 2, 3]).batches[0]!
    const second = intTable([4, 5, 6]).batches[0]!
    deps.queryConn.sendAt(0).gate.resolve(new FakeStream(first.schema, [first, second]))

    const response = await awaitPosted(deps, 2)
    expect(response.type).toBe('engine/query-result')
    if (response.type === 'engine/query-result') {
      expect(response.hasMore).toBe(true)
      expect(firstColumnValues(response.batchIpc)).toEqual([1, 2, 3])
    }
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

  it('q-10: rejects a malformed range envelope with one typed error (was silently dropped)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // Before q-10 this exact message was silently dropped: the strict parser
    // returned null and `accept` returned without a reply, so a caller
    // holding pending request 2 would hang. It now surfaces as one typed
    // engine/error naming the request class + value-free field path.
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
    expect(await awaitPosted(deps, 2)).toEqual({
      type: 'engine/error',
      requestId: 2,
      message: 'malformed envelope: range.filters',
    })

    // The rejection never occupied a lane: a follow-up query still runs on
    // the query lane and the malformed message touched no connection.
    executor.accept(queryRequest(3, 'SELECT 42 AS value'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('q-10: rejects malformed query/schema/open/row-count envelopes without touching a connection', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept({ type: 'engine/query', requestId: 20 }) // missing sql
    executor.accept({ type: 'engine/schema', requestId: 21, tableId: 7 }) // wrong-typed id
    executor.accept({ type: 'engine/open', requestId: 22, name: 42 }) // missing File
    executor.accept({ type: 'engine/row-count', requestId: 23, filters: 'x' }) // missing id + bad filters
    await flush()

    expect(await awaitPosted(deps, 20)).toMatchObject({ message: 'malformed envelope: query.sql' })
    expect(await awaitPosted(deps, 21)).toMatchObject({
      message: 'malformed envelope: schema.tableId',
    })
    expect(await awaitPosted(deps, 22)).toMatchObject({ message: 'malformed envelope: open.name' })
    expect(await awaitPosted(deps, 23)).toMatchObject({
      message: 'malformed envelope: row-count.tableId',
    })
    // Nothing was dispatched: only the open's CREATE VIEW ran.
    expect(deps.conn.sentSqls).toHaveLength(1)
    expect(deps.queryConn.sentSqls).toHaveLength(0)
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

  it('delivers the typed live-insert cap remedy on the row-count lane (PT-Q q-6)', async () => {
    // The registry lane hits `overlay-row-count` first after a crossed cap
    // (refresh → rowCount). The composer's typed, value-free error must cross
    // the wire intact here just as it does for schema/window/export — NOT the
    // generic materialization class the value-free wrap would substitute.
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    const overCapOps: EditOp[] = Array.from(
      { length: MAX_OVERLAY_LIVE_INSERT_BRANCHES + 1 },
      (_, index) => ({
        kind: 'row-insert' as const,
        rowId: insertRowId('o1', index),
        position: { kind: 'start' as const },
        values: new Map([['id', { kind: 'number' as const, value: index }]]),
      }),
    )
    executor.accept({
      type: 'engine/overlay-row-count',
      requestId: 2,
      tableId: 't1',
      overlay: { ...overlayPayload(), ops: overCapOps },
    })

    // The cap is hit at compose time — before any SQL reaches the connection.
    const posted = await awaitPosted(deps, 2)
    expect(posted.type).toBe('engine/error')
    if (posted.type !== 'engine/error') throw new Error(`expected engine/error, got ${posted.type}`)
    expect(posted).toEqual({
      type: 'engine/error',
      requestId: 2,
      message: new OverlayLiveInsertLimitError().message,
    })
    // The exact typed cap text (with remedy), never the generic class.
    expect(posted.message).toBe(
      'the edited view has more live inserts than the engine composes in one window ' +
        `(limit ${MAX_OVERLAY_LIVE_INSERT_BRANCHES} live-insert branches); ` +
        'export the edits to a new file and re-open it to continue',
    )
    // The cap is hit at compose time — the only SQL is the open's CREATE VIEW.
    expect(deps.conn.sentSqls).toHaveLength(1)
    expectNoCollisions(deps)
  })

  it('composes the cast-check existence SQL on the query lane and reports the probe-row boolean (m4-4b)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayCastCheckRequest(2, 'label', 'BIGINT'))
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe(
      'SELECT 1 FROM (SELECT "label", assay_overlay_ord FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1") ' +
        'WHERE assay_overlay_ord NOT IN (1)) ' +
        "WHERE (assay_overlay_ord = 0 AND 'edited' IS NOT NULL AND TRY_CAST('edited' AS BIGINT) IS NULL) " +
        'OR (assay_overlay_ord NOT IN (0) AND "label" IS NOT NULL AND TRY_CAST("label" AS BIGINT) IS NULL) ' +
        'UNION ALL ' +
        'SELECT 1 WHERE NULL IS NOT NULL AND TRY_CAST(NULL AS BIGINT) IS NULL LIMIT 1',
    )
    // The edit literal reaches the check raw: no base-type wrapper cast.
    expect(deps.queryConn.sentSqls[0]).not.toContain("CAST('edited' AS VARCHAR)")
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
      message: 'malformed envelope: overlay-schema.overlay',
    })
    expect(await awaitPosted(deps, 78)).toMatchObject({
      type: 'engine/error',
      requestId: 78,
      message: 'malformed envelope: export.format',
    })
    expect(await awaitPosted(deps, 79)).toMatchObject({
      type: 'engine/error',
      requestId: 79,
      message: 'malformed envelope: overlay-range.columns',
    })
    expect(await awaitPosted(deps, 80)).toMatchObject({
      type: 'engine/error',
      requestId: 80,
      message: 'malformed envelope: overlay-cast-check.targetType',
    })
    expect(await awaitPosted(deps, 81)).toMatchObject({
      type: 'engine/error',
      requestId: 81,
      message: 'malformed envelope: overlay-cast-check.column',
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

  it('q-8: maps a hostile-value overlay window failure to the value-free class only', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayRangeRequest(2))
    await awaitSends(deps.conn, 2)
    // A DuckDB conversion error embedding a quote-laden hostile value; the
    // tail carries the composed statement. Neither may cross the boundary.
    deps.conn.rejectSend(
      1,
      new Error(
        "Conversion Error: Could not convert string ''; DROP TABLE x --' to BIGINT\n" +
          "LINE 1: SELECT CAST(''; DROP TABLE x --' AS BIGINT) FROM \"assay_t1\"",
      ),
    )
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'the edited view could not be materialized',
    })
    if (posted.type === 'engine/error') {
      expect(posted.message).not.toContain('DROP TABLE')
      expect(posted.message).not.toContain("'; DROP TABLE x --")
    }
    expectNoCollisions(deps)
  })

  it('q-8: maps a hostile-value overlay schema failure to the value-free class only', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlaySchemaRequest(2))
    await awaitSends(deps.conn, 2)
    deps.conn.rejectSend(
      1,
      new Error('Catalog Error: Table with name "\'; DROP TABLE x --" does not exist'),
    )
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'the edited view could not be materialized',
    })
    if (posted.type === 'engine/error') {
      expect(posted.message).not.toContain('DROP TABLE')
    }
    expectNoCollisions(deps)
  })

  it('q-8: maps a hostile-value cast-check failure to the value-free class only (query lane)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(overlayCastCheckRequest(2))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.rejectSend(
      0,
      new Error('Binder Error: Referenced column "\'; DROP TABLE x --" not found in FROM clause'),
    )
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'the edited view could not be materialized',
    })
    if (posted.type === 'engine/error') {
      expect(posted.message).not.toContain('DROP TABLE')
    }
    expectNoCollisions(deps)
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

    // A byte-read failure (an engine-FS step) maps to the value-free export
    // class but still drops the wasm copy; the raw FS text never crosses.
    deps.copyExportBytesError = new Error('wasm fs read failed: assay-export-2')
    executor.accept(exportRequest(3, 'csv'))
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, copyCountTable(2n))
    const readFailure = await awaitPosted(deps, 3)
    expect(readFailure).toMatchObject({
      type: 'engine/error',
      requestId: 3,
      message: 'the view could not be exported',
    })
    if (readFailure.type === 'engine/error') {
      expect(readFailure.message).not.toContain('wasm fs read failed')
    }
    expect(deps.droppedFiles.filter((name) => name === 'assay-export-2')).toHaveLength(1)
    expectNoCollisions(deps)
  })

  it('au3-3: maps a hostile-value COPY failure to the value-free export class only (query lane)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(exportRequest(2, 'csv'))
    await awaitSends(deps.queryConn, 1)
    // A DuckDB conversion error embedding a quote-laden cell value; the
    // composed COPY statement is in the tail. Neither may cross the boundary.
    deps.queryConn.rejectSend(
      0,
      new Error(
        "Conversion Error: Could not convert string ''; DROP TABLE x --' to INT32\n" +
          "LINE 1: COPY (SELECT CAST(''; DROP TABLE x --' AS INTEGER) AS \"id\" FROM \"assay_t1\") TO 'assay-export-1'",
      ),
    )
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'the view could not be exported',
    })
    if (posted.type === 'engine/error') {
      expect(posted.message).not.toContain('DROP TABLE')
      expect(posted.message).not.toContain("'; DROP TABLE x --")
      expect(posted.message).not.toContain('Could not convert string')
    }
    expectNoCollisions(deps)
  })

  it('au3-3: maps a hostile-value arrow-drain failure to the value-free export class only', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(exportRequest(2, 'arrow'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.rejectSend(
      0,
      new Error(
        "Conversion Error: Could not convert string 'secret-cell-value' to INT32\n" +
          'LINE 1: SELECT CAST(\'secret-cell-value\' AS INTEGER) FROM "assay_t1"',
      ),
    )
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'the view could not be exported',
    })
    if (posted.type === 'engine/error') {
      expect(posted.message).not.toContain('secret-cell-value')
      expect(posted.message).not.toContain('Could not convert string')
    }
    expectNoCollisions(deps)
  })

  it('au3-3: maps a hostile-value fallback-count failure to the value-free export class only', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    executor.accept(exportRequest(2, 'csv'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([1, 2])) // not the count relation
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.rejectSend(
      1,
      new Error("Catalog Error: Table with name 'secret-cell-value' does not exist"),
    )
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({
      type: 'engine/error',
      requestId: 2,
      message: 'the view could not be exported',
    })
    if (posted.type === 'engine/error') {
      expect(posted.message).not.toContain('secret-cell-value')
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// m5-2: validation execution (engine/validate, query lane)
// ─────────────────────────────────────────────────────────────────────────────

import { parseValidationPlan } from './validate-plan-wire'
import type { EngineValidationPlan, EngineValidationRule } from './validate-plan-wire'
import { VALIDATION_SAMPLE_HARD_MAX } from './validate-query'

/** A compiler-shaped rule over the binding view (the m5-1 rendering). */
function planRule(
  ruleId: string,
  sql: string,
  overrides: Partial<EngineValidationRule> = {},
): EngineValidationRule {
  return {
    ruleId,
    path: ruleId,
    kind: 'required',
    column: 'id',
    outcome: 'row-samples',
    sql,
    ...overrides,
  }
}

const BINDING = 'assay_conf_validate_src'

function validPlanFixture(): EngineValidationPlan {
  const ruleSql =
    'SELECT\n' +
    `  (SELECT count(*) FROM "${BINDING}") AS "total_rows",\n` +
    '  count(*) OVER () AS "fail_count",\n' +
    '  row_number() OVER () - 1 AS "sample_index",\n' +
    '  "assay_row_ordinal",\n' +
    '  "assay_value"\n' +
    'FROM (\n' +
    '  SELECT row_number() OVER () - 1 AS "assay_row_ordinal", "src"."id" AS "assay_value"\n' +
    `  FROM "${BINDING}" AS "src"\n` +
    ') AS "assay_rule_source"\n' +
    'WHERE "assay_value" IS NULL\n' +
    'LIMIT 20'
  return parseValidationPlan({
    planKind: 'assay-validation-plan',
    planVersion: 1,
    contractName: 'conf',
    contractVersion: 1,
    relation: BINDING,
    sampleLimit: 20,
    rules: [planRule('columns[0].required', ruleSql)],
    summarySql:
      `SELECT 'columns[0].required' AS "rule_id", (SELECT count(*) FROM "${BINDING}") AS "total_rows", count(*) AS "fail_count"\n` +
      `FROM "${BINDING}" AS "src"\n` +
      'WHERE "src"."id" IS NULL',
  }) as EngineValidationPlan
}

function factPlanFixture(): EngineValidationPlan {
  return factPlanWithCount(1)
}

/**
 * A compiler-shaped dataset-fact plan reporting an arbitrary `fail_count`
 * (the m5-4 refined-bound probes: 2 is a foreign plan, 1 over an empty
 * dataset is an honest violation).
 */
function factPlanWithCount(failCount: number): EngineValidationPlan {
  const ruleSql =
    `SELECT "assay_n" AS "total_rows", ${String(failCount)} AS "fail_count"\n` +
    'FROM (\n' +
    `  SELECT count(*) AS "assay_n" FROM "${BINDING}" AS "src"\n` +
    ') AS "assay_rule_stats"\n' +
    'WHERE "assay_n" < 100'
  return parseValidationPlan({
    planKind: 'assay-validation-plan',
    planVersion: 1,
    contractName: 'conf',
    contractVersion: 1,
    relation: BINDING,
    sampleLimit: 20,
    rules: [
      planRule('dataset.min-rows', ruleSql, {
        kind: 'min-rows',
        column: null,
        outcome: 'dataset-fact',
      }),
    ],
    summarySql:
      `SELECT 'dataset.min-rows' AS "rule_id", "assay_n" AS "total_rows", CASE WHEN "assay_n" < 100 THEN ${String(failCount)} ELSE 0 END AS "fail_count"\n` +
      'FROM (\n' +
      `  SELECT count(*) AS "assay_n" FROM "${BINDING}" AS "src"\n` +
      ') AS "assay_rule_stats"',
  }) as EngineValidationPlan
}

function validateRequest(id: number, plan: EngineValidationPlan): EngineRequest {
  return { type: 'engine/validate', requestId: id, tableId: 't1', plan }
}

/** Script DESCRIBE + BEGIN + CREATE VIEW + count for a validate against the fake. */
async function acceptValidateToCount(
  executor: EngineOpExecutor,
  deps: FakeDeps,
  plan: EngineValidationPlan,
  rowCount = 4n,
): Promise<void> {
  executor.accept(validateRequest(2, plan))
  await awaitSends(deps.queryConn, 1)
  deps.queryConn.resolveSend(0, describeTable())
  await awaitSends(deps.queryConn, 2)
  deps.queryConn.resolveSend(1, tableFromArrays({})) // BEGIN TRANSACTION
  await awaitSends(deps.queryConn, 3)
  deps.queryConn.resolveSend(2, tableFromArrays({})) // CREATE VIEW (binding)
  await awaitSends(deps.queryConn, 4)
  deps.queryConn.resolveSend(3, countTable(rowCount))
}

/** Result tables the fake query connection serves for the scripted validate. */
function samplesTable(): Table {
  return tableFromArrays({
    total_rows: BigInt64Array.from([4n, 4n]),
    fail_count: BigInt64Array.from([2n, 2n]),
    sample_index: BigInt64Array.from([0n, 1n]),
    assay_row_ordinal: BigInt64Array.from([0n, 3n]),
    assay_value: BigInt64Array.from([1n, 1n]),
  })
}

function factTable(): Table {
  return tableFromArrays({
    total_rows: BigInt64Array.from([4n]),
    fail_count: BigInt64Array.from([0n]),
  })
}

describe('EngineOpExecutor validation execution (m5-2; query lane)', () => {
  it('runs the plan inside a rolled-back transaction and posts the keyed result', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    const plan = validPlanFixture()
    executor.accept(validateRequest(2, plan))
    // Base composition DESCRIBE → BEGIN → CREATE VIEW (binding) → count →
    // per-rule → row keys → summary → DROP (inside the tx) → ROLLBACK.
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe('DESCRIBE "assay_t1"')
    deps.queryConn.resolveSend(0, describeTable())
    await awaitSends(deps.queryConn, 2)
    // Belt 2 (m5-2 fix round): the whole execution is containment-wrapped.
    expect(deps.queryConn.sentSqls[1]).toBe('BEGIN TRANSACTION')
    deps.queryConn.resolveSend(1, tableFromArrays({}))
    await awaitSends(deps.queryConn, 3)
    expect(deps.queryConn.sentSqls[2]).toContain(`CREATE VIEW "${BINDING}"`)
    deps.queryConn.resolveSend(2, tableFromArrays({}))
    await awaitSends(deps.queryConn, 4)
    expect(deps.queryConn.sentSqls[3]).toBe(
      `SELECT count(*)::BIGINT AS "row_count" FROM "${BINDING}"`,
    )
    deps.queryConn.resolveSend(3, countTable(4n))
    await awaitSends(deps.queryConn, 5)
    // The rule SQL executes inside the engine clamp wrapper (m5-2 round-3:
    // `SELECT * FROM (<exact plan SQL>) LIMIT min(K, hard max)` = LIMIT 20
    // here) — the inner SQL stays byte-identical, never rewritten.
    expect(deps.queryConn.sentSqls[4]).toBe(`SELECT * FROM (${plan.rules[0]!.sql}) LIMIT 20`)
    deps.queryConn.resolveSend(4, samplesTable())
    await awaitSends(deps.queryConn, 6)
    expect(deps.queryConn.sentSqls[5]).toBe(
      `SELECT "assay_overlay_ord", "assay_row_id" FROM "${BINDING}" WHERE "assay_overlay_ord" IN (0, 3)`,
    )
    deps.queryConn.resolveSend(
      5,
      tableFromArrays({ assay_overlay_ord: [0, 3], assay_row_id: ['base:b#0', 'base:b#3'] }),
    )
    await awaitSends(deps.queryConn, 7)
    expect(deps.queryConn.sentSqls[6]).toBe(plan.summarySql)
    deps.queryConn.resolveSend(
      6,
      tableFromArrays({ rule_id: ['columns[0].required'], total_rows: [4], fail_count: [2] }),
    )
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    await awaitSends(deps.queryConn, 9)
    // The success response is posted ONLY after containment completed: no
    // post may be observable after the DROP but before the ROLLBACK settles
    // (m5-2 round-3 fix, W2 — one posted response so far: the open result).
    expect(deps.postedResponses).toHaveLength(1)
    deps.queryConn.resolveSend(8, tableFromArrays({}))

    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/validate-result', requestId: 2 })
    if (posted.type !== 'engine/validate-result') return
    expect(posted.result).toEqual({
      valid: false,
      rowCount: 4,
      rules: [
        {
          ruleId: 'columns[0].required',
          outcome: 'row-samples',
          failCount: 2,
          failPercent: 50,
          sampleFailures: [
            { rowKey: 'base:b#0', value: 1 },
            { rowKey: 'base:b#3', value: 1 },
          ],
        },
      ],
    })
    // The op-created binding view is dropped inside the transaction...
    expect(deps.queryConn.sentSqls[7]).toContain(`DROP VIEW IF EXISTS "${BINDING}"`)
    await awaitSends(deps.queryConn, 9)
    // ...and the containment transaction is ALWAYS rolled back, even on the
    // success path: no side effect the op caused can survive it.
    expect(deps.queryConn.sentSqls[8]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(8, tableFromArrays({}))
    expectNoCollisions(deps)
  })

  it('reports a clean dataset as valid with zeroed percents (fact rule)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    await acceptValidateToCount(executor, deps, factPlanFixture())
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, factTable())
    // No samples → no row-key query; summary next.
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(
      5,
      tableFromArrays({ rule_id: ['dataset.min-rows'], total_rows: [4], fail_count: [0] }),
    )
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(6, tableFromArrays({}))
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({
      type: 'engine/validate-result',
      result: {
        valid: true,
        rowCount: 4,
        rules: [{ failCount: 0, failPercent: 0, sampleFailures: [] }],
      },
    })
    expect(deps.queryConn.sentSqls.at(-1)).toBe('ROLLBACK')
    expectNoCollisions(deps)
  })

  it('executes an over-max K with samples clamped and the FULL failCount (m5-2 round-3: clamped, not refused)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // K=500 parses and executes (the wire no longer refuses K > 100): the
    // executed rule query is the exact plan SQL wrapped ONCE, LIMITed to
    // min(500, 100) = 100 returned rows, while the inner window still
    // reports the rule's full violation count (110 here) on every row.
    const overMaxPlan = parseValidationPlan({
      ...validPlanFixture(),
      sampleLimit: 500,
    }) as EngineValidationPlan
    await acceptValidateToCount(executor, deps, overMaxPlan, 120n)
    await awaitSends(deps.queryConn, 5)
    expect(deps.queryConn.sentSqls[4]).toBe(
      `SELECT * FROM (${overMaxPlan.rules[0]!.sql}) LIMIT 100`,
    )
    // What a real engine returns under the wrapper: 100 rows, each carrying
    // the FULL fail_count (110 violations over 120 rows).
    const clampedRows = 100
    const ordinals = Array.from({ length: clampedRows }, (_, i) => i)
    deps.queryConn.resolveSend(
      4,
      tableFromArrays({
        total_rows: BigInt64Array.from(Array.from({ length: clampedRows }, () => 120n)),
        fail_count: BigInt64Array.from(Array.from({ length: clampedRows }, () => 110n)),
        sample_index: BigInt64Array.from(ordinals.map((n) => BigInt(n))),
        assay_row_ordinal: BigInt64Array.from(ordinals.map((n) => BigInt(n))),
        assay_value: BigInt64Array.from(Array.from({ length: clampedRows }, () => 1n)),
      }),
    )
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(
      5,
      tableFromArrays({
        assay_overlay_ord: ordinals,
        assay_row_id: ordinals.map((i) => `base:b#${String(i)}`),
      }),
    )
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(
      6,
      tableFromArrays({ rule_id: ['columns[0].required'], total_rows: [120], fail_count: [110] }),
    )
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, tableFromArrays({})) // DROP
    await awaitSends(deps.queryConn, 9)
    deps.queryConn.resolveSend(8, tableFromArrays({})) // ROLLBACK
    const posted = await awaitPosted(deps, 2)
    if (posted.type !== 'engine/validate-result') return
    // The count is the rule's own FULL count — never corrupted by the outer
    // limit — and the reported samples stop exactly at the hard max.
    expect(posted.result.rules[0]?.failCount).toBe(110)
    expect(posted.result.rules[0]?.failPercent).toBe(92)
    expect(posted.result.rules[0]?.sampleFailures).toHaveLength(100)
    expect(deps.queryConn.sentSqls.at(-1)).toBe('ROLLBACK')
    expectNoCollisions(deps)
  })

  it('wraps a huge-K (2^53-1) plan to the hard max without unbounded row return', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // The clamp is IN the executed SQL (`LIMIT min(K, 100)`): a hostile
    // huge-K plan cannot ask the engine to return unbounded rows — the
    // wrapper bounds the result set structurally. The rule result here is
    // empty (clean rule) so the flow completes quickly.
    const hugePlan = parseValidationPlan({
      ...validPlanFixture(),
      sampleLimit: 2 ** 53 - 1,
    }) as EngineValidationPlan
    await acceptValidateToCount(executor, deps, hugePlan)
    await awaitSends(deps.queryConn, 5)
    expect(deps.queryConn.sentSqls[4]).toBe(`SELECT * FROM (${hugePlan.rules[0]!.sql}) LIMIT 100`)
    deps.queryConn.resolveSend(4, tableFromArrays({})) // empty result ⇒ clean rule
    // No samples → no row-key query; summary next, then cleanup, then post.
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(
      5,
      tableFromArrays({ rule_id: ['columns[0].required'], total_rows: [4], fail_count: [0] }),
    )
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(6, tableFromArrays({}))
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/validate-result' })
    expect(deps.queryConn.sentSqls.at(-1)).toBe('ROLLBACK')
    expectNoCollisions(deps)
  })

  it('still refuses K < 1 with one typed error and zero SQL (the plan contract)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // The clamp replaced the old K > 100 refusal, but the LOWER bound is the
    // plan contract (LIMIT 0 could not distinguish a violated rule from a
    // clean one): K = 0 still fails at the envelope before any SQL runs.
    for (const badK of [0, -5, 2.5]) {
      const plan = parseValidationPlan({
        ...validPlanFixture(),
        sampleLimit: badK,
      }) as EngineValidationPlan | null
      expect(plan).toBeNull()
      executor.accept(validateRequest(2, plan as unknown as EngineValidationPlan))
      const posted = await awaitPosted(deps, 2)
      expect(posted).toMatchObject({ type: 'engine/error' })
      if (posted.type === 'engine/error') {
        expect(posted.message).toBe('malformed envelope: validate.plan')
      }
      // Not a single statement ran for the hostile plan (and the engine is
      // immediately reusable).
      expect(deps.queryConn.sentSqls).toEqual([])
    }
    executor.accept(queryRequest(3, 'SELECT 42 AS answer'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('accepts K at the hard max boundary and bounds samples to K', async () => {
    const rows = VALIDATION_SAMPLE_HARD_MAX
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // K exactly at the hard max is legal: failCount stays the rule's own
    // count (not the sample bound); the reported list stops at K.
    const atMaxPlan = parseValidationPlan({
      ...validPlanFixture(),
      sampleLimit: VALIDATION_SAMPLE_HARD_MAX,
    }) as EngineValidationPlan
    await acceptValidateToCount(executor, deps, atMaxPlan, 120n)
    await awaitSends(deps.queryConn, 5)
    const samples = tableFromArrays({
      total_rows: BigInt64Array.from(Array.from({ length: rows }, () => 120n)),
      fail_count: BigInt64Array.from(Array.from({ length: rows }, () => 120n)),
      sample_index: BigInt64Array.from(Array.from({ length: rows }, (_, i) => BigInt(i))),
      assay_row_ordinal: BigInt64Array.from(Array.from({ length: rows }, (_, i) => BigInt(i))),
      assay_value: BigInt64Array.from(Array.from({ length: rows }, () => 1n)),
    })
    deps.queryConn.resolveSend(4, samples)
    await awaitSends(deps.queryConn, 6)
    const keyTable = tableFromArrays({
      assay_overlay_ord: Array.from({ length: rows }, (_, i) => i),
      assay_row_id: Array.from({ length: rows }, (_, i) => `base:b#${String(i)}`),
    })
    deps.queryConn.resolveSend(5, keyTable)
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(
      6,
      tableFromArrays({ rule_id: ['columns[0].required'], total_rows: [120], fail_count: [120] }),
    )
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    await awaitSends(deps.queryConn, 9)
    deps.queryConn.resolveSend(8, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    if (posted.type !== 'engine/validate-result') return
    expect(posted.result.rules[0]?.failCount).toBe(120)
    expect(posted.result.rules[0]?.sampleFailures).toHaveLength(VALIDATION_SAMPLE_HARD_MAX)
    expectNoCollisions(deps)
  })

  it('rejects the reviewer canary plan before any SQL runs (m5-2 fix round)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // The review's exact probe, belt 1: a plan carrying
    // `CREATE TABLE review_injected AS SELECT 1` is a typed rejection at the
    // gate — zero statements reach the engine, so the canary can never be
    // attempted, let alone persist.
    const canary = parseValidationPlan({
      ...validPlanFixture(),
      rules: [
        {
          ruleId: 'columns[0].required',
          path: 'columns[0].required',
          kind: 'required',
          column: 'id',
          outcome: 'row-samples',
          sql: 'CREATE TABLE review_injected AS SELECT 1',
        },
      ],
    }) as EngineValidationPlan
    executor.accept(validateRequest(2, canary))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toContain(
        "rule 'columns[0].required' is not a single compiler-shaped SELECT",
      )
    }
    expect(deps.queryConn.sentSqls).toEqual([])
    // No BEGIN was even issued: the gate precedes the containment transaction.
    executor.accept(queryRequest(3, 'SELECT 42 AS answer'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it("refuses the reviewer's commented pseudo-reference before any SQL runs (m5-2 round-3, item 1)", async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // The round-3 probe: a block comment carrying the exact compiler FROM
    // shape (`SELECT … /* FROM "relation" AS "src" *\/`) — the commented
    // pseudo-reference must NOT count as a relation binding, and any
    // comment-bearing SQL is refused outright: one typed error, zero SQL.
    const commented = parseValidationPlan({
      ...validPlanFixture(),
      rules: [
        {
          ruleId: 'columns[0].required',
          path: 'columns[0].required',
          kind: 'required',
          column: 'id',
          outcome: 'row-samples',
          sql:
            'SELECT 1 AS "total_rows", 0 AS "fail_count" ' +
            '/* FROM "assay_conf_validate_src" AS "src" */',
        },
      ],
    }) as EngineValidationPlan
    executor.accept(validateRequest(2, commented))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toContain(
        "rule 'columns[0].required' contains SQL comments; the compiler emits none",
      )
    }
    // Zero SQL: the probe never reached the engine, and it is reusable.
    expect(deps.queryConn.sentSqls).toEqual([])
    executor.accept(queryRequest(3, 'SELECT 42 AS answer'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('rejects a binding-name collision with one typed error before any SQL runs', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    const plan = validPlanFixture()
    const hostile = parseValidationPlan({ ...plan, relation: 'assay_t1' }) as EngineValidationPlan
    executor.accept(validateRequest(2, hostile))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toContain('collides with a registered table view')
    }
    // No connection work happened at all — no view was created or dropped.
    expect(deps.queryConn.sentSqls).toEqual([])
    // The engine is reusable.
    executor.accept(queryRequest(3, 'SELECT 42 AS answer'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it("fails the reviewer's two-row probe with one typed error, never an out-of-contract result (m5-2 round-3, item 3)", async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // The review's exact scenario: a shape-valid (but foreign, non-compiler)
    // plan whose rule reports failCount 3 over a 2-row dataset. The old
    // behavior produced failPercent 150, an out-of-contract response the
    // protocol discarded — and the client's promise hung forever. The
    // result-sanity guard turns it into ONE typed error, after cleanup.
    await acceptValidateToCount(executor, deps, validPlanFixture(), 2n)
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(
      4,
      tableFromArrays({
        total_rows: BigInt64Array.from([2n, 2n]),
        fail_count: BigInt64Array.from([3n, 3n]),
        sample_index: BigInt64Array.from([0n, 1n]),
        assay_row_ordinal: BigInt64Array.from([0n, 1n]),
        assay_value: BigInt64Array.from([1n, 1n]),
      }),
    )
    // Cleanup settles BEFORE the error is posted: DROP of the op-created
    // view, then ROLLBACK (the requested rollback-order pin, here on the
    // count-guard failure path).
    await awaitSends(deps.queryConn, 6)
    expect(deps.queryConn.sentSqls[5]).toContain(`DROP VIEW IF EXISTS "${BINDING}"`)
    deps.queryConn.resolveSend(5, tableFromArrays({}))
    await awaitSends(deps.queryConn, 7)
    expect(deps.queryConn.sentSqls[6]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(6, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toBe(
        "validation rule 'columns[0].required' reported more failures than rows in the effective view",
      )
    }
    // The engine is reusable (a follow-up query still works).
    executor.accept(queryRequest(3, 'SELECT 42 AS answer'))
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('bounds a dataset-fact rule by ONE: a fact reporting failCount 2 is a foreign plan (m5-4 refinement)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // The m5-2 uniform bound (failCount ≤ rowCount) cannot see this probe:
    // 2 ≤ 120 would parse as shape-valid. The m5-4 refined per-outcome
    // bound can: a dataset-fact rule is a boolean fact — it holds or
    // fails, never "fails twice" — so a compiler-shaped fact reporting 2
    // over 120 rows is a foreign, non-compiler plan and fails with ONE
    // typed error (the same class as the row-count bound; the message
    // distinguishes the bound).
    await acceptValidateToCount(executor, deps, factPlanWithCount(2), 120n)
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(
      4,
      tableFromArrays({
        total_rows: BigInt64Array.from([120n]),
        fail_count: BigInt64Array.from([2n]),
      }),
    )
    // Cleanup settles BEFORE the error is posted (the W2 order pin).
    await awaitSends(deps.queryConn, 6)
    expect(deps.queryConn.sentSqls[5]).toContain(`DROP VIEW IF EXISTS "${BINDING}"`)
    deps.queryConn.resolveSend(5, tableFromArrays({}))
    await awaitSends(deps.queryConn, 7)
    expect(deps.queryConn.sentSqls[6]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(6, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toBe(
        "validation rule 'dataset.min-rows' reported more than one failure for a dataset-fact rule",
      )
    }
    // The engine is reusable (a follow-up query still works).
    executor.accept(queryRequest(3, 'SELECT 42 AS answer'))
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('ACCEPTS a dataset-fact failCount 1 over an EMPTY dataset as the honest violation (m5-4 refinement)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // The defect that motivated the refinement: `dataset.min-rows ≥ 1`
    // over 0 rows legitimately reports failCount 1 > rowCount 0 — under
    // the m5-2 uniform bound that was refused as a foreign plan (an
    // execution error for a perfectly valid contract + honestly violating
    // dataset). The refined bound accepts it: the op RESOLVES with
    // valid: false (the violation), failPercent 0 (the documented
    // empty-dataset convention), and no error.
    await acceptValidateToCount(executor, deps, factPlanFixture(), 0n)
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(
      4,
      tableFromArrays({
        total_rows: BigInt64Array.from([0n]),
        fail_count: BigInt64Array.from([1n]),
      }),
    )
    // A fact carries no samples → no row-key query; summary next.
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(
      5,
      tableFromArrays({ rule_id: ['dataset.min-rows'], total_rows: [0], fail_count: [1] }),
    )
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(6, tableFromArrays({}))
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/validate-result', requestId: 2 })
    if (posted.type !== 'engine/validate-result') return
    expect(posted.result).toEqual({
      valid: false,
      rowCount: 0,
      rules: [
        {
          ruleId: 'dataset.min-rows',
          outcome: 'dataset-fact',
          failCount: 1,
          failPercent: 0,
          sampleFailures: [],
        },
      ],
    })
    expect(deps.queryConn.sentSqls.at(-1)).toBe('ROLLBACK')
    expectNoCollisions(deps)
  })

  it('fails loudly when the summary disagrees with a per-rule count', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    await acceptValidateToCount(executor, deps, validPlanFixture())
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, samplesTable())
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(
      5,
      tableFromArrays({ assay_overlay_ord: [0, 3], assay_row_id: ['base:b#0', 'base:b#3'] }),
    )
    await awaitSends(deps.queryConn, 7)
    // Lying summary: reports 1 where the per-rule query saw 2.
    deps.queryConn.resolveSend(
      6,
      tableFromArrays({ rule_id: ['columns[0].required'], total_rows: [4], fail_count: [1] }),
    )
    // The cleanup (DROP of the op-created view + ROLLBACK) must settle before
    // the op's typed error is posted.
    await awaitSends(deps.queryConn, 8)
    expect(deps.queryConn.sentSqls[7]).toContain(`DROP VIEW IF EXISTS "${BINDING}"`)
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    await awaitSends(deps.queryConn, 9)
    expect(deps.queryConn.sentSqls[8]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(8, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toContain('disagrees with the per-rule count')
    }
    expectNoCollisions(deps)
  })

  it('never drops a pre-existing view when the create fails; rolls back instead (review item 2)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    executor.accept(validateRequest(2, validPlanFixture()))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, describeTable())
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, tableFromArrays({})) // BEGIN
    await awaitSends(deps.queryConn, 3)
    // The binding name already exists (a user-created view): the CREATE
    // fails, so THIS operation never created a view...
    deps.queryConn.rejectSend(2, new Error('Catalog Error: name already exists'))
    // Belt 2 still settles: the (empty) transaction is rolled back.
    await awaitSends(deps.queryConn, 4)
    expect(deps.queryConn.sentSqls[3]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(3, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      // Item 6: the raw catalog error is mapped to a privacy-safe class.
      expect(posted.message).toBe('the validation binding view could not be materialized')
    }
    // ...so no DROP may run: the pre-existing user view must survive.
    expect(deps.queryConn.sentSqls.some((sql) => sql.includes('DROP VIEW'))).toBe(false)
    expectNoCollisions(deps)
  })

  it('maps raw engine errors to privacy-safe classes and still cleans up (review item 6)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    executor.accept(validateRequest(2, validPlanFixture()))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, describeTable())
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, tableFromArrays({})) // BEGIN
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, tableFromArrays({})) // CREATE VIEW
    await awaitSends(deps.queryConn, 4)
    deps.queryConn.resolveSend(3, countTable(4n))
    await awaitSends(deps.queryConn, 5)
    // A DuckDB conversion error carrying an offending VALUE: none of it may
    // leave the worker.
    deps.queryConn.rejectSend(
      4,
      new Error("Conversion Error: Could not convert string 'hunter2secret' to BIGINT"),
    )
    // The op-created view is still dropped, and the transaction rolled back.
    await awaitSends(deps.queryConn, 6)
    expect(deps.queryConn.sentSqls[5]).toContain(`DROP VIEW IF EXISTS "${BINDING}"`)
    deps.queryConn.resolveSend(5, tableFromArrays({}))
    await awaitSends(deps.queryConn, 7)
    expect(deps.queryConn.sentSqls[6]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(6, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toBe("validation rule 'columns[0].required' failed to execute")
      expect(posted.message).not.toContain('hunter2secret')
    }
    // The engine is reusable.
    executor.accept(queryRequest(3, 'SELECT 42 AS answer'))
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, intTable([42]))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/query-result' })
    expectNoCollisions(deps)
  })

  it('runs the row-key query INSIDE the containment: its failure still rolls back, in order (W2 pin)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // The specifically requested rollback-order pin: the row-key query (the
    // step between the per-rule queries and the summary) fails — the op
    // posts its typed error only AFTER the DROP (op-created view) and the
    // ROLLBACK have run, in that order.
    await acceptValidateToCount(executor, deps, validPlanFixture())
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, samplesTable())
    await awaitSends(deps.queryConn, 6)
    // A raw engine-looking error on the row-key scan: none of it may leave.
    deps.queryConn.rejectSend(5, new Error('Internal Error: row-key scan blew up'))
    await awaitSends(deps.queryConn, 7)
    expect(deps.queryConn.sentSqls[6]).toContain(`DROP VIEW IF EXISTS "${BINDING}"`)
    deps.queryConn.resolveSend(6, tableFromArrays({}))
    await awaitSends(deps.queryConn, 8)
    expect(deps.queryConn.sentSqls[7]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toBe('the validation row-key query failed to execute')
      expect(posted.message).not.toContain('row-key scan blew up')
    }
    expectNoCollisions(deps)
  })

  it('surfaces a failed cleanup DROP as a typed error instead of success (m5-2 round-3, W2)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // Cleanup runs BEFORE any success is posted: a failing DROP (of the
    // op-created view) must fail the op with its own typed error — never a
    // success observed before containment completed, never a swallowed
    // error. The ROLLBACK still runs after the failed DROP.
    await acceptValidateToCount(executor, deps, factPlanFixture())
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, factTable())
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(
      5,
      tableFromArrays({ rule_id: ['dataset.min-rows'], total_rows: [4], fail_count: [0] }),
    )
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.rejectSend(6, new Error('Catalog Error: cannot drop'))
    await awaitSends(deps.queryConn, 8)
    expect(deps.queryConn.sentSqls[7]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toBe('the validation binding view could not be dropped')
      expect(posted.message).not.toContain('Catalog Error')
    }
    expectNoCollisions(deps)
  })

  it('surfaces a failed ROLLBACK as a typed error instead of success (m5-2 round-3, W2)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    // Same contract for the rollback itself: a failing ROLLBACK (the
    // connection is broken afterwards) fails the op with one typed error —
    // the client never sees a success that outran containment.
    await acceptValidateToCount(executor, deps, factPlanFixture())
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, factTable())
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(
      5,
      tableFromArrays({ rule_id: ['dataset.min-rows'], total_rows: [4], fail_count: [0] }),
    )
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(6, tableFromArrays({})) // DROP ok
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.rejectSend(7, new Error('TransactionContext Error: rollback failed'))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toBe('the validation containment transaction could not be rolled back')
    }
    expectNoCollisions(deps)
  })

  it('serializes behind a parked query (never head-of-line blocks windows)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)

    // A long user query parks the query lane.
    executor.accept(queryRequest(2, 'SELECT 1'))
    await awaitSends(deps.queryConn, 1)

    // The validate enqueues behind it: no second pending query on the lane.
    executor.accept(validateRequest(3, factPlanFixture()))
    await flush()
    expect(deps.queryConn.sentSqls).toHaveLength(1)

    // The parked query settles; only then does the validate start (FIFO).
    deps.queryConn.resolveSend(0, intTable([1]))
    expect(await awaitPosted(deps, 2)).toMatchObject({ type: 'engine/query-result' })
    await awaitSends(deps.queryConn, 2)
    expect(deps.queryConn.sentSqls[1]).toBe('DESCRIBE "assay_t1"')
    deps.queryConn.resolveSend(1, describeTable())
    await awaitSends(deps.queryConn, 3)
    expect(deps.queryConn.sentSqls[2]).toBe('BEGIN TRANSACTION')
    deps.queryConn.resolveSend(2, tableFromArrays({}))
    // Drain the scripted validate to completion (failure paths covered above).
    await awaitSends(deps.queryConn, 4)
    expect(deps.queryConn.sentSqls[3]).toContain(`CREATE VIEW "${BINDING}"`)
    deps.queryConn.resolveSend(3, tableFromArrays({}))
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, countTable(4n))
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(5, factTable())
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(
      6,
      tableFromArrays({ rule_id: ['dataset.min-rows'], total_rows: [4], fail_count: [0] }),
    )
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, tableFromArrays({}))
    await awaitSends(deps.queryConn, 9)
    deps.queryConn.resolveSend(8, tableFromArrays({}))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/validate-result' })
    expect(deps.queryConn.sentSqls.at(-1)).toBe('ROLLBACK')
    expectNoCollisions(deps)
  })

  it('rejects an unknown table handle with a typed error', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    executor.accept({
      type: 'engine/validate',
      requestId: 2,
      tableId: 'nope',
      plan: validPlanFixture(),
    })
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    expect(deps.queryConn.sentSqls).toEqual([])
  })
})

// m6-2: row-diff staging + execution (engine/diff-stage, engine/diff)
// ─────────────────────────────────────────────────────────────────────────────

const COMPARISON_FILE = new File([new Uint8Array([9, 9, 9])], 'comparison.parquet')

/** A real compiler-shaped plan (relations `assay_diff_a` / `assay_diff_b`, K default 2). */
function rowDiffPlanFixture(sampleLimit = 2): EngineRowDiffPlan {
  const result = compileRowDiffPlan(
    [
      { name: 'id', type: 'BIGINT' },
      { name: 'val', type: 'VARCHAR' },
    ],
    [
      { name: 'id', type: 'BIGINT' },
      { name: 'val', type: 'VARCHAR' },
    ],
    ['id'],
    { relationA: 'assay_diff_a', relationB: 'assay_diff_b', sampleLimit },
  )
  if (!result.ok) throw new Error(`fixture compile failed: ${JSON.stringify(result.errors)}`)
  return result.plan
}

function diffRequest(id: number, plan: EngineRowDiffPlan): EngineRequest {
  return { type: 'engine/diff', requestId: id, tableId: 't1', comparisonId: 'd1', plan }
}

/** Empty aspect result (count 0, no samples) and an all-zero totals table. */
function emptyAspectTable(): Table {
  return tableFromArrays({})
}
function zeroTotalsTable(): Table {
  return tableFromArrays({
    assay_aspect: ['added', 'removed', 'changed'],
    assay_count: BigInt64Array.from([0n, 0n, 0n]),
  })
}

/** A changed-aspect result table: one `['val']` change per A-side ordinal. */
function changedAspectTable(count: number, ordinals: readonly number[]): Table {
  return new Table({
    assay_side: vectorFromArray(ordinals.map(() => 'A')),
    assay_row_ordinal: vectorFromArray(ordinals.map((ordinal) => BigInt(ordinal))),
    assay_changed: vectorFromArray(
      ordinals.map(() => ['val']),
      new List(new Field('item', new Utf8())),
    ),
    sample_index: vectorFromArray(ordinals.map((_, index) => BigInt(index))),
    assay_count: vectorFromArray(ordinals.map(() => BigInt(count))),
  })
}

/** An A-side ordinal → logical row-key table (the m5-2 resolution channel). */
function aKeyTable(entries: readonly (readonly [number, string])[]): Table {
  return tableFromArrays({
    assay_overlay_ord: BigInt64Array.from(entries.map(([ordinal]) => BigInt(ordinal))),
    assay_row_id: entries.map(([, key]) => key),
  })
}

/** Stage a comparison through the full flow and wait for its result. */
async function stageComparison(
  executor: EngineOpExecutor,
  deps: FakeDeps,
  requestId = 2,
): Promise<void> {
  executor.accept({
    type: 'engine/diff-stage',
    requestId,
    name: 'comparison.parquet',
    file: COMPARISON_FILE,
  })
  await awaitSends(deps.queryConn, 1)
  expect(deps.queryConn.sentSqls[0]).toMatch(/CREATE VIEW "assay_diff_d1"/)
  deps.queryConn.resolveSend(0, intTable([]))
  await awaitSends(deps.queryConn, 2)
  expect(deps.queryConn.sentSqls[1]).toBe('DESCRIBE "assay_diff_d1"')
  deps.queryConn.resolveSend(1, describeTable())
  const posted = await awaitPosted(deps, requestId)
  expect(posted).toMatchObject({ type: 'engine/diff-stage-result', comparisonId: 'd1' })
}

describe('EngineOpExecutor row-diff execution (m6-2; query lane)', () => {
  it('stages a comparison and runs the plan inside a rolled-back transaction', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    await stageComparison(executor, deps)
    // The comparison file was registered under its engine-generated name.
    expect(deps.registeredFiles.map((entry) => entry.name)).toContain('diff_d1')

    executor.accept(diffRequest(3, rowDiffPlanFixture()))
    await awaitSends(deps.queryConn, 3) // DESCRIBE "assay_t1" (base composition)
    expect(deps.queryConn.sentSqls[2]).toBe('DESCRIBE "assay_t1"')
    deps.queryConn.resolveSend(2, describeTable())
    await awaitSends(deps.queryConn, 4)
    expect(deps.queryConn.sentSqls[3]).toBe('BEGIN TRANSACTION')
    deps.queryConn.resolveSend(3, tableFromArrays({}))
    await awaitSends(deps.queryConn, 5)
    expect(deps.queryConn.sentSqls[4]).toContain('CREATE VIEW "assay_diff_a"')
    deps.queryConn.resolveSend(4, tableFromArrays({}))
    await awaitSends(deps.queryConn, 6)
    expect(deps.queryConn.sentSqls[5]).toBe(
      'CREATE VIEW "assay_diff_b" AS SELECT * FROM "assay_diff_d1"',
    )
    deps.queryConn.resolveSend(5, tableFromArrays({}))
    await awaitSends(deps.queryConn, 7)
    expect(deps.queryConn.sentSqls[6]).toBe(
      'SELECT count(*)::BIGINT AS "row_count" FROM "assay_diff_a"',
    )
    deps.queryConn.resolveSend(6, countTable(4n))
    await awaitSends(deps.queryConn, 8)
    expect(deps.queryConn.sentSqls[7]).toBe(
      'SELECT count(*)::BIGINT AS "row_count" FROM "assay_diff_b"',
    )
    deps.queryConn.resolveSend(7, countTable(3n))
    // Three clamped aspect queries.
    for (let index = 0; index < 3; index += 1) {
      await awaitSends(deps.queryConn, 9 + index)
      expect(deps.queryConn.sentSqls[8 + index]).toContain('SELECT * FROM (')
      deps.queryConn.resolveSend(8 + index, emptyAspectTable())
    }
    await awaitSends(deps.queryConn, 12)
    expect(deps.queryConn.sentSqls[11]).toContain('UNION ALL')
    deps.queryConn.resolveSend(11, zeroTotalsTable())
    await awaitSends(deps.queryConn, 13)
    expect(deps.queryConn.sentSqls[12]).toBe('DROP VIEW IF EXISTS "assay_diff_a"')
    deps.queryConn.resolveSend(12, tableFromArrays({}))
    await awaitSends(deps.queryConn, 14)
    expect(deps.queryConn.sentSqls[13]).toBe('DROP VIEW IF EXISTS "assay_diff_b"')
    deps.queryConn.resolveSend(13, tableFromArrays({}))
    await awaitSends(deps.queryConn, 15)
    expect(deps.queryConn.sentSqls[14]).toBe('ROLLBACK')
    deps.queryConn.resolveSend(14, tableFromArrays({}))

    const posted = await awaitPosted(deps, 3)
    expect(posted).toMatchObject({ type: 'engine/diff-result' })
    if (posted.type === 'engine/diff-result') {
      expect(posted.result.rowCountA).toBe(4)
      expect(posted.result.rowCountB).toBe(3)
      expect(posted.result.aspects).toEqual([
        { aspect: 'added', count: 0, samples: [] },
        { aspect: 'removed', count: 0, samples: [] },
        { aspect: 'changed', count: 0, samples: [] },
      ])
    }
    expectNoCollisions(deps)
  })

  it('rejects a hostile plan that shadows a registered view BEFORE any SQL', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    await stageComparison(executor, deps)
    const plan = { ...rowDiffPlanFixture(), relationA: 'assay_t1' }
    executor.accept(diffRequest(3, plan))
    const posted = await awaitPosted(deps, 3)
    expect(posted).toMatchObject({ type: 'engine/error' })
    // Only the staging sends happened; the diff touched no connection.
    expect(deps.queryConn.sentSqls).toHaveLength(2)
  })

  it('answers a malformed recognised diff request with one typed error (never a hang)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    executor.accept({
      type: 'engine/diff',
      requestId: 2,
      tableId: 't1',
      comparisonId: 'd1',
      plan: { not: 'a plan' },
    })
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error', message: 'malformed envelope: diff.plan' })
    expect(deps.queryConn.sentSqls).toEqual([])
  })

  it('rejects an unknown comparison handle with a typed error (no SQL)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    executor.accept(diffRequest(2, rowDiffPlanFixture()))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    expect(deps.queryConn.sentSqls).toEqual([])
  })

  it('rejects an unsupported comparison extension and leaks no registration', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    executor.accept({
      type: 'engine/diff-stage',
      requestId: 2,
      name: 'comparison.xlsx',
      file: COMPARISON_FILE,
    })
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/error' })
    expect(deps.registeredFiles.map((entry) => entry.name)).not.toContain('diff_d1')
    expect(deps.queryConn.sentSqls).toEqual([])
  })

  it('re-staging replaces the previous comparison (single slot, no leak)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    await stageComparison(executor, deps, 2)
    // Re-stage: the previous view/file are dropped before the new registration.
    executor.accept({
      type: 'engine/diff-stage',
      requestId: 3,
      name: 'comparison.parquet',
      file: COMPARISON_FILE,
    })
    await awaitSends(deps.queryConn, 3)
    expect(deps.queryConn.sentSqls[2]).toBe('DROP VIEW IF EXISTS "assay_diff_d1"')
    deps.queryConn.resolveSend(2, tableFromArrays({}))
    await awaitSends(deps.queryConn, 4)
    expect(deps.queryConn.sentSqls[3]).toMatch(/CREATE VIEW "assay_diff_d2"/)
    deps.queryConn.resolveSend(3, intTable([]))
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, describeTable())
    const posted = await awaitPosted(deps, 3)
    expect(posted).toMatchObject({ type: 'engine/diff-stage-result', comparisonId: 'd2' })
    expect(deps.droppedFiles).toContain('diff_d1')
  })

  it('accepts a legal non-unique key join the old min-side bound rejected (changed 9)', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    await stageComparison(executor, deps)
    executor.accept(diffRequest(3, rowDiffPlanFixture(20)))
    await awaitSends(deps.queryConn, 3) // DESCRIBE the base view
    deps.queryConn.resolveSend(2, describeTable())
    await awaitSends(deps.queryConn, 4)
    deps.queryConn.resolveSend(3, tableFromArrays({})) // BEGIN
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, tableFromArrays({})) // CREATE A
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(5, tableFromArrays({})) // CREATE B
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(6, countTable(3n)) // count A
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, countTable(3n)) // count B
    await awaitSends(deps.queryConn, 9)
    deps.queryConn.resolveSend(8, emptyAspectTable()) // added
    await awaitSends(deps.queryConn, 10)
    deps.queryConn.resolveSend(9, emptyAspectTable()) // removed
    await awaitSends(deps.queryConn, 11)
    // A 3×3 key group: changed 9 > min(rowCountA, rowCountB) — legal output.
    deps.queryConn.resolveSend(10, changedAspectTable(9, [0, 0, 0, 1, 1, 1, 2, 2, 2]))
    await awaitSends(deps.queryConn, 12)
    deps.queryConn.resolveSend(
      11,
      aKeyTable([
        [0, 'base:a#0'],
        [1, 'base:a#1'],
        [2, 'base:a#2'],
      ]),
    ) // A-side row keys
    await awaitSends(deps.queryConn, 13)
    deps.queryConn.resolveSend(
      12,
      tableFromArrays({
        assay_aspect: ['added', 'removed', 'changed'],
        assay_count: BigInt64Array.from([0n, 0n, 9n]),
      }),
    ) // totals
    await awaitSends(deps.queryConn, 14)
    deps.queryConn.resolveSend(13, tableFromArrays({})) // DROP A
    await awaitSends(deps.queryConn, 15)
    deps.queryConn.resolveSend(14, tableFromArrays({})) // DROP B
    await awaitSends(deps.queryConn, 16)
    deps.queryConn.resolveSend(15, tableFromArrays({})) // ROLLBACK

    const posted = await awaitPosted(deps, 3)
    expect(posted.type).toBe('engine/diff-result')
    if (posted.type === 'engine/diff-result') {
      const changed = posted.result.aspects.find((aspect) => aspect.aspect === 'changed')
      expect(changed?.count).toBe(9)
      expect(changed?.samples).toHaveLength(9)
      expect(changed?.samples[0]).toEqual({
        side: 'A',
        rowKey: 'base:a#0',
        changedColumns: ['val'],
      })
    }
    expectNoCollisions(deps)
  })

  it('catches a changed-count inflation inside the pair bound via the totals agreement', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    await stageComparison(executor, deps)
    executor.accept(diffRequest(3, rowDiffPlanFixture(20)))
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, describeTable())
    await awaitSends(deps.queryConn, 4)
    deps.queryConn.resolveSend(3, tableFromArrays({})) // BEGIN
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, tableFromArrays({})) // CREATE A
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(5, tableFromArrays({})) // CREATE B
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(6, countTable(100n)) // count A
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, countTable(100n)) // count B
    await awaitSends(deps.queryConn, 9)
    deps.queryConn.resolveSend(8, emptyAspectTable()) // added
    await awaitSends(deps.queryConn, 10)
    deps.queryConn.resolveSend(9, emptyAspectTable()) // removed
    await awaitSends(deps.queryConn, 11)
    // changed 1005 is inside 100 × 100 = 10 000, so the refined bound passes;
    // the totals arm (5) is the independent net that catches the inflation.
    deps.queryConn.resolveSend(10, changedAspectTable(1005, [0]))
    await awaitSends(deps.queryConn, 12)
    deps.queryConn.resolveSend(11, aKeyTable([[0, 'base:a#0']])) // A-side row keys
    await awaitSends(deps.queryConn, 13)
    deps.queryConn.resolveSend(
      12,
      tableFromArrays({
        assay_aspect: ['added', 'removed', 'changed'],
        assay_count: BigInt64Array.from([0n, 0n, 5n]),
      }),
    ) // totals — disagrees
    await awaitSends(deps.queryConn, 14)
    deps.queryConn.resolveSend(13, tableFromArrays({})) // DROP A
    await awaitSends(deps.queryConn, 15)
    deps.queryConn.resolveSend(14, tableFromArrays({})) // DROP B
    await awaitSends(deps.queryConn, 16)
    deps.queryConn.resolveSend(15, tableFromArrays({})) // ROLLBACK

    const posted = await awaitPosted(deps, 3)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toContain('totals query disagrees with the changed count')
    }
    expect(deps.queryConn.sentSqls).toContain('ROLLBACK')
    expectNoCollisions(deps)
  })

  it('rejects an aspect count past its result-sanity bound with a typed error', async () => {
    const { executor, deps } = makeExecutor()
    await openFlatTable(executor, deps)
    await stageComparison(executor, deps)
    // A shape-valid plan whose added arm reports more rows than side B has.
    const plan = rowDiffPlanFixture()
    const inflated: EngineRowDiffPlan = {
      ...plan,
      addedSql: plan.addedSql.replace(
        'count(*) OVER () AS "assay_count"',
        'count(*) OVER () + 1000 AS "assay_count"',
      ),
    }
    executor.accept(diffRequest(3, inflated))
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, describeTable())
    await awaitSends(deps.queryConn, 4)
    deps.queryConn.resolveSend(3, tableFromArrays({})) // BEGIN
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, tableFromArrays({})) // CREATE A
    await awaitSends(deps.queryConn, 6)
    deps.queryConn.resolveSend(5, tableFromArrays({})) // CREATE B
    await awaitSends(deps.queryConn, 7)
    deps.queryConn.resolveSend(6, countTable(0n)) // count A
    await awaitSends(deps.queryConn, 8)
    deps.queryConn.resolveSend(7, countTable(0n)) // count B
    await awaitSends(deps.queryConn, 9)
    deps.queryConn.resolveSend(
      8,
      tableFromArrays({
        assay_side: ['B'],
        assay_row_ordinal: BigInt64Array.from([0n]),
        sample_index: BigInt64Array.from([0n]),
        assay_count: BigInt64Array.from([1000n]),
      }),
    )
    // The excess fails the op; the containment cleanup still runs in order.
    await awaitSends(deps.queryConn, 10)
    deps.queryConn.resolveSend(9, tableFromArrays({})) // DROP VIEW A
    await awaitSends(deps.queryConn, 11)
    deps.queryConn.resolveSend(10, tableFromArrays({})) // DROP VIEW B
    await awaitSends(deps.queryConn, 12)
    deps.queryConn.resolveSend(11, tableFromArrays({})) // ROLLBACK
    const posted = await awaitPosted(deps, 3)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      expect(posted.message).toContain('added')
    }
    // Containment still ran: the binding views were dropped and the tx rolled back.
    expect(deps.queryConn.sentSqls).toContain('DROP VIEW IF EXISTS "assay_diff_a"')
    expect(deps.queryConn.sentSqls).toContain('ROLLBACK')
  })
})

// ── p-3: pipeline materialization ops (source registration + node views) ────
//
// The runner drives these two typed query-lane ops; the executor owns the
// engine-boundary gates: the p-2 read-only SQL classifier, the reserved
// `assay_*` relation refusal, idempotent source replacement, and value-free
// failure classes. Query-lane routing is proven by every SQL landing on
// `deps.queryConn` (never the registry lane).

function pipelineSourceRequest(id: number, relation = 'customers'): EngineRequest {
  return {
    type: 'engine/pipeline-source',
    requestId: id,
    relation,
    name: 'flat.parquet',
    file: FLAT_FILE,
  }
}
function pipelineMaterializeRequest(id: number, sql: string, relation = 'out'): EngineRequest {
  return { type: 'engine/pipeline-materialize', requestId: id, relation, sql }
}
function pipelineHandleRequest(id: number, relation = 'out'): EngineRequest {
  return { type: 'engine/pipeline-handle', requestId: id, relation }
}

describe('EngineOpExecutor pipeline materialization (p-3)', () => {
  it('registers a source, creates a named view on the query lane, and counts it', async () => {
    const { executor, deps } = makeExecutor()
    executor.accept(pipelineSourceRequest(1))
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe(
      `CREATE OR REPLACE VIEW "customers" AS SELECT * FROM read_parquet('assay_pipeline_src_1')`,
    )
    deps.queryConn.resolveSend(0, tableFromArrays({}))
    await awaitSends(deps.queryConn, 2)
    expect(deps.queryConn.sentSqls[1]).toBe(
      'SELECT count(*)::BIGINT AS "row_count" FROM "customers"',
    )
    deps.queryConn.resolveSend(1, countTable(5n))
    expect(await awaitPosted(deps, 1)).toMatchObject({
      type: 'engine/pipeline-source-result',
      relation: 'customers',
      rowCount: 5,
    })
    expect(deps.registeredFiles.map((file) => file.name)).toEqual(['assay_pipeline_src_1'])
    expectNoCollisions(deps)
  })

  it('replaces a source registration idempotently (drops the previous view + file)', async () => {
    const { executor, deps } = makeExecutor()
    executor.accept(pipelineSourceRequest(1))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, tableFromArrays({}))
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, countTable(5n))
    await awaitPosted(deps, 1)

    executor.accept(pipelineSourceRequest(2))
    await awaitSends(deps.queryConn, 3)
    expect(deps.queryConn.sentSqls[2]).toBe('DROP VIEW IF EXISTS "customers"')
    deps.queryConn.resolveSend(2, tableFromArrays({}))
    await awaitSends(deps.queryConn, 4)
    expect(deps.queryConn.sentSqls[3]).toBe(
      `CREATE OR REPLACE VIEW "customers" AS SELECT * FROM read_parquet('assay_pipeline_src_2')`,
    )
    deps.queryConn.resolveSend(3, tableFromArrays({}))
    await awaitSends(deps.queryConn, 5)
    deps.queryConn.resolveSend(4, countTable(5n))
    expect(await awaitPosted(deps, 2)).toMatchObject({
      type: 'engine/pipeline-source-result',
      relation: 'customers',
      rowCount: 5,
    })
    expect(deps.droppedFiles).toContain('assay_pipeline_src_1')
    expectNoCollisions(deps)
  })

  it('materializes a node view on the query lane and counts it', async () => {
    const { executor, deps } = makeExecutor()
    executor.accept(pipelineMaterializeRequest(1, 'SELECT 1 AS value'))
    await awaitSends(deps.queryConn, 1)
    expect(deps.queryConn.sentSqls[0]).toBe('CREATE OR REPLACE VIEW "out" AS SELECT 1 AS value')
    deps.queryConn.resolveSend(0, tableFromArrays({}))
    await awaitSends(deps.queryConn, 2)
    expect(deps.queryConn.sentSqls[1]).toBe('SELECT count(*)::BIGINT AS "row_count" FROM "out"')
    deps.queryConn.resolveSend(1, countTable(1n))
    expect(await awaitPosted(deps, 1)).toMatchObject({
      type: 'engine/pipeline-materialize-result',
      relation: 'out',
      rowCount: 1,
    })
    expectNoCollisions(deps)
  })

  it('refuses side-effect SQL at the boundary before any engine call (p-2 gate pinned)', async () => {
    const { executor, deps } = makeExecutor()
    executor.accept(pipelineMaterializeRequest(1, 'DROP TABLE customers'))
    expect(await awaitPosted(deps, 1)).toMatchObject({ type: 'engine/error' })
    expect(deps.queryConn.sentSqls).toEqual([])
    expect(deps.conn.sentSqls).toEqual([])
  })

  it('refuses reserved assay_* relations before any engine call', async () => {
    const { executor, deps } = makeExecutor()
    executor.accept(pipelineMaterializeRequest(1, 'SELECT 1', 'assay_t1'))
    expect(await awaitPosted(deps, 1)).toMatchObject({ type: 'engine/error' })
    expect(deps.queryConn.sentSqls).toEqual([])
    expect(deps.conn.sentSqls).toEqual([])
  })

  it('drops pipeline views and source registrations on dispose', async () => {
    const { executor, deps } = makeExecutor()
    executor.accept(pipelineSourceRequest(1))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, tableFromArrays({}))
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, countTable(5n))
    await awaitPosted(deps, 1)

    executor.accept(pipelineMaterializeRequest(2, 'SELECT 1 AS value'))
    await awaitSends(deps.queryConn, 3)
    deps.queryConn.resolveSend(2, tableFromArrays({}))
    await awaitSends(deps.queryConn, 4)
    deps.queryConn.resolveSend(3, countTable(1n))
    await awaitPosted(deps, 2)

    executor.accept(disposeRequest(3))
    await awaitSends(deps.conn, 1)
    deps.conn.resolveSend(0, tableFromArrays({}))
    await awaitSends(deps.conn, 2)
    deps.conn.resolveSend(1, tableFromArrays({}))
    expect(await awaitPosted(deps, 3)).toMatchObject({ type: 'engine/disposed' })
    expect(deps.conn.sentSqls).toContain('DROP VIEW IF EXISTS "customers"')
    expect(deps.conn.sentSqls).toContain('DROP VIEW IF EXISTS "out"')
    expect(deps.droppedFiles).toContain('assay_pipeline_src_1')
  })

  it('opens an existing relation as a handle on the registry lane and schema-addresses it (p2-1 (b))', async () => {
    const { executor, deps } = makeExecutor()
    // Seed a materialized relation (query lane) — the handle op then addresses it.
    executor.accept(pipelineMaterializeRequest(1, 'SELECT 1 AS value'))
    await awaitSends(deps.queryConn, 1)
    deps.queryConn.resolveSend(0, tableFromArrays({}))
    await awaitSends(deps.queryConn, 2)
    deps.queryConn.resolveSend(1, countTable(1n))
    await awaitPosted(deps, 1)

    executor.accept(pipelineHandleRequest(2))
    await awaitSends(deps.conn, 1) // registry-lane existence probe
    expect(deps.conn.sentSqls[0]).toBe('SELECT 1 FROM "out" LIMIT 0')
    deps.conn.resolveSend(0, tableFromArrays({}))
    const posted = await awaitPosted(deps, 2)
    expect(posted).toMatchObject({ type: 'engine/pipeline-handle-result', relation: 'out' })
    if (posted.type !== 'engine/pipeline-handle-result') throw new Error('expected a handle')

    // The handle resolves through the ordinary registry ops.
    executor.accept({ type: 'engine/schema', requestId: 3, tableId: posted.tableId })
    await awaitSends(deps.conn, 2)
    deps.conn.resolveSend(1, describeTable())
    const schema = await awaitPosted(deps, 3)
    expect(schema.type).toBe('engine/schema-result')
    expectNoCollisions(deps)
  })

  it('fails value-free when the relation does not exist, without registering a handle (p2-1 (b))', async () => {
    const { executor, deps } = makeExecutor()
    executor.accept(pipelineHandleRequest(1, 'ghost'))
    await awaitSends(deps.conn, 1)
    deps.conn.rejectSend(0, new Error('Catalog Error: view ghost does not exist'))
    const posted = await awaitPosted(deps, 1)
    expect(posted).toMatchObject({ type: 'engine/error' })
    if (posted.type === 'engine/error') {
      // Value-free: the raw engine text (which can name relations) is dropped.
      expect(posted.message).toBe('the pipeline relation is not available in this session')
      expect(posted.message).not.toContain('ghost')
    }
    // No handle was registered: a schema request for the next generated id fails.
    executor.accept({ type: 'engine/schema', requestId: 2, tableId: 't1' })
    const schema = await awaitPosted(deps, 2)
    expect(schema).toMatchObject({ type: 'engine/error' })
  })

  it('refuses reserved assay_* relations before any engine call (p2-1 (b))', async () => {
    const { executor, deps } = makeExecutor()
    executor.accept(pipelineHandleRequest(1, 'assay_overlay_ord'))
    expect(await awaitPosted(deps, 1)).toMatchObject({ type: 'engine/error' })
    expect(deps.conn.sentSqls).toEqual([])
    expect(deps.queryConn.sentSqls).toEqual([])
  })
})
