// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parseContract } from '@assay/contracts'
import { buildStarterContract, STARTER_CONTRACT_FILE_NAME } from './starter-contract'

/**
 * ug-20 / UG-28 unit pins: the starter contract is canonical, deterministic,
 * re-parses to exactly the projected rules, and never guesses at a column
 * type it cannot express in the v1 vocabulary. Privacy: the fixed metadata
 * name and file name are the only identities it carries.
 */

const SCHEMA = [
  { name: 'order_id', type: 'BIGINT' },
  { name: 'region', type: 'VARCHAR' },
  { name: 'signup_date', type: 'DATE' },
  { name: 'active', type: 'BOOLEAN' },
  { name: 'amount', type: 'DECIMAL(10,2)' },
  { name: 'nickname', type: 'TEXT' },
  // Omitted: no confident vocabulary spelling.
  { name: 'tags', type: 'VARCHAR[]' },
  { name: 'meta', type: 'STRUCT(a INTEGER)' },
  { name: 'bad_decimal', type: 'DECIMAL(5,9)' },
  { name: 'weird', type: 'WEIRD_TYPE' },
] as const

const EXPECTED_TEXT = `format: v1
name: starter-contract
version: 1
columns:
  - name: order_id
    type: BIGINT
  - name: region
    type: VARCHAR
  - name: signup_date
    type: DATE
  - name: active
    type: BOOLEAN
  - name: amount
    type: DECIMAL
  - name: nickname
    type: VARCHAR
dataset:
  min-rows: 1
`

describe('buildStarterContract', () => {
  it('returns null for an empty/unavailable schema', () => {
    expect(buildStarterContract([])).toBeNull()
  })

  it('builds the fixed new-file name and a canonical, deterministic document', () => {
    const first = buildStarterContract(SCHEMA)
    const second = buildStarterContract(SCHEMA)
    expect(first).not.toBeNull()
    expect(first?.fileName).toBe(STARTER_CONTRACT_FILE_NAME)
    expect(first?.fileName).toBe('assay-starter-contract.yaml')
    expect(first?.text).toBe(EXPECTED_TEXT)
    expect(second?.text).toBe(first?.text)
  })

  it('round-trips through the canonical parser to exactly the projected rules', () => {
    const starter = buildStarterContract(SCHEMA)
    if (starter === null) throw new Error('starter contract was not built')
    const parsed = parseContract(starter.text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.contract.metadata).toEqual({ name: 'starter-contract', version: 1 })
    expect(parsed.contract.columns).toEqual([
      { name: 'order_id', type: 'BIGINT' },
      { name: 'region', type: 'VARCHAR' },
      { name: 'signup_date', type: 'DATE' },
      { name: 'active', type: 'BOOLEAN' },
      { name: 'amount', type: 'DECIMAL' },
      { name: 'nickname', type: 'VARCHAR' },
    ])
    expect(parsed.contract.dataset).toEqual({ minRows: 1 })
  })

  it('omits every unmappable column rather than guessing', () => {
    const starter = buildStarterContract([
      { name: 'tags', type: 'VARCHAR[]' },
      { name: 'meta', type: 'STRUCT(a INTEGER)' },
      { name: 'bad_decimal', type: 'DECIMAL(5,9)' },
      { name: 'weird', type: 'WEIRD_TYPE' },
    ])
    if (starter === null) throw new Error('starter contract was not built')
    const parsed = parseContract(starter.text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.contract.columns).toEqual([])
    expect(parsed.contract.dataset).toEqual({ minRows: 1 })
  })

  it('carries no dataset file name or values (ADR 0025)', () => {
    const starter = buildStarterContract(SCHEMA)
    if (starter === null) throw new Error('starter contract was not built')
    expect(starter.text).not.toContain('orders-dirty-a.jsonl')
    expect(starter.text).not.toContain('1001')
    expect(starter.text).not.toContain('EMEA')
  })
})
