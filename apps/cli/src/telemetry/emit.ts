// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Value-free CLI outcome mappings (design §3, ADR 0025). Every function takes
 * an already-measured value and returns a closed enum member — never a path,
 * filename, SQL string, key column, or error message.
 */
import type {
  DiffOutcome,
  DurationBucket,
  FormatKind,
  OpenFailureReason,
  OsFamily,
  ValidationOutcome,
} from '@assay/telemetry'
import { bucketDuration } from '@assay/telemetry'

/** Map `process.platform` to the coarse `os_family` enum (design §3.2/D8). */
export function osFamilyFromPlatform(platform: string): OsFamily {
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return 'linux'
  if (platform === 'win32') return 'windows'
  return 'other'
}

/** Map the engine's format union to the closed `format_kind` enum. */
export function formatKindFromEngineFormat(format: string): FormatKind {
  if (format === 'parquet' || format === 'csv' || format === 'jsonl' || format === 'json') {
    return format
  }
  return 'unknown'
}

/** Duration bucket for a run measured from `startedAt` to `Date.now()`. */
export function durationSince(startedAt: number, finishedAt: number = Date.now()): DurationBucket {
  return bucketDuration(finishedAt - startedAt)
}

/**
 * Classify an open/register failure into the closed `reason_code` enum. Reads
 * the authored `CliError` message only to pick a code; the message is never
 * attached to a payload (R3).
 */
export function reasonFromCliError(error: unknown): OpenFailureReason {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('not found')) return 'not_found'
  if (message.includes('not a file') || message.includes('not readable')) return 'unreadable'
  if (message.includes('unsupported dataset format')) return 'unsupported_format'
  if (message.includes('permission')) return 'permission_denied'
  if (message.includes('could not be opened')) return 'engine_error'
  if (message.includes('no columns')) return 'corrupt'
  return 'unknown'
}

/** Map a completed validation verdict to the closed outcome enum. */
export function validationOutcome(valid: boolean): ValidationOutcome {
  return valid ? 'pass' : 'fail'
}

/** Map a completed row diff to the closed outcome enum (design §3.7). */
export function diffOutcome(identical: boolean): DiffOutcome {
  return identical ? 'no_differences' : 'differences'
}
