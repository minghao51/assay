// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { EngineSchemaColumn } from '@assay/validation'
import type { DiffIssue } from './issues.js'
import { validateSchema } from './input-validation.js'

/**
 * Schema-input pins (AU-3 au3-12): the per-side schema validator refuses
 * exact duplicate column names (existing behavior) and now also case-variant
 * spellings — `Name` and `name` collide for every case-insensitive engine
 * purpose, so accepting both would fabricate a two-column schema the engine
 * cannot address. Distinct names that merely look case-similar (`Name` vs
 * `name_`) stay accepted. Duplicates are typed issues with
 * first-occurrence-wins, never a silent merge.
 */

const schema = (...names: string[]): readonly EngineSchemaColumn[] =>
  names.map((name) => ({ name, type: 'BIGINT' }))

describe('validateSchema — duplicate-name guards', () => {
  it('refuses an exact duplicate with the existing issue shape (first occurrence wins)', () => {
    const issues: DiffIssue[] = []
    const result = validateSchema(schema('x', 'x'), 'A', issues)
    expect(result?.columns).toEqual([{ name: 'x', type: 'BIGINT' }])
    expect(issues).toEqual([
      {
        code: 'duplicate-column-name',
        message: expect.stringContaining('first occurrence is kept'),
        side: 'A',
        column: 'x',
      },
    ])
    expect(issues[0]?.message).not.toContain('case-insensitive')
  })

  it('refuses a case-variant duplicate (`Name` + `name`) as a case-insensitive collision', () => {
    const issues: DiffIssue[] = []
    const result = validateSchema(schema('Name', 'name'), 'B', issues)
    // The first (exact-case) spelling is kept; the case variant is dropped.
    expect(result?.columns).toEqual([{ name: 'Name', type: 'BIGINT' }])
    expect(issues).toEqual([
      {
        code: 'duplicate-column-name',
        message: expect.stringContaining('case-insensitive'),
        side: 'B',
        column: 'name',
      },
    ])
    // The message names the collision class (fixed idiom), never echoing the
    // colliding column spellings as data.
    expect(issues[0]?.message).toBe(
      'duplicate column name (case-insensitive); the first occurrence is kept and later ones are ignored',
    )
  })

  it('still accepts distinct names that only look case-similar', () => {
    const issues: DiffIssue[] = []
    const result = validateSchema(schema('Name', 'name_', 'NAME2'), 'A', issues)
    expect(issues).toEqual([])
    expect(result?.columns.map((column) => column.name)).toEqual(['Name', 'name_', 'NAME2'])
  })
})
