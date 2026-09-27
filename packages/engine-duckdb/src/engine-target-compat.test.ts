// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Interim compiler-enforced type pin: `@assay/engine-duckdb` ⟷ `@assay/engine`.
 *
 * Task **au2-2** (orchestrator-dispatched). `@assay/engine` holds the
 * `DataEngine` *target* interface (docs/architecture/01-architecture.md §7),
 * but nothing imports it today and its fate is decision **D13-pending**
 * (docs/process/handoff/20260926-maintainer-rulings.md). `@assay/engine-duckdb`
 * deliberately re-declares parallel types and only asserts structural
 * compatibility in prose (`client.ts`: "Structurally compatible with
 * @assay/engine's TableHandle"; `protocol.ts`: profile types "mirror"
 * `@assay/engine`'s). Those comments were untested: this module turns the
 * claims into compile-time assertions so drift fails `pnpm typecheck`/CI
 * instead of hiding in a comment.
 *
 * Design:
 * - Positive pins use the `AssignableTo<Target, Source extends Target>` form,
 *   collected in one exported tuple; any failing element is a `tsc` error.
 * - Documented divergences are negative pins via `@ts-expect-error`, so fixing
 *   a divergence (directive becomes unused) *and* worsening it both fail.
 * - Purely type-level: no casts, no `any`, no runtime values, no `@ts-ignore`.
 *
 * This is NOT the D13 decision: it neither deletes, rewrites, nor wires
 * `@assay/engine`.
 */
import { describe, expect, it } from 'vitest'
import type {
  CategoricalColumnStats,
  CategoricalTopKEntry,
  ColumnProfile,
  DataEngine,
  DatasetProfile,
  NumericColumnStats,
  NumericQuantiles,
  ProfileColumnKind,
  TableHandle,
} from '@assay/engine'
import type { DuckDbEngineClient, EngineDatasetProfile, EngineTableHandle } from './client.js'
import type {
  EngineCategoricalColumnStats,
  EngineCategoricalTopKEntry,
  EngineColumnSchema,
  EngineNumericColumnStats,
  EngineNumericQuantiles,
  EngineProfileColumn,
  EngineProfileColumnKind,
} from './protocol.js'

/**
 * `AssignableTo<Target, Source>` compiles only when `Source` is assignable to
 * `Target` (the constraint): a failed relation is a TS2344 at the use site.
 */
type AssignableTo<Target, Source extends Target> = Source

/**
 * Every relation engine-duckdb documents (or that genuinely overlaps today),
 * asserted in the direction that matters. A failing element fails `tsc`.
 */
export type EngineTargetCompatibilityPins = [
  // Table handle identity — claimed in client.ts, and true in both directions.
  AssignableTo<TableHandle, EngineTableHandle>,
  AssignableTo<EngineTableHandle, TableHandle>,
  // Schema cell: engine's anonymous `{ name, type }` vs EngineColumnSchema.
  AssignableTo<{ name: string; type: string }, EngineColumnSchema>,
  AssignableTo<EngineColumnSchema, { name: string; type: string }>,
  // Profile leaf types — protocol.ts calls these structural mirrors; they are
  // mutually assignable in both directions.
  AssignableTo<ProfileColumnKind, EngineProfileColumnKind>,
  AssignableTo<EngineProfileColumnKind, ProfileColumnKind>,
  AssignableTo<NumericQuantiles, EngineNumericQuantiles>,
  AssignableTo<EngineNumericQuantiles, NumericQuantiles>,
  AssignableTo<NumericColumnStats, EngineNumericColumnStats>,
  AssignableTo<EngineNumericColumnStats, NumericColumnStats>,
  AssignableTo<CategoricalTopKEntry, EngineCategoricalTopKEntry>,
  AssignableTo<EngineCategoricalTopKEntry, CategoricalTopKEntry>,
  AssignableTo<CategoricalColumnStats, EngineCategoricalColumnStats>,
  AssignableTo<EngineCategoricalColumnStats, CategoricalColumnStats>,
  AssignableTo<ColumnProfile, EngineProfileColumn>,
  AssignableTo<EngineProfileColumn, ColumnProfile>,
  // `@assay/engine`'s target profile result is consumable by duckdb's
  // (readonly-typed) profile surface — this direction holds today.
  AssignableTo<EngineDatasetProfile, DatasetProfile>,
  // The one DuckDbEngineClient method whose signature genuinely overlaps
  // `DataEngine`; asserted directly so the overlap is pinned, not assumed.
  AssignableTo<DataEngine['schema'], DuckDbEngineClient['schema']>,
]

// ---- Documented divergences (negative pins) -------------------------------
//
// Each `@ts-expect-error` is a *known* incompatibility: if the two sides are
// ever reconciled, the directive becomes unused (TS2578) and the build fails,
// forcing this pin to be updated deliberately alongside the change.

// EngineDatasetProfile pins `readonly columns: readonly EngineProfileColumn[]`;
// engine's mutable `columns: ColumnProfile[]` is therefore not preserved in
// that direction (the duckdb→engine result compatibility gap).
// @ts-expect-error au2-2 known divergence: readonly container, see comment.
export type _EngineDatasetProfileMismatch = AssignableTo<DatasetProfile, EngineDatasetProfile>

// DuckDbEngineClient is NOT a DataEngine implementation today: `exportTable`
// is absent and `open`/`query`/`profile`/`exportView` diverge (below).
// @ts-expect-error au2-2: class does not satisfy DataEngine (missing exportTable + method drift).
export type _ClientMismatch = AssignableTo<DataEngine, DuckDbEngineClient>

// `open`: EngineFileSource `{ name, getFile() }` vs DataSource `{ id, kind, … }`.
// @ts-expect-error au2-2 known divergence: source seam differs from DataSource.
export type _OpenMismatch = AssignableTo<DataEngine['open'], DuckDbEngineClient['open']>

// `query`: `(sql: string) => Promise<EngineQueryResult>` vs
// `(request: QueryRequest) => Promise<ArrowBatchStream>`.
// @ts-expect-error au2-2 known divergence: request/result shape differs.
export type _QueryMismatch = AssignableTo<DataEngine['query'], DuckDbEngineClient['query']>

// `profile`: same readonly container gap as `_EngineDatasetProfileMismatch`.
// @ts-expect-error au2-2 known divergence: readonly EngineDatasetProfile result.
export type _ProfileMismatch = AssignableTo<DataEngine['profile'], DuckDbEngineClient['profile']>

// `exportView(handle, request) => EngineExportResult` vs
// `exportTable(table, format, options) => ReadableStream<Uint8Array>`.
// Short aliases keep the `@ts-expect-error` on the same line as the offending
// type argument (Prettier would otherwise wrap the long `AssignableTo<…>`).
type _TargetExportTable = DataEngine['exportTable']
type _ClientExportView = DuckDbEngineClient['exportView']
// @ts-expect-error au2-2 known divergence: export op shape differs.
export type _ExportMismatch = AssignableTo<_TargetExportTable, _ClientExportView>

describe('@assay/engine target compatibility pin (au2-2, D13-pending)', () => {
  it('type pins compile', () => {
    // The assertions are the exported type aliases above: a broken relation is
    // a `tsc` error under `pnpm typecheck`, and an unused `@ts-expect-error`
    // (a reconciled divergence) is likewise an error. Nothing runs at runtime.
    expect(true).toBe(true)
  })
})
