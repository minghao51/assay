/**
 * Engine-facing overlay projection (m4-3).
 *
 * ## Why this exists (and the defect it works around)
 *
 * The m4-2 engine composes the effective view from the domain's folded
 * `OverlayState`. Its SQL composer has one gap that the m4-3 client surface
 * exposes: a `cell-set`/`cell-revert` targeting an **inserted** row changes
 * the domain fold (`state.edits`, exactly as m4-1 specifies) but the engine's
 * insert branch is built from `InsertedRowRecord.values` only, so the edit is
 * silently dropped (`CAST(NULL …)` where the user's value should be). The
 * domain's own tests pin that inserted-row edits are effective, so this is an
 * engine defect, not an intended narrowing.
 *
 * The engine's public surface (`@assay/engine-duckdb` `fetchOverlayRange`
 * and friends) is `{ base, ops }` — it folds the ops itself. It is sufficient
 * for the *semantics* m4-3 needs: the host can project the already-folded
 * state into an equivalent op list that the engine composes correctly. That
 * is what this module does — at the composition root, without touching the
 * engine (the worker is not authorized to edit `engine-duckdb`). The report
 * flags the underlying defect for a proper engine fix; m4-4's rename/cast
 * work will want that fix, because this projection has to replay schema ops
 * to stay correct.
 *
 * ## The projection
 *
 * `projectOverlayOps(base, state, schemaOps)` rebuilds an op list from the
 * **final folded state** (the source of truth for the effective view):
 *
 * 1. **Schema ops first**: the original `column-rename` / `column-cast`
 *    subsequence, replayed in order. Replaying the real sequence (not a
 *    positional diff) is required for correctness: rename sequences can free
 *    and reuse names (`B→C` then `A→B`), and a positional rewrite would
 *    collide. Replaying reproduces the final schema exactly.
 * 2. **Base-row edits**: one `cell-set` per final overlay edit, keyed by the
 *    final (post-rename) column name — emitted *before* tombstones so the
 *    fold never sees an edit of a deleted row.
 * 3. **Inserts**: one `row-insert` per record with the row's **effective**
 *    values (original insert values merged with its final cell edits, which
 *    is exactly the value the engine should project), followed by a
 *    `row-delete` for tombstoned records so liveness folds back.
 * 4. **Base tombstones** last: one `row-delete` per deleted ordinal.
 *
 * The projected list folds (through the same domain `stepOverlay`) to a state
 * semantically identical to the input: same effective schema, same live-row
 * set and order, same effective cell values — the property the unit tests
 * pin. `nextInsertSeq` may differ (the projection has no allocation history);
 * the engine never reads it for composition.
 *
 * Purity: domain types only, no React/DOM/engine imports; never throws.
 */
import type {
  CellValue,
  CellValueRecord,
  EditOp,
  InsertedRowRecord,
  OverlayBase,
  OverlayState,
} from '@assay/domain'
import { baseRowId, parseRowId } from '@assay/domain'

/** The m4-4-era schema ops replayed verbatim (they are order-sensitive). */
export function isSchemaOp(op: EditOp): boolean {
  return op.kind === 'column-rename' || op.kind === 'column-cast'
}

/** The effective values of one inserted row: its edits win over its seed values. */
function effectiveInsertValues(
  record: InsertedRowRecord,
  edits: ReadonlyMap<string, CellValue> | undefined,
): CellValueRecord {
  if (edits === undefined || edits.size === 0) return record.values
  const merged = new Map<string, CellValue>(record.values)
  for (const [column, value] of edits) merged.set(column, value)
  return merged
}

/**
 * Project the folded overlay `state` into an equivalent op list the engine
 * composes correctly (see the module doc). `schemaOps` is the active
 * `column-rename`/`column-cast` subsequence, in original order.
 */
export function projectOverlayOps(
  base: OverlayBase,
  state: OverlayState,
  schemaOps: readonly EditOp[],
): EditOp[] {
  const ops: EditOp[] = []
  // 1. Schema ops, verbatim and in order.
  for (const op of schemaOps) {
    if (isSchemaOp(op)) ops.push(op)
  }
  // 2. Base-row edits (final names), before any tombstone.
  for (const [rowId, edits] of state.edits) {
    const parsed = parseRowId(rowId)
    if (parsed === null || parsed.origin !== 'base' || parsed.anchor !== base.baseAnchor) {
      // Inserted-row edits are folded into their insert values in step 3;
      // foreign-anchor edits are already absorbed by the fold.
      continue
    }
    for (const [column, value] of edits) {
      ops.push({ kind: 'cell-set', rowId, column, value })
    }
  }
  // 3. Inserts with their effective values (+ tombstone for dead records).
  for (const record of state.inserts.values()) {
    ops.push({
      kind: 'row-insert',
      rowId: record.id,
      position: record.position,
      values: effectiveInsertValues(record, state.edits.get(record.id)),
    })
    if (!record.live) ops.push({ kind: 'row-delete', rowId: record.id })
  }
  // 4. Base tombstones last.
  for (const ordinal of [...state.deletedBase].sort((a, b) => a - b)) {
    ops.push({ kind: 'row-delete', rowId: baseRowId(base.baseAnchor, ordinal) })
  }
  return ops
}
