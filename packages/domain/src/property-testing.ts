// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deterministic generators for the m4-1 property tests (test support only —
 * NOT part of the public surface; `index.ts` never re-exports this module).
 *
 * Repo convention is determinism: no `Math.random`. Everything derives from
 * a seedable PRNG (mulberry32) so a failing seed reproduces exactly; seeds
 * are fixed in the test files on purpose.
 */
import type { CellValue, CellValueRecord, ColumnSpec, EditOp, InsertPosition } from './edit-ops.js'
import { DEFAULT_REPAIR_TRIM_CODE_POINTS, NULL_VALUE } from './edit-ops.js'
import type { OverlayBase, OverlayState } from './overlay.js'
import { foldOverlay } from './overlay.js'
import { baseRowId, insertRowId, parseRowId } from './row-identity.js'
import type { RowId } from './row-identity.js'

/** mulberry32 — 32-bit seeded PRNG, deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Small deterministic RNG facade over mulberry32. */
export interface TestRng {
  /** Next float in [0, 1). */
  float(): number
  /** Next integer in [min, max] inclusive. */
  int(min: number, max: number): number
  /** Uniform pick; list must be non-empty. */
  pick<T>(items: readonly T[]): T
  /** True with probability p (default 0.5). */
  bool(p?: number): boolean
  /** Fisher–Yates shuffle (returns a fresh array). */
  shuffle<T>(items: readonly T[]): T[]
}

export function makeTestRng(seed: number): TestRng {
  const next = mulberry32(seed)
  const rng: TestRng = {
    float: next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    bool: (p = 0.5) => next() < p,
    shuffle: (items) => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const tmp = out[i] as (typeof out)[number]
        out[i] = out[j] as (typeof out)[number]
        out[j] = tmp
      }
      return out
    },
  }
  return rng
}

/** Generate a host anchor token; sometimes includes `#`/`:`/unicode to stress parsing. */
export function genAnchor(rng: TestRng, tag: string): string {
  const tricky = ['#', ':', '#1', 'üñ', '.', '-', '_']
  const stem = `${tag}-${rng.int(0, 1_000_000)}`
  return rng.bool(0.3) ? `${stem}${rng.pick(tricky)}` : stem
}

const COLUMN_NAME_POOL = ['id', 'name', 'amount', 'ts', 'flag', 'note']

export function genColumns(rng: TestRng): ColumnSpec[] {
  const names = rng.shuffle(COLUMN_NAME_POOL).slice(0, rng.int(2, COLUMN_NAME_POOL.length))
  const types = ['BIGINT', 'VARCHAR', 'DOUBLE', 'BOOLEAN', 'DATE', 'DECIMAL(18,3)']
  return names.map((name) => ({ name, type: rng.pick(types) }))
}

export function genBase(rng: TestRng, tag = 'fixture'): OverlayBase {
  return {
    baseAnchor: genAnchor(rng, `${tag}-base`),
    overlayAnchor: genAnchor(rng, `${tag}-ovl`),
    columns: genColumns(rng),
    baseRowCount: rng.int(0, 40),
  }
}

export function genCellValue(rng: TestRng): CellValue {
  const roll = rng.int(0, 9)
  if (roll <= 2) return NULL_VALUE
  if (roll <= 4) return { kind: 'boolean', value: rng.bool() }
  if (roll <= 6) return { kind: 'number', value: rng.int(-1000, 1000) }
  if (roll <= 8) return { kind: 'string', value: `v${rng.int(0, 50)}` }
  return { kind: 'text', text: `2026-09-${String(rng.int(1, 28)).padStart(2, '0')}` }
}

/** A partial value record over `columns` (absent keys materialize as NULL). */
export function genValueRecord(rng: TestRng, columns: readonly ColumnSpec[]): CellValueRecord {
  const values = new Map<string, CellValue>()
  for (const column of columns) {
    if (rng.bool(0.7)) values.set(column.name, genCellValue(rng))
  }
  return values
}

function genRowIdOfAnyShape(rng: TestRng, base: OverlayBase, state: OverlayState): RowId {
  const roll = rng.int(0, 3)
  if (roll === 0) return baseRowId(base.baseAnchor, rng.int(0, Math.max(0, base.baseRowCount - 1)))
  if (roll === 1) {
    const ids = [...state.inserts.keys()]
    return ids.length > 0
      ? (rng.pick(ids) as RowId)
      : insertRowId(base.overlayAnchor, state.nextInsertSeq)
  }
  if (roll === 2) return insertRowId(base.overlayAnchor, state.nextInsertSeq)
  return baseRowId(genAnchor(rng, 'foreign'), rng.int(0, 10))
}

function genInsertPosition(rng: TestRng, base: OverlayBase, state: OverlayState): InsertPosition {
  const roll = rng.int(0, 3)
  if (roll === 0) return { kind: 'start' }
  if (roll === 1) return { kind: 'end' }
  const anchor = rng.bool(0.5)
    ? baseRowId(base.baseAnchor, rng.int(0, Math.max(0, base.baseRowCount - 1)))
    : (([...state.inserts.keys()][0] as RowId | undefined) ??
      baseRowId(base.baseAnchor, rng.int(0, Math.max(0, base.baseRowCount - 1))))
  return roll === 2 ? { kind: 'before', rowId: anchor } : { kind: 'after', rowId: anchor }
}

/**
 * One op biased toward *applicable* (it consults the current state for ids,
 * columns, and the next insert seq), but with a dose of noise so conflicts
 * and no-ops occur naturally. `garbage` skips the state entirely.
 */
/**
 * One generated `column-repair` (the shared P1 arm, ADR 0050 decision 3): a
 * plan against a textual column of the current state, from the non-commuting
 * P8 mapping pool. Draws sometimes carry a trim-spec mismatch against the
 * chain (a typed conflict the properties must survive) or an empty plan (the
 * typed `repair-identity` no-op), so conflicts and no-ops occur naturally.
 */
export function genRepairOp(rng: TestRng, state: OverlayState): EditOp {
  const textual = state.columns.filter((column) =>
    ['VARCHAR', 'TEXT', 'STRING'].includes(column.type.toUpperCase()),
  )
  if (textual.length === 0) return genGarbageOp(rng)
  const pool: ReadonlyArray<readonly (readonly [string, string])[]> = [
    [['old', 'middle']],
    [['middle', 'final']],
    [['old', 'new']],
    [['a', 'b']],
  ]
  const mapping = new Map<string, string>()
  const pairs = rng.int(0, 2)
  for (let i = 0; i < pairs; i++) {
    const [from, to] = rng.pick(rng.pick(pool))
    mapping.set(from, to)
  }
  const trim = rng.bool(0.1) ? ' \t' : rng.bool(0.7) ? DEFAULT_REPAIR_TRIM_CODE_POINTS : undefined
  return {
    kind: 'column-repair',
    column: rng.pick(textual).name,
    ...(trim !== undefined ? { trim } : {}),
    mapping,
  }
}

export function genOp(
  rng: TestRng,
  base: OverlayBase,
  state: OverlayState,
  garbage = false,
): EditOp {
  if (garbage) return genGarbageOp(rng)
  // EW-04D repair arm (ADR 0050 decision 3): the shared generator produces
  // `column-repair` ops so every property walk exercises repairs. Drawing a
  // repair changes what existing seeds generate — the properties assert
  // invariants, not goldens, so that is a corpus change, not a regression.
  if (rng.bool(1 / 14)) return genRepairOp(rng, state)
  const liveBaseOrdinals: number[] = []
  for (let ordinal = 0; ordinal < base.baseRowCount; ordinal++) {
    if (!state.deletedBase.has(ordinal)) liveBaseOrdinals.push(ordinal)
  }
  const liveInsertIds = [...state.inserts.values()].filter((r) => r.live).map((r) => r.id)
  const deadIds = [
    ...[...state.deletedBase].map((ordinal) => baseRowId(base.baseAnchor, ordinal)),
    ...[...state.inserts.values()].filter((r) => !r.live).map((r) => r.id),
  ]
  const columns = state.columns

  const roll = rng.int(0, 12)
  if (roll <= 3 && columns.length > 0) {
    // cell-set — sometimes repeats the current edit (forces a no-op)
    const rowId = genRowIdOfAnyShape(rng, base, state)
    const column = rng.pick(columns).name
    const current = state.edits.get(rowId)?.get(column)
    const value = current !== undefined && rng.bool(0.3) ? current : genCellValue(rng)
    return { kind: 'cell-set', rowId, column, value }
  }
  if (roll === 4 && columns.length > 0) {
    return {
      kind: 'cell-revert',
      rowId: genRowIdOfAnyShape(rng, base, state),
      column: rng.pick(columns).name,
    }
  }
  if (roll <= 7) {
    // Allocator discipline: a fresh insert takes exactly the overlay's next
    // seq — gap-free allocation is what makes counter restoration under
    // undo exact (see OverlayState.nextInsertSeq).
    return {
      kind: 'row-insert',
      rowId: insertRowId(base.overlayAnchor, state.nextInsertSeq),
      position: genInsertPosition(rng, base, state),
      values: genValueRecord(rng, columns),
    }
  }
  if (roll === 8) {
    const id =
      liveBaseOrdinals.length > 0 && liveInsertIds.length > 0
        ? rng.bool()
          ? baseRowId(base.baseAnchor, rng.pick(liveBaseOrdinals))
          : rng.pick(liveInsertIds)
        : liveBaseOrdinals.length > 0
          ? baseRowId(base.baseAnchor, rng.pick(liveBaseOrdinals))
          : liveInsertIds.length > 0
            ? rng.pick(liveInsertIds)
            : baseRowId(base.baseAnchor, 0)
    return { kind: 'row-delete', rowId: id }
  }
  if (roll === 9) {
    const id =
      deadIds.length > 0
        ? rng.pick(deadIds)
        : baseRowId(base.baseAnchor, rng.int(0, Math.max(0, base.baseRowCount - 1)))
    return { kind: 'row-restore', rowId: id }
  }
  if (roll === 10 && columns.length > 0) {
    const from = rng.pick(columns).name
    const to = rng.bool(0.3) ? from : `renamed-${rng.int(0, 20)}`
    return { kind: 'column-rename', from, to }
  }
  if (roll === 11 && columns.length > 0) {
    const column = rng.pick(columns).name
    const current = columns.find((c) => c.name === column)
    const targetType =
      current !== undefined && rng.bool(0.2)
        ? current.type
        : rng.pick(['BIGINT', 'VARCHAR', 'DOUBLE', 'DATE'])
    return { kind: 'column-cast', column, targetType }
  }
  if (roll === 12) {
    // Expunge any inserted row (live or tombstoned) — the exact undo op.
    const ids = [...state.inserts.keys()]
    return {
      kind: 'row-uninsert',
      rowId:
        ids.length > 0
          ? (rng.pick(ids) as RowId)
          : insertRowId(base.overlayAnchor, state.nextInsertSeq),
    }
  }
  return genGarbageOp(rng)
}

/** A deliberately unstructured op — shapes the conflict rules must survive. */
export function genGarbageOp(rng: TestRng): EditOp {
  const junkText = () => rng.pick(['', 'x', 'a#1', 'base:', '#9', '007', 'NULL', 'ü'])
  const junkId = () =>
    rng.pick([
      junkText(),
      `base:${junkText()}#${junkText()}`,
      `ins:${junkText()}#${rng.int(0, 5)}`,
      `base:${genAnchor(rng, 'gb')}#${rng.int(0, 9)}`,
      `ins:${genAnchor(rng, 'gb')}#${rng.int(0, 9)}`,
    ]) as RowId
  const roll = rng.int(0, 7)
  if (roll <= 1) {
    return { kind: 'cell-set', rowId: junkId(), column: junkText(), value: genCellValue(rng) }
  }
  if (roll === 2) return { kind: 'cell-revert', rowId: junkId(), column: junkText() }
  if (roll === 3) {
    return {
      kind: 'row-insert',
      rowId: junkId(),
      position: { kind: 'after', rowId: junkId() },
      values: new Map([[junkText(), genCellValue(rng)]]),
    }
  }
  if (roll === 4) return { kind: 'row-delete', rowId: junkId() }
  if (roll === 5) return { kind: 'row-restore', rowId: junkId() }
  if (roll === 6) return { kind: 'row-uninsert', rowId: junkId() }
  return { kind: 'column-cast', column: junkText(), targetType: junkText() }
}

/**
 * A generated op *session*: ops folded incrementally so most are applicable,
 * with `garbageRate` noise (0.15 default) exercising conflicts and no-ops.
 * Returns the ops plus every intermediate folded state (index i = state
 * after applying ops[0..i); index 0 = initial state).
 */
export function genOpSession(
  rng: TestRng,
  base: OverlayBase,
  length: number,
  garbageRate = 0.15,
): { readonly ops: EditOp[]; readonly states: OverlayState[] } {
  const ops: EditOp[] = []
  const states: OverlayState[] = [foldOverlay(base, []).state]
  for (let i = 0; i < length; i++) {
    const op = genOp(rng, base, states[states.length - 1] as OverlayState, rng.bool(garbageRate))
    ops.push(op)
    states.push(foldOverlay(base, ops).state)
  }
  return { ops, states }
}

/** Unused-but-plausible id probe: is this string a canonical RowId? */
export function isCanonicalRowId(text: string): boolean {
  return parseRowId(text as RowId) !== null
}
