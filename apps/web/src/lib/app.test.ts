import { describe, expect, it } from 'vitest'
import { APP_NAME, NEXT_MILESTONE, SCAFFOLD_STATUS, TAGLINE } from './app'

// AR-W6 (2026-09-22 audit): this pin exists to keep the idle-screen copy
// HONEST, not to freeze it. The pre-audit version pinned "pre-MVP — M0
// complete, M1 in progress" long after M0–M6 completed, and the pin is
// exactly what kept the stale claim in place. When the status changes,
// update SCAFFOLD_STATUS/NEXT_MILESTONE *and this pin together* — the test
// must always assert the current truth (roadmap §4 / post-MVP track doc).
describe('app scaffold metadata', () => {
  it('identifies the product', () => {
    expect(APP_NAME).toBe('Assay')
    expect(TAGLINE).toBe('The local-first data workbench')
  })

  it('pins the current honest status (update together with the copy)', () => {
    expect(SCAFFOLD_STATUS).toBe('MVP complete (M0–M6) — post-MVP track in progress')
    expect(NEXT_MILESTONE).toBe(
      'PT-0: launch readiness to gate G0 (then the D12-chosen engineering track)',
    )
    // The stale pre-MVP claim must never return.
    expect(SCAFFOLD_STATUS).not.toContain('pre-MVP')
    expect(NEXT_MILESTONE).not.toContain('M1')
  })
})
