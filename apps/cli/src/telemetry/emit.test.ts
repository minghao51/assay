// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  diffOutcome,
  durationSince,
  formatKindFromEngineFormat,
  osFamilyFromPlatform,
  reasonFromCliError,
  validationOutcome,
} from './emit'

describe('CLI value-free outcome mappings (design §3, ADR 0025)', () => {
  it('maps process.platform to the coarse os_family enum', () => {
    expect(osFamilyFromPlatform('darwin')).toBe('macos')
    expect(osFamilyFromPlatform('linux')).toBe('linux')
    expect(osFamilyFromPlatform('win32')).toBe('windows')
    expect(osFamilyFromPlatform('aix')).toBe('other')
  })

  it('maps the engine format union to format_kind', () => {
    expect(formatKindFromEngineFormat('parquet')).toBe('parquet')
    expect(formatKindFromEngineFormat('jsonl')).toBe('jsonl')
    expect(formatKindFromEngineFormat('weird')).toBe('unknown')
  })

  it('classifies open failures into closed reason codes only', () => {
    expect(reasonFromCliError(new Error('dataset file not found: /home/u/x.parquet'))).toBe(
      'not_found',
    )
    expect(reasonFromCliError(new Error('dataset path is not a file: /x'))).toBe('unreadable')
    expect(
      reasonFromCliError(new Error("unsupported dataset format 'x.parquet' — supported: csv")),
    ).toBe('unsupported_format')
    expect(
      reasonFromCliError(new Error('the dataset could not be opened (parquet reader refused)')),
    ).toBe('engine_error')
    expect(reasonFromCliError(new Error('something else'))).toBe('unknown')
  })

  it('maps verdicts and durations', () => {
    expect(validationOutcome(true)).toBe('pass')
    expect(validationOutcome(false)).toBe('fail')
    expect(diffOutcome(true)).toBe('no_differences')
    expect(diffOutcome(false)).toBe('differences')
    expect(durationSince(0, 10)).toBe('lt_50ms')
    expect(durationSince(0, 31_000)).toBe('30s_plus')
  })
})
