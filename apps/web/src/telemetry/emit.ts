// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Value-free mappings from app outcomes to telemetry enums (design §3, ADR 0025).
 *
 * Every function here takes an already-measured value (a count, a size, an
 * error object) and returns a **closed enum member**. None returns, logs, or
 * stores a filename, path, SQL string, column name, or cell value. The
 * classifiers intentionally read only an error's `name`/`code`/closed message
 * prefix — never arbitrary text into a payload.
 */
import type {
  DiffOutcome,
  DurationBucket,
  ExportOutcome,
  FormatKind,
  OpenFailureReason,
  SuccessOutcome,
  ValidationOutcome,
} from '@assay/telemetry'
import { bucketDuration } from '@assay/telemetry'
import type { EngineExportFormat } from '@assay/engine-duckdb'

/** Map a file extension/name to the closed `format_kind` enum (design §3.4). */
export function formatKindFromName(name: string): FormatKind {
  const lower = name.toLowerCase()
  if (lower.endsWith('.parquet')) return 'parquet'
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.arrow') || lower.endsWith('.feather') || lower.endsWith('.ipc'))
    return 'arrow'
  return 'unknown'
}

/** Map the engine export format union to `target_format` (identical set). */
export function targetFormat(format: EngineExportFormat): FormatKind {
  return format
}

/** Map a thrown open/register failure to the closed `reason_code` enum. */
export function reasonCodeFromError(error: unknown): OpenFailureReason {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotFoundError') return 'not_found'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission_denied'
  if (name === 'NotReadableError' || name === 'EncodingError') return 'unreadable'
  if (name === 'QuotaExceededError') return 'out_of_memory'
  if (name.startsWith('Engine')) return 'engine_error'
  return 'unknown'
}

/** Duration bucket for a run measured from `startedAt` to `Date.now()`. */
export function durationSince(startedAt: number, finishedAt: number = Date.now()): DurationBucket {
  return bucketDuration(finishedAt - startedAt)
}

/** The validation run state carried by `useValidationSession`. */
export type ValidationRunLike =
  | { readonly kind: 'verdict'; readonly report: { readonly valid: boolean } }
  | { readonly kind: 'binding-errors' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'cancelled' }

/** Map a finished validation run to its closed outcome (design §3.6). */
export function validationOutcome(run: ValidationRunLike): ValidationOutcome {
  if (run.kind === 'cancelled') return 'aborted'
  if (run.kind === 'failed' || run.kind === 'binding-errors') return 'error'
  return run.report.valid ? 'pass' : 'fail'
}

/** The diff run state carried by `useDiffSession`. */
export type DiffRunLike =
  | { readonly kind: 'result'; readonly report: { readonly identical: boolean } }
  | { readonly kind: 'binding-errors' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'cancelled' }

/** Map a finished diff run to its closed outcome (design §3.7). */
export function diffRunOutcome(run: DiffRunLike): DiffOutcome {
  if (run.kind === 'cancelled') return 'aborted'
  if (run.kind === 'failed' || run.kind === 'binding-errors') return 'error'
  return run.report.identical ? 'no_differences' : 'differences'
}

/** Map a profile run outcome to the closed enum (design §3.8). */
export function profileOutcome(kind: 'done' | 'error'): SuccessOutcome {
  return kind === 'done' ? 'success' : 'error'
}

/** Map an export dialog phase to the closed enum (design §3.10). */
export function exportOutcome(phase: 'result' | 'cancelled' | 'refused' | 'error'): ExportOutcome {
  if (phase === 'result') return 'success'
  if (phase === 'cancelled') return 'cancelled'
  if (phase === 'refused') return 'refused'
  return 'error'
}
