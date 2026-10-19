// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatasetFormat } from './dataset-format'

/** Typed open failures used by the host bridge and the webview protocol. */
export type DatasetErrorKind =
  'missing-file' | 'unsupported-format' | 'empty-file' | 'read-failed' | 'engine-failed'

/** Typed error contract. Host callers may retain a detailed, path-bearing message. */
export class DatasetOpenError extends Error {
  readonly kind: DatasetErrorKind

  constructor(kind: DatasetErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = 'DatasetOpenError'
  }
}

/** Fixed, path-free text for webview rendering; never interpolate host error messages. */
export const WEBVIEW_ERROR_TEXT: Readonly<Record<DatasetErrorKind, string>> = {
  'missing-file': 'the file does not exist or is not accessible',
  'unsupported-format':
    'not a supported dataset format (supported: Parquet, CSV, JSONL/NDJSON, JSON, Arrow/Feather/IPC)',
  'empty-file': 'the file is empty',
  'read-failed': 'the file could not be read',
  'engine-failed': 'the dataset could not be opened',
}

/** Value-free bridge report (counts and kinds only — never file contents). */
export type DatasetReport =
  | {
      readonly outcome: 'opened'
      readonly format: DatasetFormat
      readonly byteLength: number
      readonly rows: number
      readonly columns: number
      /** The grid mounted and the first row rendered (webview-reported). */
      readonly gridRendered: boolean
      /** The webview's DOM-structure accessibility audit held. */
      readonly gridAuditOk: boolean
      /** Open (bytes in hand) to first grid row visible, in milliseconds. */
      readonly firstRowVisibleMs: number
      /** Test-mode only, exact value-free effective-validation counts. */
      readonly validationProof?: {
        readonly baselineFailures: number
        readonly editedFailures: number
        readonly insertedFailures: number
        readonly deletedFailures: number
        readonly staleAfterEdit: boolean
        readonly logicalNavigation: boolean
      }
      /** Test-mode only, value-free staged-diff evidence. */
      readonly diffProof?: {
        readonly unconfirmedRefused: boolean
        readonly staleAfterEdit: boolean
        readonly baseViewOnlyFalse: boolean
        readonly navigation: boolean
        readonly baselineCounts?: readonly [number, number, number]
        readonly editedChangedCount?: number
        readonly identicalCase?: boolean
        readonly schemaOnlyCase?: boolean
        readonly noComparableCase?: boolean
        readonly nestedCase?: boolean
      }
      /** Test-mode only, value-free acceptance-chain evidence (scenario 11). */
      readonly acceptanceProof?: {
        readonly validatedCounts: readonly [number, number, number, number]
        readonly staleAfterEdit: boolean
        readonly unconfirmedRefused: boolean
        readonly refusalKind: 'invalid-keys'
        readonly diffCounts: readonly [number, number, number]
        readonly baseViewOnlyFalse: boolean
        readonly navigation: boolean
        readonly reportDelivered: boolean
        readonly copyDelivered: boolean
      }
      /** Test-mode only, value-free compare-command evidence (reduced proof). */
      readonly diffCommandProof?: {
        readonly staged: boolean
        readonly unconfirmedRefused: boolean
        readonly baselineCounts: readonly [number, number, number]
      }
      /** Test-mode only, value-free git-context evidence (state word + branch presence). */
      readonly gitContext?: {
        readonly state: string
        readonly hasBranch: boolean
      }
      /** Test-mode only, value-free result of production DOM/engine edit assertions. */
      readonly editProof?: {
        readonly cellIdentity: boolean
        readonly keyboardCancel: boolean
        readonly undoRedo: boolean
        readonly insertDelete: boolean
        readonly branchTruncation: boolean
        readonly queryStatePreserved: boolean
        readonly sessionWarningVisible: boolean
        readonly fullViewCastRefusal: boolean
      }
    }
  | {
      readonly outcome: 'error'
      readonly kind: DatasetErrorKind
      readonly message: string
      /** True when the webview acknowledged the error (it rendered the state). */
      readonly shownInWebview: boolean
    }

/** Exact value-free projection for test-only validation evidence received from a webview. */
export function normalizeValidationProof(
  value: unknown,
): NonNullable<Extract<DatasetReport, { outcome: 'opened' }>['validationProof']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  const counts = [
    'baselineFailures',
    'editedFailures',
    'insertedFailures',
    'deletedFailures',
  ] as const
  if (
    !counts.every((key) => Number.isSafeInteger(input[key]) && Number(input[key]) >= 0) ||
    typeof input['staleAfterEdit'] !== 'boolean' ||
    typeof input['logicalNavigation'] !== 'boolean'
  )
    return undefined
  return {
    baselineFailures: Number(input['baselineFailures']),
    editedFailures: Number(input['editedFailures']),
    insertedFailures: Number(input['insertedFailures']),
    deletedFailures: Number(input['deletedFailures']),
    staleAfterEdit: input['staleAfterEdit'],
    logicalNavigation: input['logicalNavigation'],
  }
}

/** Exact value-free projection for test-only edit evidence received from a webview. */
/**
 * Test-mode only: validate a harness-named comparison fixture before the
 * host honors it. Strict allowlist — a bare basename with no traversal,
 * no separators, and a known dataset extension. Production never sends a
 * fixture name; the field exists so the e2e harness can stage several
 * comparison classes through the REAL select flow.
 */
/** Value-free acceptance-chain evidence from a webview (counts + flags only). */
export function normalizeAcceptanceProof(
  value: unknown,
): NonNullable<Extract<DatasetReport, { outcome: 'opened' }>['acceptanceProof']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  const validated = input['validatedCounts']
  const diffCounts = input['diffCounts']
  const flags = [
    'staleAfterEdit',
    'unconfirmedRefused',
    'baseViewOnlyFalse',
    'navigation',
    'reportDelivered',
    'copyDelivered',
  ] as const
  if (
    input['refusalKind'] !== 'invalid-keys' ||
    !flags.every((key) => input[key] === true) ||
    !Array.isArray(validated) ||
    validated.length !== 4 ||
    !validated.every((count) => Number.isSafeInteger(count) && Number(count) >= 0) ||
    !Array.isArray(diffCounts) ||
    diffCounts.length !== 3 ||
    !diffCounts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)
  )
    return undefined
  return {
    validatedCounts: validated.map((count) => Number(count)) as [number, number, number, number],
    staleAfterEdit: true,
    unconfirmedRefused: true,
    refusalKind: 'invalid-keys',
    baseViewOnlyFalse: true,
    navigation: true,
    reportDelivered: true,
    copyDelivered: true,
    diffCounts: diffCounts.map((count) => Number(count)) as [number, number, number],
  }
}

/** Value-free compare-command evidence from a webview. */
export function normalizeDiffCommandProof(
  value: unknown,
): NonNullable<Extract<DatasetReport, { outcome: 'opened' }>['diffCommandProof']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  const counts = input['baselineCounts']
  if (
    input['staged'] !== true ||
    input['unconfirmedRefused'] !== true ||
    !Array.isArray(counts) ||
    counts.length !== 3 ||
    !counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0)
  )
    return undefined
  return {
    staged: true,
    unconfirmedRefused: true,
    baselineCounts: [Number(counts[0]), Number(counts[1]), Number(counts[2])],
  }
}

/** Value-free git-context evidence from a webview (state word + branch presence only). */
export function normalizeGitContext(
  value: unknown,
): NonNullable<Extract<DatasetReport, { outcome: 'opened' }>['gitContext']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  const state = input['state']
  if (typeof state !== 'string' || state.length === 0 || state.length > 40) return undefined
  if (/[\\/\\s]/.test(state)) return undefined
  return { state, hasBranch: input['hasBranch'] === true }
}

export function validateTestComparisonFixture(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return undefined
  if (value.includes('..')) return undefined
  if (!/\.(csv|jsonl|json|parquet|arrow)$/.test(value)) return undefined
  return value
}

export function normalizeDiffProof(
  value: unknown,
): NonNullable<Extract<DatasetReport, { outcome: 'opened' }>['diffProof']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  const flags = ['unconfirmedRefused', 'staleAfterEdit', 'baseViewOnlyFalse', 'navigation'] as const
  if (!flags.every((key) => typeof input[key] === 'boolean')) return undefined
  const caseFlags = ['identicalCase', 'schemaOnlyCase', 'noComparableCase', 'nestedCase'] as const
  const cases = caseFlags.filter((key) => input[key] === true)
  const counts = input['baselineCounts']
  const baselineCounts =
    Array.isArray(counts) && counts.length === 3 && counts.every(isCount)
      ? ([Number(counts[0]), Number(counts[1]), Number(counts[2])] as [number, number, number])
      : undefined
  const editedChangedCount = isCount(input['editedChangedCount'])
    ? Number(input['editedChangedCount'])
    : undefined
  return {
    unconfirmedRefused: input['unconfirmedRefused'] === true,
    staleAfterEdit: input['staleAfterEdit'] === true,
    baseViewOnlyFalse: input['baseViewOnlyFalse'] === true,
    navigation: input['navigation'] === true,
    ...(baselineCounts === undefined ? {} : { baselineCounts }),
    ...(editedChangedCount === undefined ? {} : { editedChangedCount }),
    ...(cases.length === 0 ? {} : Object.fromEntries(cases.map((key) => [key, true as const]))),
  }
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

export function normalizeEditProof(
  value: unknown,
): NonNullable<Extract<DatasetReport, { outcome: 'opened' }>['editProof']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  const keys = [
    'cellIdentity',
    'keyboardCancel',
    'undoRedo',
    'insertDelete',
    'branchTruncation',
    'queryStatePreserved',
    'sessionWarningVisible',
    'fullViewCastRefusal',
  ] as const
  if (!keys.every((key) => typeof input[key] === 'boolean')) return undefined
  return {
    cellIdentity: input.cellIdentity as boolean,
    keyboardCancel: input.keyboardCancel as boolean,
    undoRedo: input.undoRedo as boolean,
    insertDelete: input.insertDelete as boolean,
    branchTruncation: input.branchTruncation as boolean,
    queryStatePreserved: input.queryStatePreserved as boolean,
    sessionWarningVisible: input.sessionWarningVisible as boolean,
    fullViewCastRefusal: input.fullViewCastRefusal as boolean,
  }
}

export interface ReadDatasetResult {
  readonly format: DatasetFormat
  readonly byteLength: number
  readonly bytes: ArrayBuffer
}
