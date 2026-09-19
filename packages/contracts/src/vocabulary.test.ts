import { describe, expect, it } from 'vitest'
import {
  CONTRACT_TYPE_ALIASES,
  CONTRACT_TYPE_VOCABULARY,
  contractTypeHint,
  isKnownContractType,
} from './vocabulary'

/**
 * The declared-type vocabulary is documented in-package plain data
 * (`vocabulary.ts`); these pins keep it disciplined. The m5-2 engine work
 * adds the *agreement* test (every spelling here is a real engine type);
 * this file pins the list's internal invariants so the agreement test can
 * rely on them.
 */
describe('CONTRACT_TYPE_VOCABULARY', () => {
  it('is non-empty, unique, and sorted ascending (canonical-list discipline)', () => {
    expect(CONTRACT_TYPE_VOCABULARY.length).toBeGreaterThan(0)
    expect([...CONTRACT_TYPE_VOCABULARY]).toEqual([...new Set(CONTRACT_TYPE_VOCABULARY)])
    expect([...CONTRACT_TYPE_VOCABULARY]).toEqual([...CONTRACT_TYPE_VOCABULARY].sort())
  })

  it('every entry is a bare uppercase ASCII identifier (canonical spelling, no parameters)', () => {
    for (const spelling of CONTRACT_TYPE_VOCABULARY) {
      expect(spelling).toMatch(/^[A-Z0-9]+$/)
    }
  })

  it('covers the scalar spaces a v1 contract realistically constrains', () => {
    for (const expected of [
      'BOOLEAN',
      'INTEGER',
      'BIGINT',
      'DOUBLE',
      'DECIMAL',
      'VARCHAR',
      'DATE',
      'TIMESTAMP',
    ]) {
      expect(CONTRACT_TYPE_VOCABULARY).toContain(expected)
    }
  })
})

describe('isKnownContractType', () => {
  it('accepts exactly the vocabulary, case-sensitively and without parameters', () => {
    for (const spelling of CONTRACT_TYPE_VOCABULARY) {
      expect(isKnownContractType(spelling)).toBe(true)
    }
    const unknown = [
      '',
      'varchar',
      'Varchar',
      ' BIGINT',
      'BIGINT ',
      'DECIMAL(18,3)',
      'VARCHAR[]',
      'TIMESTAMP WITH TIME ZONE',
      'ANY',
    ]
    for (const spelling of unknown) {
      expect(isKnownContractType(spelling)).toBe(false)
    }
  })
})

describe('CONTRACT_TYPE_ALIASES', () => {
  it('maps every alias to a vocabulary member (hints never suggest an unknown type)', () => {
    const vocabulary = new Set<string>(CONTRACT_TYPE_VOCABULARY)
    for (const [alias, canonical] of Object.entries(CONTRACT_TYPE_ALIASES)) {
      expect(vocabulary.has(canonical)).toBe(true)
      expect(isKnownContractType(alias)).toBe(false) // aliases are hints, never accepted spellings
      expect(contractTypeHint(alias)).toBe(canonical)
    }
  })

  it('returns null for unknown non-alias spellings (no invented suggestions)', () => {
    expect(contractTypeHint('VARCHARX')).toBeNull()
    expect(contractTypeHint('varchar')).toBeNull()
    expect(contractTypeHint('')).toBeNull()
  })
})
