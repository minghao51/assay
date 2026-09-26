// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/contracts — the native data-contract format (m5-0; ADR 0013/0026).
 *
 * A pure package: the canonical v1 Contract AST, a total (never-throwing)
 * YAML parser with typed line/column errors, the canonical serializer, and
 * the documented declared-type vocabulary. No React, no browser APIs, no
 * engine or other `@assay/*` imports (docs/engineering/
 * 03-repository-structure.md §3, lint-enforced) — one runtime dependency:
 * the `yaml` parser.
 *
 * Downstream map: the m5-1 validation compiler consumes
 * `ContractParseResult['contract']`; the m5-2 engine executes its plans;
 * the m5-5 JSON Schema adapter builds ASTs and validates them via
 * `parseContract(serializeContract(ast))` — the adapter's internal
 * invariant shield does exactly that on every successful conversion.
 *
 * Export discipline mirrors `@assay/domain`: the public surface is the
 * format itself plus the documented JSON Schema adapter — test-support
 * generators (`property-testing.ts`) and the internal YAML-node walk
 * (`validate.ts`) stay in-package.
 */
export * from './ast.js'
export * from './vocabulary.js'
export * from './errors.js'
export * from './parse.js'
export * from './serialize.js'
export * from './re2-subset.js'
export * from './json-schema.js'
