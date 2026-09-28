// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Below-fold panels are dynamically imported (au3-12): each stays in its own
 * chunk, out of the initial bundle, so the first paint carries the open flow,
 * schema tree, editing toolbar and grid only. The props/state wiring is
 * unchanged — only the import boundary moves — and each panel keeps its own
 * intra-panel loading states.
 *
 * The loader promises are memoized so repeated opens share one chunk fetch.
 * Instead of `React.lazy` + `Suspense`, the resolved components are held in
 * state and published BEFORE the `ready` phase: `React.lazy` always suspends
 * its first render one tick (fallback → swap) even with the module resident,
 * and that post-`ready` re-render raced the first cell double-click
 * (integration fix, 2026-09-28: the editor occasionally never opened because
 * the swap landed mid-gesture). Awaiting the modules inside the open flow and
 * rendering them synchronously from state removes that window entirely — no
 * Suspense fallback cycle, no post-`ready` panel churn. A failed chunk load
 * fails the open flow itself (honest: the chunks ship with the app).
 *
 * f-1: lifted verbatim from `App.tsx`; the module-state pattern is the pinned
 * property, not its file location.
 */
export interface BottomPanelModules {
  readonly ValidationPanel: (typeof import('../validation/ValidationPanel'))['ValidationPanel']
  readonly DiffPanel: (typeof import('../diff/DiffPanel'))['DiffPanel']
  readonly SqlPanel: (typeof import('../sql/SqlPanel'))['SqlPanel']
  readonly ProfilePanel: (typeof import('../profile/ProfilePanel'))['ProfilePanel']
}

let validationPanelImport: Promise<typeof import('../validation/ValidationPanel')> | null = null
let diffPanelImport: Promise<typeof import('../diff/DiffPanel')> | null = null
let sqlPanelImport: Promise<typeof import('../sql/SqlPanel')> | null = null
let profilePanelImport: Promise<typeof import('../profile/ProfilePanel')> | null = null

const loadValidationPanel = (): Promise<typeof import('../validation/ValidationPanel')> =>
  (validationPanelImport ??= import('../validation/ValidationPanel'))
const loadDiffPanel = (): Promise<typeof import('../diff/DiffPanel')> =>
  (diffPanelImport ??= import('../diff/DiffPanel'))
const loadSqlPanel = (): Promise<typeof import('../sql/SqlPanel')> =>
  (sqlPanelImport ??= import('../sql/SqlPanel'))
const loadProfilePanel = (): Promise<typeof import('../profile/ProfilePanel')> =>
  (profilePanelImport ??= import('../profile/ProfilePanel'))

/**
 * Load every below-fold chunk (see above). Resolves to the panel components
 * the open flow publishes as state before `ready`, so the composed grid and
 * panels mount in one synchronous render.
 */
export function preloadBottomPanels(): Promise<BottomPanelModules> {
  return Promise.all([
    loadValidationPanel(),
    loadDiffPanel(),
    loadSqlPanel(),
    loadProfilePanel(),
  ]).then(([validation, diff, sql, profile]) => ({
    ValidationPanel: validation.ValidationPanel,
    DiffPanel: diff.DiffPanel,
    SqlPanel: sql.SqlPanel,
    ProfilePanel: profile.ProfilePanel,
  }))
}
