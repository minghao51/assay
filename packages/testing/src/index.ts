// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/testing — reusable fixtures, helpers, and conformance suites.
 *
 * Conformance suites are the mechanism that lets engines and adapters evolve
 * without changing product behavior (docs/engineering/03-repository-structure.md §4):
 * every DataEngine implementation, DataSource adapter, and contract adapter
 * passes the same suite. Suites are introduced with their first implementations
 * (M1, M5); this scaffold ships the fixture manifest helpers.
 */

/** Conformance suites that implementations must pass (introduced M1/M5). */
export const conformanceSuiteNames = ['data-engine', 'data-source', 'contract-adapter'] as const

export type ConformanceSuiteName = (typeof conformanceSuiteNames)[number]

/**
 * The data-engine conformance suite (T1): lazy boot, file lifecycle, error
 * classes, window clamping, Arrow shape, corrupt-file open rollback, and
 * mid-stream error then reuse — parameterized over an
 * `EngineConformanceSubject` so every engine implementation runs the same
 * scenarios (docs/engineering/03-repository-structure.md §4).
 */
export * from './engine-conformance'

/**
 * The data-source behavior suite (T3): identity/idempotency (frozen handle,
 * stable identity), one-shot file resolution (incl. the additive `getFile`
 * seam), metadata contract (format + size only), cancel semantics (settled
 * `null`), capability-matrix detection, and R5 fallback order —
 * parameterized over a `DataSourceBehaviorSubject` so every DataSource
 * adapter runs the same scenarios (docs/engineering/03-repository-structure.md
 * §4). Structural types only: the root entry stays environment-neutral.
 */
export * from './data-source-behavior'
