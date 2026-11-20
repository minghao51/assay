// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CSV preview/open dispatch handlers (D04a), extracted from
 * `engine-executor.ts` into an engine-local module.
 *
 * What moved: the acceptance-time preview capture and refusal, the non-adopting
 * CSV preview op, the open op (the one op that adopts a reviewed option set),
 * and the preview-slot release that open/dispose supersede with. What did NOT
 * move: routing (`accept`), the two pending-query lanes, the session-table and
 * pipeline registries, the Arrow transport/cleanup helper, and the response
 * post — every handler receives them through ONE explicit
 * {@link EngineHandlerContext} (no global service locator, no module-level
 * mutable state; the executor stays the single owner).
 *
 * Invariants this module must keep byte-identical (D04a is a seam extraction,
 * not a semantics change):
 * - request validation runs BEFORE any engine touch (option vocabulary, format,
 *   sample-rows bound) and the main thread is never trusted;
 * - the preview is non-adopting: bare file registration under the slot's own
 *   name, never a session table, never a `TableRegistry` entry (ADR 0049);
 * - the slot's release ordering is view-then-file, both swallowed, and only
 *   the slot's own engine-generated names may reach a DROP (allowlist guard);
 * - supersession checkpoints stay exactly where they were, so a preview that
 *   an open overtook never installs and answers with the typed error;
 * - the sample is bounded by `MAX_RANGE_ROWS` and transported with its cap
 *   STATED, never as a validation verdict; the first-batch cleanup gating stays
 *   with `streamFirstBatch` (the reader is released before anything is posted);
 * - the ENG-3 payload shape and the composed SQL text are unchanged.
 */
import type { Table } from 'apache-arrow'
import { createViewSql, detectFileFormat, quotedIdentifier } from './format-view.js'
import {
  csvCreateViewSql,
  csvSampleSql,
  csvSniffSql,
  effectiveCsvOptions,
  parseCsvOptions,
} from './csv-options.js'
import type { EngineCsvOptions } from './csv-options.js'
import { errorMessage } from './errors.js'
import type { EngineConnectionLike, EngineHandlerContext } from './executor-context.js'
import { assertPreviewViewName } from './preview-registry.js'
import type { StagedPreview } from './preview-registry.js'
import type { EngineCsvPreviewRequest, EngineCsvPreviewSample, EngineCsvSniff } from './protocol.js'
import { MAX_RANGE_ROWS } from './range-window.js'

/**
 * The value-free supersession reply for a preview that an open overtook
 * mid-flight (the other-lane race): the op never installs, releases whatever
 * landed, and the caller gets exactly one typed reply instead of the late
 * result payload (which is discarded — the open owns the session now).
 */
const PREVIEW_SUPERSEDED_MESSAGE = 'the CSV preview was superseded by an open'

/**
 * The acceptance-time capture for one csv-preview request (EW-03I round-2
 * race fix): taken SYNCHRONOUSLY in `accept` before the request queues
 * behind query-lane work, and threaded through `dispatch` to the op. The op
 * re-checks `generation` at every checkpoint — an open that completed while
 * the preview sat queued has already moved it, and the op then answers with
 * the typed supersession error instead of ever touching the engine.
 */
export interface CapturedPreviewState {
  readonly intent: StagedPreview
  readonly generation: number
  readonly options: EngineCsvOptions
  readonly rowCap: number
}

/**
 * The synchronous capture seam: the slot registry the intent is reserved in
 * plus the response post that answers a refusal. Captured in `accept` BEFORE
 * the request queues, so no lane or session is involved yet.
 */
export type PreviewCaptureContext = Pick<EngineHandlerContext, 'previews' | 'post'>

/** The slot-release seam: the slot registry plus best-effort file deregistration. */
export type PreviewSlotContext = Pick<EngineHandlerContext, 'deps' | 'previews'>

/**
 * The acceptance-time capture for one csv-preview request: the slot intent
 * (synchronously reserved — the name is the queued op's), the generation it
 * must re-check at every checkpoint, and the canonical options + sample
 * row cap from the same synchronous refusals. Captured in `accept` BEFORE
 * any lane await; see the race-fix note there.
 */
export function captureCsvPreviewIntent(
  ctx: PreviewCaptureContext,
  request: EngineCsvPreviewRequest,
): CapturedPreviewState | undefined {
  const parsed = parseCsvOptions(request.options ?? {}, 'preview')
  if (!parsed.ok) {
    ctx.post({ type: 'engine/error', requestId: request.requestId, message: parsed.reason })
    return undefined
  }
  if (detectFileFormat(request.name) !== 'csv') {
    ctx.post({
      type: 'engine/error',
      requestId: request.requestId,
      message: 'csv preview requires a .csv file: this op reviews the CSV reader only',
    })
    return undefined
  }
  let rowCap: number
  try {
    rowCap = normalizePreviewSampleRows(request.sampleRows)
  } catch (error) {
    ctx.post({
      type: 'engine/error',
      requestId: request.requestId,
      message: errorMessage(error),
    })
    return undefined
  }
  const intent = ctx.previews.reserve()
  return {
    intent,
    generation: ctx.previews.beginIntent(),
    options: parsed.options,
    rowCap,
  }
}

/**
 * Register the picked file and create its per-format view. The file is
 * registered under the generated table id, so user-controlled names never
 * enter SQL (see `table-registry.ts` / `format-view.ts`). A failure rolls
 * the registration back so a failed open leaves no phantom entry behind.
 *
 * EW-03I (ADR 0049 decision 1): an optional CSV option set may ride the
 * request — the adoption of an already-reviewed set. It is re-validated
 * here (the main thread is untrusted) and refused before ANY engine touch;
 * `sample_size` is preview-only and refused by the same parse (context
 * 'open'). Options compose the view's scan (`csvCreateViewSql`); the
 * no-options path keeps the pre-EW-03I SQL byte-identical. Any open —
 * adoption or not — supersedes the review flow, so the preview slot is
 * released best-effort first (ADR 0049 item 5: adoption is a fresh
 * `engine/open`; the slot's release is its own, never host-reachable).
 */
export async function runOpenHandler(
  ctx: EngineHandlerContext,
  requestId: number,
  name: string,
  file: File,
  options: Record<string, unknown> | undefined,
): Promise<void> {
  const format = detectFileFormat(name)
  if (format === null) {
    // No file names in messages (ADR 0025) — the extension kind is enough.
    throw new Error(
      'unsupported dataset format: this engine reads .parquet, .csv, .jsonl and .json files',
    )
  }
  let csvOptions: EngineCsvOptions | undefined
  if (options !== undefined) {
    if (format !== 'csv') {
      throw new Error('csv options require a .csv file: the other readers take no options')
    }
    const parsed = parseCsvOptions(options, 'open')
    if (!parsed.ok) throw new Error(parsed.reason)
    csvOptions = parsed.options
  }
  const conn = ctx.lane.connection(await ctx.deps.ensureSession())
  await releasePreviewSlot(ctx, conn)
  const entry = ctx.registry.reserve(format)
  try {
    // Lazy reference registration: with the BROWSER_FILEREADER protocol the
    // engine reads the File through slice + FileReaderSync on demand —
    // nothing is copied until a query touches it (verified against the
    // 1.32.0 worker bundle's runtime: protocol case 2). The real protocol
    // constant is injected by the worker entry (deps.registerFileHandle).
    await ctx.deps.registerFileHandle(entry.registeredFileName, file)
    const viewSql =
      csvOptions === undefined
        ? createViewSql(entry.viewName, entry.registeredFileName, format)
        : csvCreateViewSql(entry.viewName, entry.registeredFileName, csvOptions)
    await conn.query(viewSql)
    ctx.post({ type: 'engine/open-result', requestId, tableId: entry.tableId, format })
  } catch (error) {
    ctx.registry.remove(entry.tableId)
    await ctx.deps.dropFile(entry.registeredFileName).catch(() => undefined)
    throw error
  }
}

/**
 * The non-adopting CSV preview (EW-03I; ADR 0049 decisions 1/4/6, probe
 * proven by the acquisition record). Refusals happen BEFORE any engine
 * touch (the worker re-validates — the main thread is untrusted). Staging:
 * drop the previous slot first (view-then-file, best-effort), then register
 * the candidate under the slot's OWN name via `registerFileHandle` — bare
 * registration, no view (the probe: scans need none). The sniff query and
 * the optional bounded sample then read the registered name directly; a
 * failure there is the engine's own (honest EH first line where available,
 * ADR 0048) and never classified from its text. The slot stays live on such
 * a failure — the ADR's "failure after the slot registered → +1 until the
 * next slot event or dispose" — and the sample is transported with its cap
 * STATED, never as a validation verdict (a sample is not a check).
 */
export async function runCsvPreviewHandler(
  ctx: EngineHandlerContext,
  request: EngineCsvPreviewRequest,
  captured: CapturedPreviewState,
): Promise<void> {
  // The synchronous refusals (vocabulary, format, inference budget) and the
  // slot intent + supersede generation already ran at ACCEPTANCE
  // (EngineOpExecutor.accept → captureCsvPreviewIntent) — before this
  // op queued behind query-lane work. First checkpoint: a preview that
  // queued behind an open never touches the engine at all — no session, no
  // registration, no SQL — and is answered with the typed supersession
  // error instead of a result.
  if (!ctx.previews.isCurrent(captured.generation)) {
    throw new Error(PREVIEW_SUPERSEDED_MESSAGE)
  }
  const intent = captured.intent
  const options = captured.options
  let conn: EngineConnectionLike | undefined
  try {
    conn = ctx.lane.connection(await ctx.deps.ensureSession())
    // Sequential drop-before-restage: previews serialize on the query lane
    // (their OPS do — acceptance-time intents may queue), so a live slot
    // here belongs to a settled op; release it view-then-file, best-effort,
    // WITHOUT bumping our own generation.
    const previous = ctx.previews.clearStaged()
    if (previous !== null) {
      assertPreviewViewName(previous.viewName)
      await conn
        .query(`DROP VIEW IF EXISTS ${quotedIdentifier(previous.viewName)}`)
        .catch(() => undefined)
      await ctx.deps.dropFile(previous.registeredFileName).catch(() => undefined)
    }
    // The acquisition probe's proven call: the lazy File handle under the
    // slot's own name — no byte copy, no view, no catalog object.
    await ctx.deps.registerFileHandle(intent.registeredFileName, request.file)
    if (!ctx.previews.isCurrent(captured.generation)) {
      // An open completed while this registration was in flight: never
      // install — release what landed (below) and answer with the typed
      // supersession error instead of the late result payload.
      throw new Error(PREVIEW_SUPERSEDED_MESSAGE)
    }
    ctx.previews.confirm(intent)
    const sniffRows = await conn.query(csvSniffSql(intent.registeredFileName, options))
    const sniff = readSniffPayload(sniffRows)
    let sample: EngineCsvPreviewSample | null = null
    if (captured.rowCap > 0) {
      const { batchIpc, hasMore } = await ctx.streamFirstBatch(
        conn,
        csvSampleSql(intent.registeredFileName, options, captured.rowCap),
      )
      sample = { batchIpc, hasMore, rowCap: captured.rowCap }
    }
    if (!ctx.previews.isCurrent(captured.generation)) {
      // Superseded while scanning: the open already released the live slot;
      // the check-then-post pair below is synchronous, so a stale result is
      // never delivered.
      throw new Error(PREVIEW_SUPERSEDED_MESSAGE)
    }
    ctx.post({
      type: 'engine/csv-preview-result',
      requestId: request.requestId,
      previewId: intent.previewId,
      sniff,
      effectiveOptions: effectiveCsvOptions(options),
      sample,
    })
  } catch (error) {
    if (!ctx.previews.isCurrent(captured.generation)) {
      // Superseded at some checkpoint: NEVER install — release whatever
      // landed. The dropFile is the half that removes the bytes and is
      // db-level (needs no connection); the view never existed on a
      // superseded-in-registration path, and on a superseded-in-scan path
      // the superseding open already dropped it — `DROP VIEW IF EXISTS` is
      // attempted only when a connection exists and is swallowed either
      // way. dropFile on a missing/already-dropped name does not throw
      // (probe D1), so the double release is harmless.
      if (conn !== undefined) {
        await conn
          .query(`DROP VIEW IF EXISTS ${quotedIdentifier(intent.viewName)}`)
          .catch(() => undefined)
      }
      await ctx.deps.dropFile(intent.registeredFileName).catch(() => undefined)
      throw new Error(PREVIEW_SUPERSEDED_MESSAGE)
    }
    // Not superseded: the slot keeps tracking the name even on failure —
    // the ADR's "+1 retained until the next slot event or dispose" row
    // (dropFile on a missing name does not throw — probe D1).
    ctx.previews.confirm(intent)
    throw error
  }
}

/**
 * Supersede-and-release for the OTHER-lane slot events (open, dispose):
 * invalidates any in-flight preview intent (its op self-releases at its
 * next checkpoint and never installs) and best-effort releases the live
 * slot, view-then-file, both halves swallowed — the acquisition probe:
 * `DROP VIEW IF EXISTS` never throws on a missing view, a failed view drop
 * must still reach the `dropFile`, and `dropFile` on a missing name does
 * not throw. Never host-reachable: the only triggers are an open, dispose,
 * and (sequentially, via `clearStaged`) the next preview dispatch. The
 * preview NEVER reads its candidate's bytes back (`copyFileToBuffer`
 * poisons the release into a 1-byte stub — probe D3).
 */
export async function releasePreviewSlot(
  ctx: PreviewSlotContext,
  conn: EngineConnectionLike,
): Promise<void> {
  const staged = ctx.previews.supersede()
  if (staged === null) return
  // Allowlist guard: only the slot's own engine-generated names may ever
  // reach a DROP statement (the registry is their only producer — pinned by
  // the id→name shape tests).
  assertPreviewViewName(staged.viewName)
  await conn
    .query(`DROP VIEW IF EXISTS ${quotedIdentifier(staged.viewName)}`)
    .catch(() => undefined)
  await ctx.deps.dropFile(staged.registeredFileName).catch(() => undefined)
}

/**
 * The preview sample window (EW-03I): absent = the worker cap — the same
 * `MAX_RANGE_ROWS` bound every row window obeys, so a sample is a grid-sized
 * head read and never a full scan — 0 = no sample, otherwise clamped DOWN to
 * the cap. Semantic validation lives here in the worker (the boundary is
 * untrusted), mirroring `validateRowWindow`'s client+worker double pass.
 */
function normalizePreviewSampleRows(value: unknown): number {
  if (value === undefined) return MAX_RANGE_ROWS
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('csv preview sampleRows must be a non-negative safe integer')
  }
  return Math.min(value, MAX_RANGE_ROWS)
}

/**
 * Read the sniff disclosure from the sniff_csv result (one row). Column names
 * are exactly the engine's (probed on the shipped browser build: EW-03D B1/B2
 * and the acquisition record's sniff legs); anything else is a value-free
 * engine-deviation error, never a guessed field.
 *
 * The dialect values are transported VERBATIM as the sniffer's own TEXT, which
 * is not raw bytes and not an empty string (B02/ENG-3):
 *
 * - an UNSET `Quote`/`Escape`/`Comment` is the literal seven characters
 *   `(empty)` — `hex(Quote)` = `28656D70747929` on the installed DuckDB v1.5.5
 *   and in the browser build, NOT a NULL and NOT `''`;
 * - `NewLineDelimiter` is ESCAPE TEXT: `\n` (two characters) for an LF file
 *   and `\r\n` for a CRLF file, i.e. what `new_line = '…'` would be written
 *   as;
 * - `Delimiter` (and a real `Quote`/`Escape`) is an actual character
 *   (`hex` = `2C`, `22`, `09`).
 *
 * Normalising that representation here was rejected (plan B02): the web
 * display adapter interprets the sentinel for display and the D3-1 header
 * scan decodes the escape text separately, while this payload keeps the shape
 * the rename-list equality gate was verified against. DateFormat/TimestampFormat/
 * Prompt stay null when the engine reports null. The `Prompt` is transported
 * verbatim as display text — nothing composes SQL from it (ADR 0049 item 3).
 */
function readSniffPayload(result: Table): EngineCsvSniff {
  const unexpected = 'sniff_csv returned an unexpected shape'
  if (result.numRows !== 1) throw new Error(unexpected)
  const dialect = (name: string): string => {
    const value: unknown = result.getChild(name)?.get(0)
    return typeof value === 'string' ? value : ''
  }
  const nullableText = (name: string): string | null => {
    const value: unknown = result.getChild(name)?.get(0)
    return typeof value === 'string' ? value : null
  }
  const skipRowsValue: unknown = result.getChild('SkipRows')?.get(0)
  if (
    typeof skipRowsValue !== 'number' ||
    !Number.isSafeInteger(skipRowsValue) ||
    skipRowsValue < 0
  ) {
    throw new Error(unexpected)
  }
  const hasHeaderValue: unknown = result.getChild('HasHeader')?.get(0)
  if (typeof hasHeaderValue !== 'boolean') throw new Error(unexpected)
  const columnsVector = result.getChild('Columns')
  if (columnsVector === null) throw new Error(unexpected)
  const columnsValue: unknown = columnsVector.get(0)
  if (columnsValue === null || columnsValue === undefined) throw new Error(unexpected)
  // Arrow 17 delivers the list's one cell as an iterable of struct rows (a
  // Vector — same shape the profile quantile reader consumes), never a plain
  // JS array.
  let entries: unknown[]
  try {
    entries = Array.from(columnsValue as Iterable<unknown>)
  } catch {
    throw new Error(unexpected)
  }
  const columns = entries.map((entry) => {
    const record = entry as Record<string, unknown> | null
    const name: unknown = record === null || record === undefined ? undefined : record['name']
    const type: unknown = record === null || record === undefined ? undefined : record['type']
    if (typeof name !== 'string' || typeof type !== 'string') throw new Error(unexpected)
    return { name, type }
  })
  return {
    delimiter: dialect('Delimiter'),
    quote: dialect('Quote'),
    escape: dialect('Escape'),
    newLineDelimiter: dialect('NewLineDelimiter'),
    comment: dialect('Comment'),
    skipRows: skipRowsValue,
    hasHeader: hasHeaderValue,
    columns,
    dateFormat: nullableText('DateFormat'),
    timestampFormat: nullableText('TimestampFormat'),
    prompt: nullableText('Prompt'),
  }
}
