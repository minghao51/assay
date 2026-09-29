// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  diffRunOutcome,
  durationSince,
  exportOutcome,
  formatKindFromName,
  profileOutcome,
  reasonCodeFromError,
  targetFormat,
  validationOutcome,
} from './emit'

describe('value-free outcome mappings (design §3, ADR 0025)', () => {
  it('maps file extensions to the closed format enum', () => {
    expect(formatKindFromName('a.parquet')).toBe('parquet')
    expect(formatKindFromName('a.CSV')).toBe('csv')
    expect(formatKindFromName('a.ndjson')).toBe('jsonl')
    expect(formatKindFromName('a.json')).toBe('json')
    expect(formatKindFromName('a.arrow')).toBe('arrow')
    expect(formatKindFromName('a.txt')).toBe('unknown')
  })

  it('maps the engine export format to target_format', () => {
    expect(targetFormat('parquet')).toBe('parquet')
    expect(targetFormat('arrow')).toBe('arrow')
  })

  it('classifies open failures into the closed reason enum only', () => {
    expect(reasonCodeFromError(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toBe(
      'not_found',
    )
    expect(reasonCodeFromError(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBe(
      'permission_denied',
    )
    expect(reasonCodeFromError(Object.assign(new Error('x'), { name: 'EngineWorkerError' }))).toBe(
      'engine_error',
    )
    expect(reasonCodeFromError(new Error('/home/secret.parquet'))).toBe('unknown')
    expect(reasonCodeFromError('a string')).toBe('unknown')
  })

  it('maps run states to closed outcome enums', () => {
    expect(validationOutcome({ kind: 'verdict', report: { valid: true } })).toBe('pass')
    expect(validationOutcome({ kind: 'verdict', report: { valid: false } })).toBe('fail')
    expect(validationOutcome({ kind: 'failed' })).toBe('error')
    expect(validationOutcome({ kind: 'binding-errors' })).toBe('error')
    expect(validationOutcome({ kind: 'cancelled' })).toBe('aborted')

    expect(diffRunOutcome({ kind: 'result', report: { identical: true } })).toBe('no_differences')
    expect(diffRunOutcome({ kind: 'result', report: { identical: false } })).toBe('differences')
    expect(diffRunOutcome({ kind: 'failed' })).toBe('error')
    expect(diffRunOutcome({ kind: 'cancelled' })).toBe('aborted')
  })

  it('maps profile/export phases', () => {
    expect(profileOutcome('done')).toBe('success')
    expect(profileOutcome('error')).toBe('error')
    expect(exportOutcome('result')).toBe('success')
    expect(exportOutcome('cancelled')).toBe('cancelled')
    expect(exportOutcome('refused')).toBe('refused')
    expect(exportOutcome('error')).toBe('error')
  })

  it('measures a duration bucket', () => {
    expect(durationSince(0, 49)).toBe('lt_50ms')
    expect(durationSince(0, 60_000)).toBe('30s_plus')
  })
})
