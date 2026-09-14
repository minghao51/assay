/**
 * @dataworkbench/testing — reusable fixtures, helpers, and conformance suites.
 *
 * Conformance suites are the mechanism that lets engines and adapters evolve
 * without changing product behavior (docs/engineering/05-repository-structure.md §4):
 * every DataEngine implementation, DataSource adapter, and contract adapter
 * passes the same suite. Suites are introduced with their first implementations
 * (M1, M5); this scaffold ships the fixture manifest helpers.
 */

/** Conformance suites that implementations must pass (introduced M1/M5). */
export const conformanceSuiteNames = ['data-engine', 'data-source', 'contract-adapter'] as const

export type ConformanceSuiteName = (typeof conformanceSuiteNames)[number]
