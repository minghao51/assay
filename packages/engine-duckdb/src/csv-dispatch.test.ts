// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Focused unit tests for the D04a handler seam (`./csv-dispatch`).
 *
 * `engine-executor.test.ts` drives these handlers end-to-end through the
 * worker request loop (204 tests unchanged by the extraction). What it cannot
 * show is the seam itself, which is what these tests pin:
 *
 * - the ONE explicit context is the handler's only reach: the connection a
 *   handler touches is `ctx.lane.connection`, never a session connection it
 *   picked for itself (the m2-7 routing/connection identity);
 * - a refusal answers through `ctx.post` and takes NO slot intent — no
 *   session, no registration, no SQL;
 * - a stale capture never touches the engine at all (supersession checkpoint
 *   ordering is preserved across the move);
 * - the slot release stays view-then-file, both halves swallowed, and still
 *   bumps the generation for the open/dispose supersede contract.
 *
 * The fakes are deliberately minimal local doubles (no DuckDB, no timers,
 * scripted results) so the tests run under Node.
 */
import {
  Field,
  List,
  Table,
  Utf8,
  makeBuilder,
  makeVector,
  Struct,
  tableFromArrays,
  vectorFromArray,
} from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import { captureCsvPreviewIntent, releasePreviewSlot, runCsvPreviewHandler } from './csv-dispatch'
import type { CapturedPreviewState } from './csv-dispatch'
import { TableRegistry } from './table-registry'
import { PreviewRegistry } from './preview-registry'
import { OpChannel } from './op-channel'
import type {
  EngineConnectionLike,
  EngineHandlerContext,
  EngineOpLane,
  EngineResultReaderLike,
} from './executor-context'
import type { EngineCsvPreviewRequest, EngineResponse } from './protocol'

const CANDIDATE_CSV = new File([new TextEncoder().encode('id,amount\n1,2.5\n')], 'candidate.csv')

const SNIFF_STRUCT_TYPE = new Struct([new Field('name', new Utf8()), new Field('type', new Utf8())])
const SNIFF_COLUMNS_TYPE = new List(new Field('struct', SNIFF_STRUCT_TYPE, true))

/** One string-or-null cell as a finished one-row Utf8 vector. */
function textOrNullVector(value: string | null) {
  return vectorFromArray([value], new Utf8())
}

/**
 * The `sniff_csv` result shape the shipped DuckDB build reports (the same
 * three-column disclosure `engine-executor.test.ts` scripts): one row, the
 * engine's own column names, dialect values as verbatim TEXT.
 */
function sniffTable(): Table {
  const columnsBuilder = makeBuilder({ type: SNIFF_COLUMNS_TYPE })
  columnsBuilder.append([{ name: 'id', type: 'BIGINT' }])
  return new Table({
    Delimiter: vectorFromArray([',']),
    Quote: vectorFromArray(['']),
    Escape: vectorFromArray(['']),
    NewLineDelimiter: vectorFromArray(['\\n']),
    Comment: vectorFromArray(['']),
    SkipRows: makeVector(Uint32Array.from([0])),
    HasHeader: vectorFromArray([true]),
    Columns: columnsBuilder.finish().toVector(),
    DateFormat: textOrNullVector(null),
    TimestampFormat: textOrNullVector(null),
    Prompt: textOrNullVector("FROM read_csv('preview_p1');"),
  })
}

/** A connection that records every statement it is asked to run. */
class RecordingConnection implements EngineConnectionLike {
  readonly sqls: string[] = []
  /** When set, the NEXT DROP VIEW rejects (the release must still drop the file). */
  dropError: unknown = null

  async query(sql: string): Promise<Table> {
    this.sqls.push(sql)
    if (sql.startsWith('DROP VIEW')) {
      const failure = this.dropError
      this.dropError = null
      if (failure !== null) throw failure
      return tableFromArrays({})
    }
    return sniffTable()
  }

  send(): Promise<EngineResultReaderLike> {
    throw new Error('send is not used: the handler streams through ctx.streamFirstBatch')
  }

  cancelSent(): Promise<unknown> {
    return Promise.resolve(null)
  }
}

interface Harness {
  readonly ctx: EngineHandlerContext
  readonly posted: EngineResponse[]
  readonly registered: string[]
  readonly dropped: string[]
  readonly previews: PreviewRegistry
  readonly registry: TableRegistry
  /** The statements handed to the first-batch transport (the bounded sample). */
  readonly streamed: string[]
  /** `ensureSession` calls — 0 proves the op never touched the engine. */
  bootCalls(): number
}

/**
 * The explicit context under test. Note the deliberate split: `deps` supplies
 * a session whose connections are `sessionConn`, while the LANE returns
 * `laneConn` — a handler that reached for the session connection instead of
 * its lane's would show up on the wrong recorder.
 */
function makeHarness(laneConn: EngineConnectionLike, sessionConn: EngineConnectionLike): Harness {
  const posted: EngineResponse[] = []
  const registered: string[] = []
  const dropped: string[] = []
  const streamed: string[] = []
  const previews = new PreviewRegistry()
  const registry = new TableRegistry()
  let boots = 0
  const lane: EngineOpLane = { channel: new OpChannel(), connection: () => laneConn }
  const ctx: EngineHandlerContext = {
    deps: {
      ensureSession: () => {
        boots += 1
        return Promise.resolve({
          getVersion: () => Promise.resolve('v-test'),
          conn: sessionConn,
          queryConn: sessionConn,
        })
      },
      registerFileHandle: (registeredFileName) => {
        registered.push(registeredFileName)
        return Promise.resolve()
      },
      dropFile: (registeredFileName) => {
        dropped.push(registeredFileName)
        return Promise.resolve(null)
      },
      copyExportBytes: () => Promise.resolve(new Uint8Array()),
      writeExportFile: () => Promise.resolve(),
      post: () => undefined,
    },
    registry,
    previews,
    lane,
    streamFirstBatch: (_conn, sql) => {
      streamed.push(sql)
      return Promise.resolve({ batchIpc: new Uint8Array([1, 2, 3]), hasMore: false })
    },
    post: (response) => {
      posted.push(response)
    },
  }
  return { ctx, posted, registered, dropped, previews, registry, streamed, bootCalls: () => boots }
}

function previewRequest(
  requestId: number,
  overrides: Partial<EngineCsvPreviewRequest> = {},
): EngineCsvPreviewRequest {
  return {
    type: 'engine/csv-preview',
    requestId,
    name: 'candidate.csv',
    file: CANDIDATE_CSV,
    ...overrides,
  }
}

describe('csv-dispatch capture (D04a context seam)', () => {
  it('refuses before any engine touch and takes NO slot intent', () => {
    const harness = makeHarness(new RecordingConnection(), new RecordingConnection())
    const refusals = [
      [previewRequest(1, { options: { strict_mode: true } }), 'strict_mode'],
      [previewRequest(2, { name: 'flat.parquet' }), 'csv preview requires a .csv file'],
      [previewRequest(3, { sampleRows: -1 }), 'csv preview sampleRows must be a non-negative'],
    ] as const
    const messages: string[] = []
    for (const [request, expected] of refusals) {
      expect(captureCsvPreviewIntent(harness.ctx, request)).toBeUndefined()
      const posted = harness.posted[harness.posted.length - 1]
      if (posted.type !== 'engine/error') throw new Error('expected a refusal')
      messages.push(posted.message)
      expect(posted.message).toContain(expected)
    }
    // Every refusal posted exactly one typed error on its own requestId.
    expect(messages).toHaveLength(3)
    expect(harness.posted.map((response) => response.type)).toEqual([
      'engine/error',
      'engine/error',
      'engine/error',
    ])
    expect(harness.posted.map((response) => response.requestId)).toEqual([1, 2, 3])
    // No intent was reserved: the next slot is still the first id in the
    // sequence, so a refused request can never hold a preview name.
    expect(harness.previews.current()).toBeNull()
    expect(harness.previews.reserve().previewId).toBe('p1')
  })

  it('reserves the slot and captures the generation for an acceptable request', () => {
    const harness = makeHarness(new RecordingConnection(), new RecordingConnection())
    const captured = captureCsvPreviewIntent(
      harness.ctx,
      previewRequest(1, { options: { delim: ';' }, sampleRows: 42 }),
    )
    expect(captured).toBeDefined()
    const state = captured as CapturedPreviewState
    expect(state.intent).toEqual({
      previewId: 'p1',
      viewName: 'assay_preview_p1',
      registeredFileName: 'preview_p1',
    })
    // The generation is the one the op must re-check at every checkpoint.
    expect(state.generation).toBe(harness.previews.beginIntent())
    expect(state.options).toEqual({ delim: ';' })
    expect(state.rowCap).toBe(42)
    // Capture alone installs nothing — only the op's checkpoints confirm.
    expect(harness.previews.current()).toBeNull()
    // Nothing was posted and no engine seam was touched.
    expect(harness.posted).toEqual([])
    expect(harness.bootCalls()).toBe(0)
  })

  it('clamps the sample cap DOWN to the engine window bound', () => {
    const harness = makeHarness(new RecordingConnection(), new RecordingConnection())
    const captured = captureCsvPreviewIntent(
      harness.ctx,
      previewRequest(1, { sampleRows: Number.MAX_SAFE_INTEGER }),
    )
    expect(captured?.rowCap).toBeLessThan(Number.MAX_SAFE_INTEGER)
    expect(captured?.rowCap).toBe(1000)
  })
})

describe('csv-dispatch preview op (D04a context seam)', () => {
  it('reads the candidate on the LANE connection, never a session connection of its own', async () => {
    const laneConn = new RecordingConnection()
    const sessionConn = new RecordingConnection()
    const harness = makeHarness(laneConn, sessionConn)
    const captured = captureCsvPreviewIntent(harness.ctx, previewRequest(7)) as CapturedPreviewState
    await runCsvPreviewHandler(harness.ctx, previewRequest(7), captured)

    // Sniff then the bounded sample: both on the lane's connection, in this order.
    expect(laneConn.sqls[0]).toBe("SELECT * FROM sniff_csv('preview_p1')")
    // …and the bounded sample is the first-batch transport, cap stated.
    expect(harness.streamed).toEqual(["SELECT * FROM read_csv('preview_p1') LIMIT 1000"])
    // The session connection was never used: routing and connection choice
    // stay one decision (the m2-7 property the seam must not lose).
    expect(sessionConn.sqls).toEqual([])
    // Bare registration under the slot's own name; the slot is now live.
    expect(harness.registered).toEqual(['preview_p1'])
    expect(harness.previews.current()?.previewId).toBe('p1')
    // The ENG-3 payload shape is unchanged by the move.
    const posted = harness.posted[0]
    expect(posted.type).toBe('engine/csv-preview-result')
    if (posted.type === 'engine/csv-preview-result') {
      expect(posted.previewId).toBe('p1')
      expect(posted.sample).toEqual({
        batchIpc: new Uint8Array([1, 2, 3]),
        hasMore: false,
        rowCap: 1000,
      })
      expect(posted.sniff.delimiter).toBe(',')
    }
  })

  it('a stale capture never touches the engine and answers with the typed supersession error', async () => {
    const laneConn = new RecordingConnection()
    const harness = makeHarness(laneConn, new RecordingConnection())
    const captured = captureCsvPreviewIntent(harness.ctx, previewRequest(1)) as CapturedPreviewState
    // An open (or dispose) completes while the preview sat queued.
    harness.previews.supersede()
    await expect(runCsvPreviewHandler(harness.ctx, previewRequest(1), captured)).rejects.toThrow(
      'the CSV preview was superseded by an open',
    )
    expect(harness.bootCalls()).toBe(0)
    expect(harness.registered).toEqual([])
    expect(laneConn.sqls).toEqual([])
    expect(harness.posted).toEqual([])
  })
})

describe('csv-dispatch slot release (D04a context seam)', () => {
  it('drops the view then the file, and bumps the generation for the supersede contract', async () => {
    const conn = new RecordingConnection()
    const harness = makeHarness(conn, new RecordingConnection())
    const captured = captureCsvPreviewIntent(harness.ctx, previewRequest(1)) as CapturedPreviewState
    harness.previews.confirm(captured.intent)

    await releasePreviewSlot(harness.ctx, conn)

    // View-then-file, the established ordering (never host-reachable).
    expect(conn.sqls).toEqual(['DROP VIEW IF EXISTS "assay_preview_p1"'])
    expect(harness.dropped).toEqual(['preview_p1'])
    expect(harness.previews.current()).toBeNull()
    // The supersede invalidated the captured intent, so a queued preview is
    // stale at its next checkpoint.
    expect(harness.previews.isCurrent(captured.generation)).toBe(false)
  })

  it('swallows a failed view drop but still releases the file', async () => {
    const conn = new RecordingConnection()
    const harness = makeHarness(conn, new RecordingConnection())
    const captured = captureCsvPreviewIntent(harness.ctx, previewRequest(1)) as CapturedPreviewState
    harness.previews.confirm(captured.intent)
    conn.dropError = new Error('engine refused the DROP')

    await expect(releasePreviewSlot(harness.ctx, conn)).resolves.toBeUndefined()
    expect(harness.dropped).toEqual(['preview_p1'])
  })

  it('is a no-op when no slot is live (a queued intent is invalidated by the generation alone)', async () => {
    const conn = new RecordingConnection()
    const harness = makeHarness(conn, new RecordingConnection())
    const captured = captureCsvPreviewIntent(harness.ctx, previewRequest(1)) as CapturedPreviewState

    await releasePreviewSlot(harness.ctx, conn)

    expect(conn.sqls).toEqual([])
    expect(harness.dropped).toEqual([])
    expect(harness.previews.isCurrent(captured.generation)).toBe(false)
  })
})
