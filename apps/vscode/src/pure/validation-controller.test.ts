// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  acceptsValidationFrame,
  isCurrentValidationGeneration,
  isValidationStale,
  parseAndCompileContract,
  projectValidation,
} from './validation-controller'

describe('desktop validation controller helpers', () => {
  const contract =
    'format: v1\nname: sample\nversion: 1\ncolumns:\n  - name: id\n    required: true\n'

  it('parses and compiles a contract against the supplied effective schema', () => {
    expect(parseAndCompileContract(contract, [{ name: 'id', type: 'VARCHAR' }]).kind).toBe(
      'compiled',
    )
    expect(parseAndCompileContract('', []).kind).toBe('empty')
    expect(parseAndCompileContract('not: [yaml', []).kind).toBe('parse-error')
    expect(parseAndCompileContract(contract, [{ name: 'other', type: 'VARCHAR' }]).kind).toBe(
      'compile-error',
    )
  })

  it('drops late validation generations', () => {
    expect(isCurrentValidationGeneration(4, 4)).toBe(true)
    expect(isCurrentValidationGeneration(3, 4)).toBe(false)
    expect(isCurrentValidationGeneration(Number.NaN, 4)).toBe(false)
  })

  it('marks a report stale when its overlay revision changes without removing it', () => {
    const report = { revision: 2, valid: false, rowCount: 1, rules: [] }
    expect(isValidationStale(report, 2)).toBe(false)
    expect(isValidationStale(report, 3)).toBe(true)
    expect(report.revision).toBe(2)
  })

  it('drops cancelled, late, malformed and over-bound contract frames', () => {
    const expected = { id: 'req-1', generation: 4 }
    expect(
      acceptsValidationFrame(expected, { kind: 'contract-loaded', ...expected, text: contract }),
    ).toBe(true)
    expect(
      acceptsValidationFrame(expected, {
        kind: 'contract-loaded',
        id: 'other',
        generation: 4,
        text: contract,
      }),
    ).toBe(false)
    expect(
      acceptsValidationFrame(expected, {
        kind: 'contract-loaded',
        id: expected.id,
        generation: 3,
        text: contract,
      }),
    ).toBe(false)
    expect(acceptsValidationFrame(expected, { kind: 'contract-cancelled', ...expected })).toBe(
      false,
    )
    expect(
      acceptsValidationFrame(expected, {
        kind: 'contract-loaded',
        ...expected,
        text: 'x'.repeat(1024 * 1024 + 1),
      }),
    ).toBe(false)
  })

  it('caps sample projection at the engine documented maximum', () => {
    const samples = Array.from({ length: 101 }, (_, index) => ({
      rowKey: `base:x#${index}`,
      value: 'untrusted',
    }))
    const report = projectValidation(
      {
        valid: false,
        rowCount: 101,
        rules: [
          {
            ruleId: 'r',
            outcome: 'row-samples',
            failCount: 101,
            failPercent: 100,
            sampleFailures: samples,
          },
        ],
      },
      1,
    )
    expect(report.rules[0]?.samples).toHaveLength(100)
    expect(report.rules[0]?.samples[0]?.rowKey).toBe('base:x#0')
  })
})
