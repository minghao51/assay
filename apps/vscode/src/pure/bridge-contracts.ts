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
