// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Data-source behavior suite (docs/engineering/03-repository-structure.md §4).
 *
 * Mandate: every DataSource adapter passes the same source behavior suite, so
 * adapters can evolve (or be added) without changing product behavior. The
 * suite is therefore **parameterized over a subject** — a
 * `DataSourceBehaviorSubject` adapter that exposes the source and its pick
 * flow through structural interfaces defined here. This package never imports
 * a data-sources implementation (dependency direction: implementations import
 * `@assay/testing` and provide the adapter — see the BrowserFileSource subject
 * in `@assay/data-sources/src/behavior-subject.ts`).
 *
 * Scenarios (the source surface Assay has today), locking the m1-3/m1-4
 * semantics against regression:
 *
 * 1. `identity-idempotency` — one source instance has one stable identity;
 *    `open()` is idempotent and yields the same frozen `DataHandle`; identity
 *    does not change across operations; a fresh instance over the same file is
 *    a new identity (no persistent file identity is claimed); repeated
 *    `metadata()` calls observe one consistent snapshot.
 * 2. `one-shot-file` — the underlying file is resolved lazily, exactly once,
 *    and cached: the handle is never re-acquired across `open()`/`metadata()`
 *    /`getFile()` interleavings, and the additive `getFile()` seam (m1-4)
 *    serves the identical cached snapshot; the fallback path resolves the
 *    exact `File` object it was constructed with.
 * 3. `metadata-contract` — `metadata()` reports the detected format and the
 *    exact size, and NOTHING else: no engine-owned fields (`rowCount`/
 *    `partitions`), no content or file-name fields (ADR 0025 spirit). An
 *    unknown extension is `'unknown'` and never blocks `open()`.
 * 4. `cancel-semantics` — user cancel is a settled `null`, never a rejection:
 *    an `AbortError`-named failure of the FSA picker resolves `null` (the
 *    contract is name-based; a DOM `AbortError` `DOMException` is an `Error`
 *    with that name), an empty picker result resolves `null`, and the
 *    input-fallback cancel (no file chosen) resolves `null`. Any non-abort
 *    failure propagates.
 * 5. `capability-matrix` — capability detection returns exactly two real
 *    booleans that reflect the scope structurally: a capability counts only
 *    when its API exists **as a function**, and the members are independent.
 * 6. `fallback-order` — documented R5 order: when the FSA picker is available
 *    it wins (asked for exactly one file, `multiple: false`) and the input
 *    fallback never runs; without it, the input fallback is used; the picked
 *    source wraps the file the chosen step produced.
 * 7. `acquisition-retry` — deliberate retry semantics for the lazily acquired
 *    `File` (B06/Q3): concurrent `open()`/`metadata()`/`getFile()` calls share
 *    one in-flight attempt and all observe its failure; the next call after a
 *    failure retries exactly once (a caller joining the retry shares it); an
 *    old rejection cannot clear a newer in-flight attempt; a fulfilled attempt
 *    is retained for the instance lifetime; a synchronous handle throw becomes
 *    the attempt's rejection instead of escaping synchronously; and a failed
 *    acquisition never logs the file name (ADR 0025).
 *
 * Environments: every type here is structural (no DOM names — a `File` and a
 * `FileSystemFileHandle` satisfy `BehaviorFile`/`BehaviorFileHandle` by
 * shape), so the suite compiles DOM-less in the root entry and needs no
 * `./browser` subpath. The suite's own logic is unit-tested in Node against a
 * compliant fake and deliberately non-compliant mutations
 * (`data-source-behavior.test.ts`); real sources prove themselves by running
 * the same scenarios through their subject (data-sources: Node vitest with
 * in-memory handles + the browser harness with genuine OPFS handles).
 */

// ---- Structural surface the suite exercises (implementations adapt to it) ----

/** The file surface the suite needs (a DOM `File` satisfies it by shape). */
export interface BehaviorFile {
  readonly name: string
  readonly size: number
}

/**
 * The handle seam, structurally (a `FileSystemFileHandle` satisfies it). The
 * suite wraps this to observe how often the file is resolved.
 */
export interface BehaviorFileHandle {
  readonly name: string
  getFile(): Promise<BehaviorFile>
}

/** Opaque handle to opened source data. */
export interface BehaviorDataHandle {
  readonly kind: string
  readonly sourceId: string
}

/**
 * Source metadata as the shipped `DataSourceMetadata` contract spells it.
 * The metadata-contract scenario additionally asserts — at runtime — that a
 * source reports exactly `format` + `sizeBytes` and none of the optional
 * engine fields.
 */
export interface BehaviorMetadata {
  format: string
  sizeBytes?: number
  rowCount?: number
  partitions?: string[]
}

/**
 * The source surface the suite drives. `getFile` is the additive m1-4 engine
 * seam — optional here because it is a source-side extra, not part of the
 * `DataSource` interface; the one-shot scenario asserts the handle-level
 * one-shot behavior for every source and the seam contract when present.
 */
export interface BehaviorDataSource {
  readonly id: string
  readonly kind: string
  open(): Promise<BehaviorDataHandle>
  metadata(): Promise<BehaviorMetadata>
  getFile?(): Promise<BehaviorFile>
}

/** How a picked file was obtained (the documented R5 strategies). */
export type BehaviorPickerStrategy = 'file-system-access' | 'input-fallback'

/** A picked file wrapped in a ready-to-use source. */
export interface BehaviorPickedFile {
  readonly via: BehaviorPickerStrategy
  readonly source: BehaviorDataSource
}

/** Capability flags (mirrors the shipped detection result shape). */
export type DataSourceCapabilityMatrix = {
  readonly filePicker: boolean
  readonly dataTransferHandle: boolean
}

/** Structural view of the globals capability detection may inspect. */
export interface BehaviorCapabilityScope {
  readonly showOpenFilePicker?: unknown
  readonly DataTransferItem?: {
    readonly prototype: {
      readonly getAsFileSystemHandle?: unknown
    }
  }
}

/** Options handed to the File System Access picker step. */
export interface BehaviorPickerOptions {
  readonly multiple: false
}

/**
 * Injectable steps for the pick flow. The subject maps them onto its own
 * picker entry point; the suite uses them to drive both branches and both
 * cancel surfaces deterministically.
 */
export interface BehaviorPickSteps {
  /** Capability matrix to feed the flow (omit → the implementation's default). */
  readonly capabilities?: DataSourceCapabilityMatrix
  /** FSA picker step (used when the matrix reports `filePicker`). */
  readonly showOpenFilePicker?: (options: BehaviorPickerOptions) => Promise<BehaviorFileHandle[]>
  /** Hidden-input step (used on the fallback path). */
  readonly pickViaHiddenInput?: () => Promise<BehaviorFile | null>
}

/** The adapter a data-sources implementation provides to run the suite. */
export interface DataSourceBehaviorSubject {
  /** Implementation identifier for reports (e.g. `browser-file-source`). */
  readonly name: string
  /**
   * The extension → format map this adapter's detection recognizes (the
   * shipped map is `FORMAT_BY_EXTENSION`; the Node fake mirrors it). The
   * `metadata-contract` scenario derives its probe matrix from this
   * declaration — never a hand-copied list — and requires every detected
   * format to have a `FORMAT_BEHAVIOR_MATRIX` slot, so a format added to the
   * adapter cannot silently escape the mandated same-suite (au3-11).
   */
  readonly formatByExtension: Readonly<Record<string, string>>
  /** A file object with the given name and size (contents are irrelevant). */
  makeFile(name: string, sizeBytes: number): BehaviorFile
  /** A handle serving the given file (call counting is the suite's job). */
  makeHandle(file: BehaviorFile): Promise<BehaviorFileHandle>
  /** Create a source the input-fallback way (from a plain file object). */
  createFallbackSource(file: BehaviorFile): BehaviorDataSource
  /** Create a source the File System Access way (from a handle). */
  createHandleSource(handle: BehaviorFileHandle): BehaviorDataSource
  /** Run the implementation's pick flow with the given injected steps. */
  pick(steps: BehaviorPickSteps): Promise<BehaviorPickedFile | null>
  /** Run capability detection against `scope` (omit → the real default scope). */
  detectCapabilities(scope?: BehaviorCapabilityScope): DataSourceCapabilityMatrix
}

// ---- Results ----

/** Stable scenario identifiers (each runs independently). */
export const dataSourceBehaviorScenarioNames = [
  'identity-idempotency',
  'one-shot-file',
  'metadata-contract',
  'cancel-semantics',
  'capability-matrix',
  'fallback-order',
  'acquisition-retry',
] as const

export type DataSourceBehaviorScenarioName = (typeof dataSourceBehaviorScenarioNames)[number]

/** Outcome of one scenario: pass/fail, a privacy-safe detail, and evidence. */
export interface DataSourceBehaviorScenarioResult {
  readonly name: DataSourceBehaviorScenarioName
  readonly passed: boolean
  /** Failure message (or `passed`); never contains dataset contents. */
  readonly detail: string
  /** Scenario-specific evidence (counts/flags) for reports and specs. */
  readonly facts: Readonly<Record<string, string | number | boolean>>
}

export interface DataSourceBehaviorReport {
  readonly subject: string
  readonly results: readonly DataSourceBehaviorScenarioResult[]
  readonly allPassed: boolean
}

// ---- Scenario helpers ----

function fail(message: string): never {
  throw new Error(message)
}

function expectCondition(condition: boolean, message: string): void {
  if (!condition) fail(message)
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    fail(`${what}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

/**
 * Await a promise expected to reject. Returns the rejection reason, or `null`
 * when the promise resolved (callers turn that into a conformance violation).
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  return null
}

/**
 * Stable JSON rendering (sorted object keys) for equality checks on plain
 * metadata objects and for privacy-safe failure details.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

/**
 * An `Error` named `AbortError` — what browsers raise when a picker dialog is
 * dismissed. The shipped cancel contract is name-based (`name ===
 * 'AbortError'`); a DOM `AbortError` `DOMException` is exactly an `Error` with
 * that name, so the suite drives the contract DOM-less.
 */
function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/** The exact metadata key set the shipped contract allows. */
const METADATA_KEYS = stableJson(['format', 'sizeBytes'])

function expectMetadataKeysExactlyFormatAndSize(metadata: BehaviorMetadata, what: string): void {
  const keys = stableJson(Object.keys(metadata))
  expectCondition(
    keys === METADATA_KEYS,
    `${what}: metadata must report exactly {format, sizeBytes} — no engine-owned fields (rowCount/partitions), no content or file-name fields (ADR 0025 spirit); got ${keys}`,
  )
}

/**
 * The metadata-contract behavior matrix: one slot per dataset format the suite
 * knows how to probe. The probe cases are derived from the adapter's own
 * `formatByExtension` declaration; this matrix is the suite's acknowledgement
 * gate — every format the adapter can detect must have a slot here or the
 * scenario fails loudly at setup (au3-11, the AU-3 §3 convention: oracle
 * matrices are declared by the subject, not hand-copied by the oracle).
 *
 * Adding a format to `FORMAT_BY_EXTENSION` therefore forces a deliberate
 * entry here (as `arrow`/`feather` have), rather than the same-suite quietly
 * never proving it.
 */
const FORMAT_BEHAVIOR_MATRIX: Readonly<Partial<Record<string, { readonly sizeBytes: number }>>> = {
  csv: { sizeBytes: 24 },
  json: { sizeBytes: 72 },
  jsonl: { sizeBytes: 56 },
  parquet: { sizeBytes: 48 },
  arrow: { sizeBytes: 64 },
  feather: { sizeBytes: 80 },
}

// ---- Scenarios ----

/** A promise plus its settlement handles — the suite scripts attempt outcomes itself. */
interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let queued microtasks and one macrotask turn run (late/queued work lands). */
function settleTurns(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

type DataSourceBehaviorScenario = (
  subject: DataSourceBehaviorSubject,
) => Promise<Record<string, string | number | boolean>>

const scenarios: Record<DataSourceBehaviorScenarioName, DataSourceBehaviorScenario> = {
  'identity-idempotency': async (subject) => {
    const file = subject.makeFile('assay-behavior-identity.csv', 24)
    const source = subject.createHandleSource(await subject.makeHandle(file))

    // Identity exists, is stable, and the handle names it.
    const idBefore = source.id
    const kindBefore = source.kind
    expectCondition(
      typeof idBefore === 'string' && idBefore.length > 0,
      'a source must expose a non-empty string id',
    )
    expectCondition(
      typeof kindBefore === 'string' && kindBefore.length > 0,
      'a source must expose a non-empty string kind',
    )

    const first = await source.open()
    expectEqual(first.kind, 'data-handle', 'handle kind')
    expectEqual(first.sourceId, idBefore, 'the handle sourceId must be the source id')

    // Idempotency: re-open resolves the identical frozen handle object.
    const second = await source.open()
    expectCondition(
      second === first,
      'open() must be idempotent: every call resolves the identical handle object',
    )
    expectCondition(Object.isFrozen(first), 'the DataHandle must be frozen (immutable)')

    // One consistent snapshot: repeated metadata() calls agree.
    const firstMetadata = await source.metadata()
    const secondMetadata = await source.metadata()
    expectCondition(
      stableJson(firstMetadata) === stableJson(secondMetadata),
      'metadata() must be stable across repeated calls (one consistent snapshot)',
    )

    // Identity does not change across operations.
    await source.open()
    expectEqual(source.id, idBefore, 'identity must not change across operations')
    expectEqual(source.kind, kindBefore, 'kind must not change across operations')

    // No persistent file identity: a fresh instance over the SAME file is a
    // new identity (the m1-3 contract deliberately does not claim more — that
    // would require persistent browser storage, ADR 0017 disposable-cache only).
    const sibling = subject.createHandleSource(await subject.makeHandle(file))
    expectCondition(
      sibling.id !== idBefore,
      'a fresh source instance over the same file must have its own identity',
    )

    // The fallback path ships the same semantics.
    const fallback = subject.createFallbackSource(
      subject.makeFile('assay-behavior-identity-fallback.json', 24),
    )
    const fallbackFirst = await fallback.open()
    expectEqual(fallbackFirst.kind, 'data-handle', 'fallback handle kind')
    expectEqual(fallbackFirst.sourceId, fallback.id, 'fallback handle sourceId')
    expectCondition(
      (await fallback.open()) === fallbackFirst,
      'the fallback path must ship the same open() idempotency',
    )

    return {
      reopenIdentical: true,
      frozenHandle: true,
      metadataStable: true,
      identityStable: true,
      freshInstanceNewId: true,
      fallbackIdempotent: true,
    }
  },

  'one-shot-file': async (subject) => {
    // The suite counts the handle's getFile() calls itself (counting
    // decorator), so the one-shot assertion bites regardless of what the
    // subject could claim.
    const file = subject.makeFile('assay-behavior-one-shot.parquet', 64)
    let handleGetFileCalls = 0
    const handle = await subject.makeHandle(file)
    const countingHandle: BehaviorFileHandle = {
      name: handle.name,
      getFile: () => {
        handleGetFileCalls += 1
        return handle.getFile()
      },
    }
    const source = subject.createHandleSource(countingHandle)
    expectEqual(
      handleGetFileCalls,
      0,
      'resolving the file must be lazy — no handle.getFile() before the first operation',
    )

    await source.open()
    await source.metadata()
    expectEqual(
      handleGetFileCalls,
      1,
      'open() + metadata() must resolve the file through the handle exactly once (one snapshot, never re-acquired)',
    )

    const facts: Record<string, string | number | boolean> = {
      lazyResolve: true,
      handleGetFileCalls,
    }
    if (typeof source.getFile === 'function') {
      // The additive m1-4 engine seam, per its documented contract: the File
      // resolved lazily once and cached — every call serves the identical
      // snapshot open()/metadata() observe.
      const getFile = source.getFile.bind(source)
      const first = await getFile()
      if (first === null || typeof first !== 'object') {
        fail('getFile() must resolve a file object')
      }
      const second = await getFile()
      expectCondition(
        second === first,
        'getFile() must serve the identical cached file snapshot on every call (one-shot per instance)',
      )
      expectEqual(first.name, file.name, 'the cached snapshot must be the staged file')
      expectEqual(first.size, file.size, 'the cached snapshot must keep the staged size')
      await source.metadata()
      await source.open()
      expectEqual(
        handleGetFileCalls,
        1,
        'the snapshot cache must hold across open()/metadata()/getFile() interleavings',
      )
      facts['fileSeam'] = 'shared'
    } else {
      // Sources without the seam are still bound by the handle-level one-shot
      // behavior asserted above; the seam assertions are recorded as absent
      // (never skipped silently in the facts).
      facts['fileSeam'] = 'absent'
    }

    // Fallback path: the given File object itself IS the snapshot (the
    // documented m1-3 contract: "the given File for the fallback path").
    const fallbackFile = subject.makeFile('assay-behavior-one-shot-fallback.csv', 32)
    const fallbackSource = subject.createFallbackSource(fallbackFile)
    if (typeof fallbackSource.getFile === 'function') {
      const resolved = await fallbackSource.getFile()
      expectCondition(
        resolved === fallbackFile,
        'the fallback path must resolve the exact File object it was constructed with',
      )
      facts['fallbackSnapshotExact'] = true
    }
    return facts
  },

  'metadata-contract': async (subject) => {
    // Format detection is extension-based and case-insensitive; sizes are the
    // exact staged byte counts. Names here are synthetic suite fixtures.
    //
    // The probe set is derived from the adapter's own declaration (au3-11):
    // the suite never hand-copies the list of formats, so a format the
    // adapter adds lands in the matrix automatically and must be acknowledged
    // in FORMAT_BEHAVIOR_MATRIX below.
    const declaredFormats = Object.entries(subject.formatByExtension)
    expectCondition(
      declaredFormats.length > 0,
      'subject misconfiguration: declare at least one detectable format in formatByExtension',
    )
    const formatBehaviorSlot = (format: string): { readonly sizeBytes: number } => {
      const slot = FORMAT_BEHAVIOR_MATRIX[format]
      if (slot === undefined) {
        fail(
          `subject misconfiguration: the adapter detects "${format}" but the metadata-contract behavior matrix has no slot for it — add one so the same-suite proves the format`,
        )
      }
      return slot
    }
    const cases: (readonly [name: string, sizeBytes: number, format: string])[] = []
    for (const [extension, format] of declaredFormats) {
      cases.push([
        `assay-behavior-contract.${extension}`,
        formatBehaviorSlot(format).sizeBytes,
        format,
      ])
    }
    // Extension matching is case-insensitive: probe the first declared
    // extension upper-cased (with a mixed-case base name) once.
    const [firstExtension, firstFormat] = declaredFormats[0]!
    cases.push([
      `assay-behavior-CONTRACT.${firstExtension.toUpperCase()}`,
      formatBehaviorSlot(firstFormat).sizeBytes,
      firstFormat,
    ])
    // The not-recognized outcome is not an extension: probe it separately.
    cases.push(['assay-behavior-contract.bin', 40, 'unknown'])

    let caseIndex = 0
    for (const [name, sizeBytes, format] of cases) {
      const source = subject.createHandleSource(
        await subject.makeHandle(subject.makeFile(name, sizeBytes)),
      )
      const metadata = await source.metadata()
      expectEqual(metadata.format, format, `case ${String(caseIndex)}: detected format`)
      expectEqual(
        metadata.sizeBytes,
        sizeBytes,
        `case ${String(caseIndex)}: sizeBytes must be the exact file size`,
      )
      expectMetadataKeysExactlyFormatAndSize(metadata, `case ${String(caseIndex)}`)
      if (format === 'unknown') {
        // Sources stay permissive: an unknown format never blocks open().
        expectEqual(
          (await source.open()).kind,
          'data-handle',
          `case ${String(caseIndex)}: an unknown format must not block open()`,
        )
      }
      caseIndex += 1
    }

    // The fallback path ships the same contract.
    const fallbackMetadata = await subject
      .createFallbackSource(subject.makeFile('assay-behavior-contract-fallback.json', 72))
      .metadata()
    expectEqual(fallbackMetadata.format, 'json', 'fallback case: detected format')
    expectEqual(fallbackMetadata.sizeBytes, 72, 'fallback case: sizeBytes must be the exact size')
    expectMetadataKeysExactlyFormatAndSize(fallbackMetadata, 'fallback case')

    return { casesProbed: cases.length + 1, keyCount: 2, engineFieldsUnset: true }
  },

  'cancel-semantics': async (subject) => {
    const fsaCapabilities: DataSourceCapabilityMatrix = {
      filePicker: true,
      dataTransferHandle: true,
    }

    // FSA dismiss (AbortError) settles null — user cancel is not an error.
    // (Rejection-of wrapper: a cancel surfaced as a rejection must be reported
    // as this violation, not escape the scenario as a raw error.)
    let abortThrown = false
    const aborted = await rejectionOf(
      subject.pick({
        capabilities: fsaCapabilities,
        showOpenFilePicker: async () => {
          abortThrown = true
          throw abortError('user dismissed the picker dialog')
        },
      }),
    )
    expectCondition(abortThrown, 'subject misconfiguration: the FSA picker step was never invoked')
    expectCondition(
      aborted === null,
      'an FSA AbortError must resolve null (user cancel is a settled null, never a rejection), but it rejected',
    )

    // A picker that yields no handle is also a settled null.
    const empty = await subject.pick({
      capabilities: fsaCapabilities,
      showOpenFilePicker: async () => [],
    })
    expectCondition(empty === null, 'a picker that resolves no handle must resolve null')

    // Any non-abort failure propagates — never swallowed into null.
    const propagated = await rejectionOf(
      subject.pick({
        capabilities: fsaCapabilities,
        showOpenFilePicker: async () => {
          throw new TypeError('security error')
        },
      }),
    )
    expectCondition(
      propagated !== null,
      'a non-abort picker failure must reject (propagate), not resolve null',
    )

    // Input-fallback cancel (no file chosen) settles null too — same
    // rejection-of wrapper so a rejecting cancel is reported as the violation.
    const inputCancelled = await rejectionOf(
      subject.pick({
        capabilities: { filePicker: false, dataTransferHandle: false },
        pickViaHiddenInput: async () => null,
      }),
    )
    expectCondition(
      inputCancelled === null,
      'an input-fallback cancel (no file chosen) must resolve null, but it rejected',
    )

    return {
      fsaCancelResolvedNull: true,
      emptyPickerResolvedNull: true,
      nonAbortPropagated: true,
      inputCancelResolvedNull: true,
    }
  },

  'capability-matrix': async (subject) => {
    const expectMatrix = (
      actual: DataSourceCapabilityMatrix,
      expected: DataSourceCapabilityMatrix,
      what: string,
    ): void => {
      expectCondition(
        typeof actual.filePicker === 'boolean' && typeof actual.dataTransferHandle === 'boolean',
        `${what}: both capability flags must be real booleans`,
      )
      expectCondition(
        actual.filePicker === expected.filePicker &&
          actual.dataTransferHandle === expected.dataTransferHandle,
        `${what}: expected ${stableJson(expected)}, got ${stableJson(actual)}`,
      )
    }

    const noop = () => undefined
    // A capability counts only when its API exists AS A FUNCTION, and the
    // members are detected independently (Firefox/older-Chromium mixes).
    expectMatrix(
      subject.detectCapabilities({
        showOpenFilePicker: noop,
        DataTransferItem: { prototype: { getAsFileSystemHandle: noop } },
      }),
      { filePicker: true, dataTransferHandle: true },
      'Chromium-like scope',
    )
    expectMatrix(
      subject.detectCapabilities({}),
      {
        filePicker: false,
        dataTransferHandle: false,
      },
      'scope without either API',
    )
    expectMatrix(
      subject.detectCapabilities({ showOpenFilePicker: noop }),
      { filePicker: true, dataTransferHandle: false },
      'picker without the DataTransfer handle (members are independent)',
    )
    expectMatrix(
      subject.detectCapabilities({ DataTransferItem: { prototype: {} } }),
      { filePicker: false, dataTransferHandle: false },
      'DataTransferItem without the handle method',
    )
    expectMatrix(
      subject.detectCapabilities({
        showOpenFilePicker: 42,
        DataTransferItem: { prototype: { getAsFileSystemHandle: 'yes' } },
      }),
      { filePicker: false, dataTransferHandle: false },
      'non-function members must not count as capabilities',
    )

    // The implementation's real default scope: detection must not throw and
    // must return booleans (its routing behavior is proven by fallback-order).
    const defaults = subject.detectCapabilities()
    expectCondition(
      typeof defaults.filePicker === 'boolean' && typeof defaults.dataTransferHandle === 'boolean',
      'default-scope detection must return booleans without throwing',
    )

    return { scopesProbed: 5, booleansOnly: true, defaultScopeSafe: true }
  },

  'fallback-order': async (subject) => {
    // R5 order: when the FSA picker is available it wins; the input fallback
    // runs only without it. The picked source must wrap the file the chosen
    // step produced.
    const stagedFile = subject.makeFile('assay-behavior-order.csv', 32)
    let pickerCalls = 0
    let pickerOptions: unknown
    let inputCalls = 0

    const viaFsa = await subject.pick({
      capabilities: { filePicker: true, dataTransferHandle: true },
      showOpenFilePicker: async (options) => {
        pickerCalls += 1
        pickerOptions = options
        return [await subject.makeHandle(stagedFile)]
      },
      pickViaHiddenInput: async () => {
        inputCalls += 1
        return stagedFile
      },
    })
    if (viaFsa === null) fail('the FSA branch must produce a picked file')
    expectEqual(viaFsa.via, 'file-system-access', 'via tag on the FSA branch')
    expectEqual(pickerCalls, 1, 'the FSA picker step must be used exactly once')
    expectCondition(
      inputCalls === 0,
      'the input fallback must not run when the FSA picker is available',
    )
    expectCondition(
      stableJson(pickerOptions) === stableJson({ multiple: false }),
      `the FSA picker must be asked for exactly one file ({multiple: false}), got ${stableJson(pickerOptions)}`,
    )
    const fsaMetadata = await viaFsa.source.metadata()
    expectEqual(fsaMetadata.format, 'csv', 'the picked source must wrap the FSA handle (format)')
    expectEqual(fsaMetadata.sizeBytes, 32, 'the picked source must wrap the FSA handle (size)')

    const fallbackFile = subject.makeFile('assay-behavior-order-fallback.csv', 40)
    let pickerCallsOnFallback = 0
    const viaInput = await subject.pick({
      capabilities: { filePicker: false, dataTransferHandle: false },
      showOpenFilePicker: async () => {
        pickerCallsOnFallback += 1
        return [await subject.makeHandle(fallbackFile)]
      },
      pickViaHiddenInput: async () => fallbackFile,
    })
    if (viaInput === null) {
      fail('the input fallback must produce a picked file when no FSA picker exists')
    }
    expectEqual(viaInput.via, 'input-fallback', 'via tag on the fallback branch')
    expectEqual(pickerCallsOnFallback, 0, 'the FSA picker must not run when it is unavailable')

    return {
      fsaBranchFirst: true,
      multipleAlwaysFalse: true,
      inputUnusedWhenPickerAvailable: true,
      fallbackOnlyWithoutPicker: true,
    }
  },

  'acquisition-retry': async (subject) => {
    // B06/Q3: the lazily acquired file is ONE in-flight attempt (shared by
    // every caller), a failed attempt is retryable exactly once on the next
    // call, an old rejection never clears a newer attempt, and a fulfilled
    // attempt is retained for the instance lifetime. The suite scripts the
    // attempts itself through the handle seam, so the assertions bite whatever
    // the subject claims.
    const snapshot = subject.makeFile('assay-behavior-retry.parquet', 48)
    const firstAttempt = deferred<BehaviorFile>()
    const retryAttempt = deferred<BehaviorFile>()
    let attempts = 0
    const scriptedHandle: BehaviorFileHandle = {
      name: snapshot.name,
      getFile: () => {
        attempts += 1
        if (attempts === 1) return firstAttempt.promise
        if (attempts === 2) return retryAttempt.promise
        return Promise.reject(new Error('unexpected acquisition attempt'))
      },
    }
    const source = subject.createHandleSource(scriptedHandle)
    const seam = source.getFile
    const getFile = typeof seam === 'function' ? seam.bind(source) : null

    // Every caller joins the one in-flight attempt; all observe its failure.
    const concurrent: Promise<unknown>[] = [source.open(), source.metadata()]
    if (getFile !== null) concurrent.push(getFile())
    expectEqual(attempts, 1, 'concurrent calls must share one in-flight acquisition attempt')

    firstAttempt.reject(new Error('NotAllowedError: permission revoked'))
    const failures = await Promise.all(concurrent.map((promise) => rejectionOf(promise)))
    for (const [index, failure] of failures.entries()) {
      expectCondition(
        failure !== null,
        `concurrent caller ${String(index)} must observe the shared acquisition failure`,
      )
    }
    expectEqual(attempts, 1, 'observing the shared failure must not start another attempt')

    // The next call retries exactly once. The retry stays in flight across
    // several turns — a late (or unconditional) clear queued by the first
    // rejection would drop it — and a caller joining it must share it.
    const retried = source.open()
    // The scenarios below decide the verdict; keep a would-be rejection from
    // surfacing as an unhandled rejection when an earlier assertion fails.
    retried.catch(() => undefined)
    expectEqual(attempts, 2, 'the next call after a failure must acquire exactly once more')
    await settleTurns()
    await settleTurns()
    // A caller joining now must still share the in-flight retry: an old
    // rejection's cleanup must never drop a newer attempt.
    const joinedViaSeam = getFile !== null
    const joined: Promise<BehaviorFile | BehaviorDataHandle> = joinedViaSeam
      ? getFile()
      : source.open()
    joined.catch(() => undefined)
    expectEqual(
      attempts,
      2,
      'a caller joining the in-flight retry must share it — an old rejection must not clear the newer attempt',
    )

    retryAttempt.resolve(snapshot)
    const handle = await retried
    expectEqual(handle.kind, 'data-handle', 'handle kind after the retry fulfilled')
    expectEqual(handle.sourceId, source.id, 'handle sourceId after the retry fulfilled')
    expectCondition(Object.isFrozen(handle), 'the DataHandle must be frozen (immutable)')
    if (joinedViaSeam) {
      expectCondition(
        (await joined) === snapshot,
        'a caller joining the retry must observe the same acquired snapshot',
      )
    } else {
      await joined
    }

    // The fulfilled attempt is retained: nothing re-acquires it afterwards.
    const metadata = await source.metadata()
    expectEqual(metadata.format, 'parquet', 'metadata after the retry fulfilled (format)')
    expectEqual(metadata.sizeBytes, snapshot.size, 'metadata after the retry fulfilled (size)')
    await source.open()
    if (getFile !== null) expectCondition((await getFile()) === snapshot, 'same snapshot')
    expectEqual(
      attempts,
      2,
      'a fulfilled attempt must be retained for the instance lifetime (never re-acquired)',
    )

    // A synchronous handle throw must arrive as the attempt's rejection — the
    // accessor may never throw synchronously. Without the additive `getFile()`
    // seam the check is not observable (recorded, never passed vacuously).
    let syncThrowCaptured: string | boolean = 'seam-absent'
    if (getFile !== null) {
      let syncAttempts = 0
      const syncHandle: BehaviorFileHandle = {
        name: snapshot.name,
        getFile: () => {
          syncAttempts += 1
          if (syncAttempts === 1) throw new Error('SecurityError: synchronous failure')
          return Promise.resolve(snapshot)
        },
      }
      const syncSource = subject.createHandleSource(syncHandle)
      const syncSeam = syncSource.getFile
      if (typeof syncSeam === 'function') {
        const syncGetFile = syncSeam.bind(syncSource)
        let pendingFile: Promise<BehaviorFile> | null = null
        let threwSynchronously = false
        try {
          pendingFile = syncGetFile()
        } catch {
          threwSynchronously = true
        }
        expectCondition(
          !threwSynchronously && pendingFile !== null,
          'a synchronous handle throw must become the acquisition attempt rejection, not a synchronous throw',
        )
        expectCondition(
          (await rejectionOf(pendingFile!)) !== null,
          'a synchronous handle throw must reject the shared attempt',
        )
        // Same retry contract on this path.
        expectCondition(
          (await syncGetFile()) === snapshot,
          'the next call after a synchronous failure must retry and succeed',
        )
        syncThrowCaptured = true
      }
    }

    return {
      sharedInFlightAttempt: true,
      concurrentFailureObserved: true,
      retriedExactlyOnce: true,
      staleRejectionCannotClearRetry: true,
      fulfilledAttemptRetained: true,
      frozenHandle: true,
      syncThrowCaptured,
    }
  },
}

// ---- Runner ----

/**
 * Run the named scenarios (default: all) sequentially against `subject`. A
 * scenario "passes" by completing without throwing; any thrown error is
 * reported as that scenario's failure detail. Sources hold no resources here,
 * so — unlike the engine suite — no post-scenario cleanup is required.
 */
export async function runDataSourceBehaviorScenarios(
  subject: DataSourceBehaviorSubject,
  names?: readonly DataSourceBehaviorScenarioName[],
): Promise<DataSourceBehaviorReport> {
  const requested = names ?? dataSourceBehaviorScenarioNames
  const results: DataSourceBehaviorScenarioResult[] = []
  for (const name of requested) {
    results.push(await runDataSourceBehaviorScenario(subject, name))
  }
  return {
    subject: subject.name,
    results,
    allPassed: results.every((result) => result.passed),
  }
}

/** Run a single scenario (see `runDataSourceBehaviorScenarios` for semantics). */
export async function runDataSourceBehaviorScenario(
  subject: DataSourceBehaviorSubject,
  name: DataSourceBehaviorScenarioName,
): Promise<DataSourceBehaviorScenarioResult> {
  const scenario = scenarios[name]
  if (scenario === undefined) {
    return { name, passed: false, detail: `unknown scenario: ${name}`, facts: {} }
  }
  try {
    const facts = await scenario(subject)
    return { name, passed: true, detail: 'passed', facts }
  } catch (error) {
    return {
      name,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
      facts: {},
    }
  }
}
