// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Node-side proof of the data-source behavior suite itself: the scenarios run
 * green against a *compliant in-memory fake source* (proving the suite is
 * implementation-agnostic and its logic sound), and each scenario detects a
 * deliberately non-compliant fake (proving the assertions bite). The real
 * BrowserFileSource proof lives in
 * `packages/data-sources/src/behavior-subject.test.ts` (Node, in-memory
 * handles) and the browser harness + e2e (genuine OPFS handles).
 */
import { describe, expect, it } from 'vitest'
import {
  dataSourceBehaviorScenarioNames,
  runDataSourceBehaviorScenario,
  runDataSourceBehaviorScenarios,
} from './data-source-behavior'
import type {
  BehaviorCapabilityScope,
  BehaviorDataHandle,
  BehaviorDataSource,
  BehaviorFile,
  BehaviorFileHandle,
  BehaviorMetadata,
  BehaviorPickSteps,
  BehaviorPickedFile,
  DataSourceBehaviorScenarioName,
  DataSourceBehaviorSubject,
  DataSourceCapabilityMatrix,
} from './data-source-behavior'

/** Mutation knobs that make the fake non-compliant in one specific way. */
interface FakeMutations {
  /** The source re-resolves the file through the handle on every operation. */
  sourceReacquiresHandle?: boolean
  /** open() returns a fresh, unfrozen handle object each time. */
  newHandleEachOpen?: boolean
  /** The source id mutates after the first operation. */
  identityMutates?: boolean
  /** metadata() adds engine-owned and content-ish fields. */
  metadataAddsFields?: boolean
  /** metadata() lies about the file size. */
  metadataLiesAboutSize?: boolean
  /** The source does not ship the additive getFile() seam. */
  omitsFileSeam?: boolean
  /** An FSA AbortError propagates as a rejection instead of resolving null. */
  cancelRejects?: boolean
  /** Non-abort picker failures resolve null instead of propagating. */
  swallowsNonAbortErrors?: boolean
  /** The input-fallback cancel rejects instead of resolving null. */
  inputCancelRejects?: boolean
  /** Capability detection ties both flags to one API (loses independence). */
  capabilitiesConflated?: boolean
  /** Capability detection returns truthy non-booleans. */
  capabilitiesNonBoolean?: boolean
  /** The input fallback runs even when the FSA picker is available. */
  routesFallbackWhenPickerAvailable?: boolean
  /** The `via` strategy tags are swapped. */
  viaTagsSwapped?: boolean
  /** The FSA picker is asked with multiple: true. */
  pickerMultipleTrue?: boolean
}

/** The fake's extension → format map (the shipped detection vocabulary). */
const FAKE_FORMATS: Readonly<Record<string, string>> = {
  csv: 'csv',
  parquet: 'parquet',
  jsonl: 'jsonl',
  json: 'json',
  arrow: 'arrow',
  feather: 'feather',
}

/** The shipped detection rules, mirrored by the compliant fake. */
function fakeDetectFormat(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === fileName.length - 1) return 'unknown'
  return FAKE_FORMATS[fileName.slice(lastDot + 1).toLowerCase()] ?? 'unknown'
}

function isAbortNamed(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

let nextSourceId = 1

/**
 * An in-memory fake source that satisfies the *contract* the suite asserts:
 * one stable identity, idempotent open() of a frozen handle, a one-shot cached
 * file snapshot (handle resolved lazily, exactly once), metadata of exactly
 * format + size, and a getFile() seam — unless a mutation breaks one rule.
 */
function createFakeSource(
  mutations: FakeMutations,
  handle: BehaviorFileHandle,
): BehaviorDataSource {
  const baseId = `fake-src-${String(nextSourceId++)}`
  let operations = 0
  let filePromise: Promise<BehaviorFile> | null = null
  let handleObject: BehaviorDataHandle | null = null

  const ensureFile = (): Promise<BehaviorFile> => {
    if (mutations.sourceReacquiresHandle === true || filePromise === null) {
      filePromise = handle.getFile()
    }
    return filePromise
  }

  const source: BehaviorDataSource = {
    get id(): string {
      // The mutation flips the id only from the second operation on, so the
      // id/handle wiring itself stays valid and the scenario catches the
      // instability at its own "identity does not change across operations"
      // assertion.
      return operations > 1 && mutations.identityMutates === true ? 'fake-mutated-identity' : baseId
    },
    kind: 'fake-source',
    open: async () => {
      operations += 1
      await ensureFile()
      if (mutations.newHandleEachOpen === true) {
        // Deliberate violation: fresh, unfrozen handle object per call.
        return { kind: 'data-handle', sourceId: source.id }
      }
      handleObject ??= Object.freeze({ kind: 'data-handle', sourceId: source.id })
      return handleObject
    },
    metadata: async () => {
      operations += 1
      const file = await ensureFile()
      const metadata: BehaviorMetadata = {
        format: fakeDetectFormat(file.name),
        sizeBytes: mutations.metadataLiesAboutSize === true ? file.size + 1 : file.size,
      }
      if (mutations.metadataAddsFields === true) {
        // Deliberate violation: engine-owned + content-ish fields.
        return Object.assign(metadata, { rowCount: 4242, pickedFileName: file.name })
      }
      return metadata
    },
  }
  if (mutations.omitsFileSeam !== true) {
    source.getFile = () => ensureFile()
  }
  return source
}

/** The fake's pick flow — the documented R5 branching, contract-compliant. */
async function fakePick(
  mutations: FakeMutations,
  steps: BehaviorPickSteps,
): Promise<BehaviorPickedFile | null> {
  const capabilities: DataSourceCapabilityMatrix = steps.capabilities ?? {
    filePicker: false,
    dataTransferHandle: false,
  }
  const useFsa =
    mutations.routesFallbackWhenPickerAvailable === true ? false : capabilities.filePicker

  if (useFsa) {
    const showPicker = steps.showOpenFilePicker
    if (showPicker === undefined) {
      throw new Error('fake subject misconfiguration: the FSA step is required on this branch')
    }
    let handles: BehaviorFileHandle[]
    try {
      handles = await showPicker({
        // `as false`: the mutation deliberately violates the one-file contract.
        multiple: (mutations.pickerMultipleTrue === true) as false,
      })
    } catch (error) {
      if (mutations.cancelRejects === true) throw error
      if (isAbortNamed(error)) return null
      if (mutations.swallowsNonAbortErrors === true) return null
      throw error
    }
    const handle = handles[0]
    if (handle === undefined) return null
    return {
      via: mutations.viaTagsSwapped === true ? 'input-fallback' : 'file-system-access',
      source: createFakeSource(mutations, handle),
    }
  }

  const pickViaInput = steps.pickViaHiddenInput
  if (pickViaInput === undefined) {
    throw new Error('fake subject misconfiguration: the input step is required on this branch')
  }
  const file = await pickViaInput()
  if (file === null) {
    if (mutations.inputCancelRejects === true) throw new Error('fake: input cancel rejected')
    return null
  }
  return {
    via: mutations.viaTagsSwapped === true ? 'file-system-access' : 'input-fallback',
    source: createFakeSource(mutations, { name: file.name, getFile: async () => file }),
  }
}

/** The fake's capability detection — function-ness, per member. */
function fakeDetectCapabilities(
  mutations: FakeMutations,
  scope: BehaviorCapabilityScope,
): DataSourceCapabilityMatrix {
  const pickerIsFunction = typeof scope.showOpenFilePicker === 'function'
  const transferIsFunction =
    typeof scope.DataTransferItem?.prototype.getAsFileSystemHandle === 'function'
  if (mutations.capabilitiesNonBoolean === true) {
    // Deliberate violation: truthy values that are not booleans.
    return {
      filePicker: (scope.showOpenFilePicker ?? false) as unknown as boolean,
      dataTransferHandle: (scope.DataTransferItem?.prototype.getAsFileSystemHandle ??
        false) as unknown as boolean,
    }
  }
  if (mutations.capabilitiesConflated === true) {
    return { filePicker: pickerIsFunction, dataTransferHandle: pickerIsFunction }
  }
  return { filePicker: pickerIsFunction, dataTransferHandle: transferIsFunction }
}

function makeSubject(
  mutations: FakeMutations = {},
  formatByExtension: Readonly<Record<string, string>> = FAKE_FORMATS,
): DataSourceBehaviorSubject {
  return {
    name: 'fake-data-source',
    formatByExtension,
    makeFile: (name, sizeBytes) => ({ name, size: sizeBytes }),
    makeHandle: async (file) => ({ name: file.name, getFile: async () => file }),
    createFallbackSource: (file) =>
      createFakeSource(mutations, { name: file.name, getFile: async () => file }),
    createHandleSource: (handle) => createFakeSource(mutations, handle),
    pick: (steps) => fakePick(mutations, steps),
    detectCapabilities: (scope = {}) => fakeDetectCapabilities(mutations, scope),
  }
}

async function runOne(
  mutations: FakeMutations,
  name: DataSourceBehaviorScenarioName,
  formatByExtension?: Readonly<Record<string, string>>,
): Promise<{ passed: boolean; detail: string }> {
  const result = await runDataSourceBehaviorScenario(
    makeSubject(mutations, formatByExtension),
    name,
  )
  return { passed: result.passed, detail: result.detail }
}

describe('data-source behavior suite (compliant fake source)', () => {
  it('runs every scenario green against a contract-compliant in-memory source', async () => {
    const report = await runDataSourceBehaviorScenarios(makeSubject())
    expect(report.subject).toBe('fake-data-source')
    expect(report.results.map((result) => result.name)).toEqual([
      ...dataSourceBehaviorScenarioNames,
    ])
    expect(report.allPassed, JSON.stringify(report.results, null, 2)).toBe(true)
    for (const result of report.results) {
      expect(result.detail).toBe('passed')
      expect(Object.keys(result.facts).length).toBeGreaterThan(0)
    }
  })

  it('exposes scenario-level evidence (call counts, key sets, branch flags)', async () => {
    const subject = makeSubject()
    const oneShot = await runDataSourceBehaviorScenario(subject, 'one-shot-file')
    expect(oneShot.facts['handleGetFileCalls']).toBe(1)
    expect(oneShot.facts['fileSeam']).toBe('shared')
    expect(oneShot.facts['fallbackSnapshotExact']).toBe(true)
    const metadata = await runDataSourceBehaviorScenario(subject, 'metadata-contract')
    // 6 subject-declared formats + one case-insensitive probe + unknown + the
    // fallback = 9 (the count is derived from the adapter's detect map).
    expect(metadata.facts['casesProbed']).toBe(9)
    expect(metadata.facts['keyCount']).toBe(2)
    const capabilities = await runDataSourceBehaviorScenario(subject, 'capability-matrix')
    expect(capabilities.facts['scopesProbed']).toBe(5)
  })

  it('records an absent getFile seam instead of passing it vacuously', async () => {
    const report = await runDataSourceBehaviorScenarios(makeSubject({ omitsFileSeam: true }))
    expect(report.allPassed).toBe(true) // the seam is optional; the rest must still hold
    const oneShot = report.results.find((result) => result.name === 'one-shot-file')
    expect(oneShot?.passed).toBe(true)
    expect(oneShot?.facts['fileSeam']).toBe('absent')
    expect(oneShot?.facts['handleGetFileCalls']).toBe(1)
  })
})

describe('data-source behavior suite (detects non-compliant sources)', () => {
  it('identity-idempotency: detects a fresh unfrozen handle per open()', async () => {
    const { passed, detail } = await runOne({ newHandleEachOpen: true }, 'identity-idempotency')
    expect(passed).toBe(false)
    expect(detail).toContain('idempotent')
  })

  it('identity-idempotency: detects an identity that changes across operations', async () => {
    const { passed, detail } = await runOne({ identityMutates: true }, 'identity-idempotency')
    expect(passed).toBe(false)
    expect(detail).toContain('identity must not change')
  })

  it('one-shot-file: detects a source that re-acquires the handle', async () => {
    const { passed, detail } = await runOne({ sourceReacquiresHandle: true }, 'one-shot-file')
    expect(passed).toBe(false)
    expect(detail).toContain('exactly once')
  })

  it('metadata-contract: detects extra engine-owned/content fields', async () => {
    const { passed, detail } = await runOne({ metadataAddsFields: true }, 'metadata-contract')
    expect(passed).toBe(false)
    expect(detail).toContain('exactly {format, sizeBytes}')
  })

  it('metadata-contract: detects a lying sizeBytes', async () => {
    const { passed, detail } = await runOne({ metadataLiesAboutSize: true }, 'metadata-contract')
    expect(passed).toBe(false)
    expect(detail).toContain('sizeBytes')
  })

  it('metadata-contract: fails loudly when a declared format has no behavior slot', async () => {
    // au3-11 de-hardening: the probe set is derived from the subject's own
    // detect map, so a format the adapter can detect can only escape the
    // same-suite if the matrix gate misses it — this pin proves the gate
    // bites (a subject declaring `avro` fails before any probe runs).
    const { passed, detail } = await runOne({}, 'metadata-contract', {
      ...FAKE_FORMATS,
      avro: 'avro',
    })
    expect(passed).toBe(false)
    expect(detail).toContain('no slot for it')
    expect(detail).toContain('avro')
  })

  it('cancel-semantics: detects an AbortError surfaced as a rejection', async () => {
    const { passed, detail } = await runOne({ cancelRejects: true }, 'cancel-semantics')
    expect(passed).toBe(false)
    expect(detail).toContain('must resolve null')
  })

  it('cancel-semantics: detects swallowed non-abort picker failures', async () => {
    const { passed, detail } = await runOne({ swallowsNonAbortErrors: true }, 'cancel-semantics')
    expect(passed).toBe(false)
    expect(detail).toContain('must reject')
  })

  it('cancel-semantics: detects an input cancel surfaced as a rejection', async () => {
    const { passed, detail } = await runOne({ inputCancelRejects: true }, 'cancel-semantics')
    expect(passed).toBe(false)
    expect(detail).toContain('must resolve null')
  })

  it('capability-matrix: detects detection that conflates the two members', async () => {
    const { passed, detail } = await runOne({ capabilitiesConflated: true }, 'capability-matrix')
    expect(passed).toBe(false)
    expect(detail).toContain('members are independent')
  })

  it('capability-matrix: detects truthy non-boolean flags', async () => {
    const { passed, detail } = await runOne({ capabilitiesNonBoolean: true }, 'capability-matrix')
    expect(passed).toBe(false)
    expect(detail).toContain('real booleans')
  })

  it('fallback-order: detects the fallback running despite an available picker', async () => {
    const { passed, detail } = await runOne(
      { routesFallbackWhenPickerAvailable: true },
      'fallback-order',
    )
    expect(passed).toBe(false)
    expect(detail).toContain('via tag on the FSA branch')
  })

  it('fallback-order: detects swapped via tags', async () => {
    const { passed, detail } = await runOne({ viaTagsSwapped: true }, 'fallback-order')
    expect(passed).toBe(false)
    expect(detail).toContain('via tag')
  })

  it('fallback-order: detects a multi-file picker request', async () => {
    const { passed, detail } = await runOne({ pickerMultipleTrue: true }, 'fallback-order')
    expect(passed).toBe(false)
    expect(detail).toContain('{multiple: false}')
  })
})
