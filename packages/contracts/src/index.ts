/**
 * @assay/contracts — the native data-contract format (m5-0; ADR 0013/0026).
 *
 * A pure package: the canonical v1 Contract AST, a total (never-throwing)
 * YAML parser with typed line/column errors, the canonical serializer, and
 * the documented declared-type vocabulary. No React, no browser APIs, no
 * engine or other `@assay/*` imports (docs/engineering/
 * 05-repository-structure.md §3, lint-enforced) — one runtime dependency:
 * the `yaml` parser.
 *
 * Downstream map: the m5-1 validation compiler consumes
 * `ContractParseResult['contract']`; the m5-2 engine executes its plans;
 * the m5-5 adapters build ASTs and validate them via
 * `parseContract(serializeContract(ast))`.
 *
 * Export discipline mirrors `@assay/domain`: the public surface is the
 * format itself — test-support generators (`property-testing.ts`) and the
 * internal YAML-node walk (`validate.ts`) stay in-package.
 */
export * from './ast'
export * from './vocabulary'
export * from './errors'
export * from './parse'
export * from './serialize'
