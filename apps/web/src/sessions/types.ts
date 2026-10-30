// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EngineTableHandle } from '@assay/engine-duckdb'
import type { OverlayBase } from '@assay/domain'
import type { GridViewportModel } from '@assay/grid'
import type { DuckDbGridProvider } from '../grid/provider'

/**
 * App phases. `ready` holds the composed grid: adapter (engine client) →
 * provider (`GridDataProvider`) → headless model → virtualized DOM renderer
 * (docs/architecture/01-architecture.md §8). Only the table id, row count,
 * and column count are shown — never the picked file's name (ADR 0025).
 *
 * m3-5: the ready phase also wires the one-click nested actions.
 *
 * m4-3: the ready phase also owns the editing session. The immutable
 * `OverlayBase` (host tokens + base schema + base row count) is built once
 * when a file opens; every edit is a typed `EditOp` appended to a
 * `TransformationHistory`, and the grid's provider reads the active overlay
 * snapshot (`stateAtCursor` prefix) per request. Undo/redo are cursor moves
 * on that history; the grid re-materializes via a fresh data epoch. The base
 * view is never mutated (ADR 0012), and no edit or cell value is logged
 * (ADR 0025).
 */
export type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening' }
  | {
      readonly kind: 'error'
      readonly message: string
      /**
       * The failing exception's `name`, when the open chain caught one (UG-5).
       * A `DOMException` from `getFile()` carries its cause in the name, not
       * the message, so the alert must classify on it rather than the text.
       * Optional so text-only constructors/tests stay valid; never telemetry.
       */
      readonly errorName?: string
    }
  | {
      readonly kind: 'ready'
      readonly model: GridViewportModel
      readonly tableId: string
      readonly handle: EngineTableHandle
      /** Immutable base metadata for the editing session (ADR 0011/0012). */
      readonly base: OverlayBase
      /** Overlay-aware provider; the grid reads the effective view through it (m4-3). */
      readonly provider: DuckDbGridProvider
    }

/**
 * m5-3 jump-to-row: the grid scrolls to this effective row index. `seq` makes
 * every gesture distinct (the same row can be re-targeted). Immediate gesture
 * — not tracked across epochs. Shared by the validation and diff panels.
 */
export interface ScrollRequest {
  readonly rowIndex: number
  readonly seq: number
}

/**
 * Cross-session jump handler: resolve a sample's logical row key, then scroll
 * the grid and open the record inspector. Owned by the composition root and
 * handed to the validation/diff hooks so both gesture surfaces drive the same
 * navigation channel (m5-3 / m6-4).
 */
export type NavigateToRow = (rowIndex: number) => void
