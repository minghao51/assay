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
    desktop[field] = field === 'keys' ? ['other'] : { changed: true }
    expect(agreeSemantics(desktop, cli)).toEqual({ agreed: false, mismatchedFields: [field] })
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
