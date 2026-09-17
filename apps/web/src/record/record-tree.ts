/**
 * The record inspector's tree model (m3-3) — the full-value layer the grid's
 * capped previews deliberately are not (m3-2: "the full value is the m3-3
 * inspector's job").
 *
 * Pure and Node-testable (repo convention: thin components over tested pure
 * modules). Input is one grid row as it arrives on the main thread: cell
 * values positional in schema column order (the `GridDataPage` row shape).
 * Output is a tree of nodes the component renders as a disclosure tree.
 *
 * The contract (each point unit-tested):
 * - **Total** — any input (cycles, hostile getters, exotic proxies, length
 *   mismatches) maps to a tree; this module never throws into the render
 *   path. Containers on the traversal path are tracked, so a cyclic value
 *   becomes a marked `(circular)` leaf; a value that throws while being read
 *   becomes a marked `(unreadable)` leaf.
 * - **Deterministic** — the same input builds the same tree. Column order is
 *   the schema order given by the caller; struct key order is the record's
 *   own delivered order (never re-sorted — a sorted order would lie about
 *   how the engine structured the data, the m3-2 ruling); list children are
 *   positional.
 * - **Honest distinctions** — `null`, `""`, `[]`, `{}` all classify and
 *   summarize differently; bigints render as number-strings; epoch-ms
 *   timestamps stay plain numbers (the m3-1 worker-boundary contract);
 *   binary views summarize as `<N bytes>`; `undefined` (defensive only —
 *   Arrow NULLs arrive as `null`) stays distinguishable from `null`.
 * - **Summaries are reused, not forked** — every node's one-line summary is
 *   `formatNestedPreview`'s bounded, total render of the value (imported
 *   from the grid's preview module). The tree adds what the preview cannot
 *   give: full-depth children.
 *
 * Values are untrusted content (ADR 0007 spirit): the model carries plain
 * strings for React text nodes — nothing here is ever interpreted as
 * markup, and nothing about dataset contents is logged (ADR 0025).
 */
import { formatNestedPreview, isListLike } from '../grid/nested-preview'

/** One grid row: schema column names + the row's cells, positional. */
export interface RecordRowInput {
  /**
   * Column names in schema order — the authority for the root's child order
   * (and for keys: cells are positional and carry no names of their own).
   */
  readonly columns: readonly string[]
  /** Cell values in the same order as `columns` (may be shorter; never read past `columns`). */
  readonly cells: readonly unknown[]
}

/** Node classification — the honest shape of one value. */
export type RecordNodeKind = 'object' | 'array' | 'leaf' | 'null'

export interface RecordTreeNode {
  /**
   * The field/column key exactly as delivered (any string — including the
   * quoting-hostile fixture key). List children key by position (`'0'`).
   */
  readonly key: string
  readonly kind: RecordNodeKind
  /** Bounded one-line summary (a `formatNestedPreview` render of the value). */
  readonly summary: string
  /** Child nodes (empty for leaf/null; positional or own-key order as delivered). */
  readonly children: readonly RecordTreeNode[]
}

/** Builds a leaf/null node; the only place summaries are produced. */
function terminalNode(key: string, kind: 'leaf' | 'null', summary: string): RecordTreeNode {
  return { key, kind, summary, children: [] }
}

/**
 * Classifies one value into a subtree. A hostile shape can throw anywhere in
 * `classifyUnchecked` (an ownKeys trap mid-walk, a throwing getter nested
 * deeper) and degrades to a marked leaf — at EVERY depth, so one hostile
 * field never sinks its siblings.
 */
function classifyNode(key: string, value: unknown, active: WeakSet<object>): RecordTreeNode {
  try {
    return classifyUnchecked(key, value, active)
  } catch {
    return terminalNode(key, 'leaf', '(unreadable)')
  }
}

/**
 * Reads one child value lazily INSIDE the guard, then classifies it: the
 * property access / positional `get` itself can throw (hostile getter), and
 * that failure must degrade the child alone — not the parent's traversal.
 */
function classifyChild(key: string, read: () => unknown, active: WeakSet<object>): RecordTreeNode {
  try {
    return classifyNode(key, read(), active)
  } catch {
    return terminalNode(key, 'leaf', '(unreadable)')
  }
}

/** The unchecked classification body (see `classifyNode` for the guard). */
function classifyUnchecked(key: string, value: unknown, active: WeakSet<object>): RecordTreeNode {
  // null FIRST — typeof null is 'object', and NULL-vs-empty is the point.
  if (value === null) return terminalNode(key, 'null', formatNestedPreview(value))
  if (typeof value !== 'object') {
    // Scalars incl. bigint (number-string via String) and the defensive
    // `undefined` (Arrow NULLs arrive as null; undefined would mean a
    // missing cell or a sparse-array hole — kept distinct from null).
    return terminalNode(key, 'leaf', formatNestedPreview(value))
  }
  const container: object = value
  if (active.has(container)) {
    // Re-entered through its own descendants: the marked leaf bounds the
    // walk and stays honest (the same marker text nested-preview uses).
    return terminalNode(key, 'leaf', '(circular)')
  }
  // Binary views are leaves (never a byte dump), checked before list-likeness
  // — `Uint8Array` has a numeric length and would otherwise read as a list.
  if (ArrayBuffer.isView(container) || value instanceof Date) {
    return terminalNode(key, 'leaf', formatNestedPreview(value))
  }
  if (Array.isArray(container)) {
    active.add(container)
    const children: RecordTreeNode[] = []
    // Index loop, not `.map`: sparse arrays must surface their holes as
    // `undefined` children, not silently shorten the list.
    for (let index = 0; index < container.length; index++) {
      children.push(classifyChild(String(index), () => container[index], active))
    }
    active.delete(container)
    return { key, kind: 'array', summary: formatNestedPreview(value), children }
  }
  if (isListLike(container)) {
    // Arrow list slices: read positionally through `get`, never via
    // property enumeration (whose keys are internal machinery).
    active.add(container)
    const listLike = container as { length: number; get(index: number): unknown }
    const children: RecordTreeNode[] = []
    for (let index = 0; index < listLike.length; index++) {
      children.push(classifyChild(String(index), () => listLike.get(index), active))
    }
    active.delete(container)
    return { key, kind: 'array', summary: formatNestedPreview(value), children }
  }
  // Record-like (struct cells arrive as plain records): children in the
  // object's own key order — deliberately never re-sorted (m3-2 ruling).
  active.add(container)
  const record = container as Record<string, unknown>
  const children = Object.keys(record).map((fieldKey) =>
    classifyChild(fieldKey, () => record[fieldKey], active),
  )
  active.delete(container)
  return { key, kind: 'object', summary: formatNestedPreview(value), children }
}

/**
 * Build the record tree for one row. The root is the row itself (an object
 * whose children are the columns in schema order); the component renders the
 * root's children under the panel header, so the root carries no key/summary.
 * Totality: every per-value failure degrades to a marked leaf, never a throw.
 */
export function buildRecordTree(row: RecordRowInput): RecordTreeNode {
  const active = new WeakSet<object>()
  const children = row.columns.map((column, index) =>
    classifyNode(column, row.cells[index], active),
  )
  return { key: '', kind: 'object', summary: '', children }
}

/**
 * Paths of every expandable (object/array) descendant, in render order, using
 * the component's path scheme (`key`, then `parent/key`). Powers the panel's
 * expand-all affordance; collapse-all is the empty set. Keys are joined
 * verbatim (SchemaPanel's path precedent) — a key containing `/` could
 * collide with nesting; expansion state stays coherent either way because
 * paths are only ever compared, never parsed.
 */
export function collectBranchPaths(root: RecordTreeNode): readonly string[] {
  const paths: string[] = []
  const walk = (node: RecordTreeNode, path: string): void => {
    for (const child of node.children) {
      const childPath = path === '' ? child.key : `${path}/${child.key}`
      if (child.kind === 'object' || child.kind === 'array') {
        paths.push(childPath)
        walk(child, childPath)
      }
    }
  }
  walk(root, '')
  return paths
}
