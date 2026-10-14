// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EditOp, OverlayBase, TransformationHistory } from '@assay/domain'
import type { EngineOverlay } from '@assay/engine-duckdb'

/** Project a history cursor to the engine's stateless overlay request shape. */
export function overlaySnapshot(base: OverlayBase, history: TransformationHistory): EngineOverlay {
  const ops: EditOp[] = history.entries.slice(0, history.cursor).map((entry) => entry.op)
  return { base, ops }
}
