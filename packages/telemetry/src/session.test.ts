// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { MAX_DATASET_OPENED_PER_SESSION, createSessionTracker } from './index.js'

describe('session tracker — §5.1/§5.2 carry-overs', () => {
  it('increments localSeq monotonically from 1', () => {
    const tracker = createSessionTracker()
    expect([tracker.nextSeq(), tracker.nextSeq(), tracker.nextSeq()]).toEqual([1, 2, 3])
  })

  it('reports the first query of the session exactly once', () => {
    const tracker = createSessionTracker()
    expect(tracker.firstQueryOfSession()).toBe(true)
    expect(tracker.firstQueryOfSession()).toBe(false)
    expect(tracker.firstQueryOfSession()).toBe(false)
  })

  it('caps dataset_opened at 50 per session, then drops', () => {
    const tracker = createSessionTracker()
    for (let index = 0; index < MAX_DATASET_OPENED_PER_SESSION; index++) {
      expect(tracker.noteDatasetOpened(), `open ${String(index)}`).toBe(true)
    }
    expect(tracker.noteDatasetOpened()).toBe(false)
    expect(tracker.noteDatasetOpened()).toBe(false)
  })

  it('honors an injected dataset_opened cap (tests)', () => {
    const tracker = createSessionTracker({ datasetOpenedCap: 2 })
    expect(tracker.noteDatasetOpened()).toBe(true)
    expect(tracker.noteDatasetOpened()).toBe(true)
    expect(tracker.noteDatasetOpened()).toBe(false)
  })
})
