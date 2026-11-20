// SPDX-License-Identifier: AGPL-3.0-or-later

export const EXPORT_CHUNK_BYTES = 64 * 1024
export const EXPORT_MAX_BYTES = 512 * 1024 * 1024

/**
 * The one export format vocabulary: the host ingress, the controller and the
 * `SafeExportFormat` type all read this tuple (no duplicated literal list).
 */
export const SAFE_EXPORT_FORMATS = ['parquet', 'jsonl', 'json', 'csv', 'arrow'] as const

export type SafeExportFormat = (typeof SAFE_EXPORT_FORMATS)[number]

export type ExportHostRequest =
  | {
      readonly kind: 'export-request'
      readonly id: string
      readonly generation: number
      readonly format: SafeExportFormat
    }
  | {
      readonly kind: 'export-start'
      readonly id: string
      readonly generation: number
      readonly totalBytes: number
    }
  | ExportFrame
  | { readonly kind: 'export-finish'; readonly id: string; readonly generation: number }
  | { readonly kind: 'export-cancel'; readonly id: string; readonly generation: number }

export type ExportHostResponse =
  | {
      readonly kind: 'export-ready' | 'export-credit' | 'export-complete' | 'export-cancelled'
      readonly id: string
      readonly generation: number
    }
  | {
      readonly kind: 'export-error'
      readonly id: string
      readonly generation: number
      readonly errorKind: 'destination-refused' | 'export-failed' | 'export-busy'
    }

export interface ExportFrame {
  readonly kind: 'export-chunk'
  readonly id: string
  readonly generation: number
  readonly sequence: number
  readonly offset: number
  readonly totalBytes: number
  readonly bytes: readonly number[]
}

export interface ExportTransferState {
  readonly id: string
  readonly generation: number
  readonly totalBytes: number
  readonly nextSequence: number
  readonly nextOffset: number
}

export function acceptExportFrame(
  state: ExportTransferState,
  frame: unknown,
): { readonly state: ExportTransferState; readonly bytes: Uint8Array } {
  if (typeof frame !== 'object' || frame === null) throw new Error('invalid-frame')
  const value = frame as Partial<ExportFrame>
  if (
    value.kind !== 'export-chunk' ||
    value.id !== state.id ||
    value.generation !== state.generation ||
    value.sequence !== state.nextSequence ||
    value.offset !== state.nextOffset ||
    value.totalBytes !== state.totalBytes ||
    !Array.isArray(value.bytes) ||
    value.bytes.length === 0 ||
    value.bytes.length > EXPORT_CHUNK_BYTES ||
    state.nextOffset + value.bytes.length > state.totalBytes ||
    !value.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
    throw new Error('invalid-frame')
  return {
    state: {
      ...state,
      nextSequence: state.nextSequence + 1,
      nextOffset: state.nextOffset + value.bytes.length,
    },
    bytes: Uint8Array.from(value.bytes),
  }
}
