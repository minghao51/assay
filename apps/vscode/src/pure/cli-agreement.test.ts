// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { agreeSemantics } from './cli-agreement.js'

const report = (): Record<string, unknown> => ({
  report: 'cli-only',
  reportVersion: 1,
  a: 'a-only',
  b: 'b-only',
  stale: false,
  keys: ['id'],
  keySource: 'explicit',
  sampleLimitRequested: 20,
  sampleLimitEffective: 20,
  schemaDrift: [],
  columnDeltas: [],
  rowDiff: {
    rowCountA: 2,
    rowCountB: 2,
    added: { count: 1, samples: [] },
    removed: { count: 1, samples: [] },
    changed: { count: 1, samples: [] },
    changedComparable: true,
  },
  issues: [],
  identical: false,
  baseViewOnly: true,
})

const fields = [
  'keys',
  'keySource',
  'sampleLimitRequested',
  'sampleLimitEffective',
  'schemaDrift',
  'columnDeltas',
  'rowDiff',
  'issues',
  'identical',
  'baseViewOnly',
] as const

describe('agreeSemantics', () => {
  it('agrees on common semantics while excluding surface-only fields', () => {
    expect(agreeSemantics(report(), report())).toEqual({ agreed: true, mismatchedFields: [] })
  })
  it.each(fields)('detects a mismatch in %s', (field) => {
    const desktop = report()
    const cli = report()
    const divergent: Record<string, unknown> = {
      keys: ['other'],
      keySource: 'inferred',
      sampleLimitRequested: 21,
      sampleLimitEffective: 22,
      schemaDrift: [{ kind: 'column-added', column: 'other' }],
      columnDeltas: [{ column: 'other' }],
      rowDiff: { changed: true },
      issues: [{ code: 'other' }],
      identical: true,
      baseViewOnly: false,
    }
    desktop[field] = divergent[field]
    expect(agreeSemantics(desktop, cli)).toEqual({ agreed: false, mismatchedFields: [field] })
  })
  it('treats a missing common field as disagreement, never vacuous equality', () => {
    const desktop = report()
    const cli = report()
    delete desktop.rowDiff
    expect(agreeSemantics(desktop, cli).agreed).toBe(false)
    expect(agreeSemantics(desktop, cli).mismatchedFields).toEqual(['missing-rowDiff-desktop'])
    const both = report()
    delete both.identical
    const cliBoth = report()
    delete cliBoth.identical
    expect(agreeSemantics(both, cliBoth).mismatchedFields).toEqual([
      'missing-identical-desktop',
      'missing-identical-cli',
    ])
    const wrongKind = report()
    wrongKind.schemaDrift = 'nope'
    expect(agreeSemantics(wrongKind, report()).mismatchedFields).toEqual([
      'missing-schemaDrift-desktop',
    ])
  })
  it('excludes a sanctioned field on the edited-view leg only when asked', () => {
    const desktop = report()
    const cli = report()
    desktop.baseViewOnly = false
    cli.baseViewOnly = true
    expect(agreeSemantics(desktop, cli).mismatchedFields).toEqual(['baseViewOnly'])
    expect(agreeSemantics(desktop, cli, { excludeFields: ['baseViewOnly'] }).agreed).toBe(true)
    // An exclusion cannot hide any other disagreement:
    desktop.identical = true
    expect(
      agreeSemantics(desktop, cli, { excludeFields: ['baseViewOnly'] }).mismatchedFields,
    ).toEqual(['identical'])
  })
  it('explicitly ignores CLI-only and desktop-only fields', () => {
    const desktop = report()
    const cli = report()
    desktop.stale = true
    cli.report = 'different'
    cli.reportVersion = 999
    cli.a = 'different'
    cli.b = 'different'
    expect(agreeSemantics(desktop, cli).agreed).toBe(true)
  })
})
