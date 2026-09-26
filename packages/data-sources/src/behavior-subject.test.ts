// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Node-side wiring proof (task T3; done-when "BrowserFileSource passes — Node
 * unit + browser paths"): the REAL BrowserFileSource, pickDataFile, and
 * capability detection run the shared data-source behavior suite from
 * `@assay/testing` with in-memory handles. The browser path (genuine
 * OPFS-staged handles, real capability globals) runs through the harness in
 * `tests/e2e/data-source-behavior.spec.ts`. The suite's own logic is proven
 * against a compliant/non-compliant fake in `@assay/testing`.
 */
import { dataSourceBehaviorScenarioNames, runDataSourceBehaviorScenarios } from '@assay/testing'
import { describe, expect, it } from 'vitest'
import { createBrowserFileSourceBehaviorSubject } from './behavior-subject'

describe('BrowserFileSource — data-source behavior suite (Node unit)', () => {
  it('passes every scenario of the shared suite', async () => {
    const report = await runDataSourceBehaviorScenarios(createBrowserFileSourceBehaviorSubject())
    expect(report.subject).toBe('browser-file-source')
    expect(report.results.map((result) => result.name)).toEqual([
      ...dataSourceBehaviorScenarioNames,
    ])
    expect(report.allPassed, JSON.stringify(report.results, null, 2)).toBe(true)
    for (const result of report.results) {
      expect(result.detail).toBe('passed')
      expect(Object.keys(result.facts).length).toBeGreaterThan(0)
    }
  })

  it('locks the m1-3/m1-4 semantics as scenario evidence', async () => {
    const report = await runDataSourceBehaviorScenarios(createBrowserFileSourceBehaviorSubject())
    const byName = new Map(report.results.map((result) => [result.name, result.facts]))

    // m1-4 one-shot seam: the handle is resolved exactly once and shared.
    const oneShot = byName.get('one-shot-file')
    expect(oneShot?.['handleGetFileCalls']).toBe(1)
    expect(oneShot?.['fileSeam']).toBe('shared')
    expect(oneShot?.['fallbackSnapshotExact']).toBe(true)

    // m1-3 metadata contract: exactly {format, sizeBytes}, engine fields unset.
    const metadata = byName.get('metadata-contract')
    expect(metadata?.['keyCount']).toBe(2)
    expect(metadata?.['engineFieldsUnset']).toBe(true)

    // m1-3 cancel semantics: both cancel surfaces settle null.
    const cancel = byName.get('cancel-semantics')
    expect(cancel?.['fsaCancelResolvedNull']).toBe(true)
    expect(cancel?.['inputCancelResolvedNull']).toBe(true)
    expect(cancel?.['nonAbortPropagated']).toBe(true)
  })
})
