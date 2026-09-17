import { useCallback, useState } from 'react'
import type { ColumnSchema } from '@assay/grid'
import { nestedActionLabel, nestedActionVerb } from '../sql/nested-actions'
import type { NestedAction } from '../sql/nested-actions'
import type { DuckDbType } from './parseType'
import { formatDuckDbType, parseDuckDbType } from './parseType'

/**
 * Toggleable schema panel (m1-6): lists the opened table's columns with their
 * parsed DuckDB type trees — structs expand/collapse, lists show their element
 * type, primitives render as type badges. The panel receives only the engine's
 * schema (`name` + type string) — it has no way to render a file name (ADR
 * 0025). Accessibility follows the disclosure pattern (risk R8): native
 * `<button>` toggles with `aria-expanded`/`aria-controls`, nested lists, no
 * custom key handling needed.
 *
 * m3-5: nested nodes carry one-click actions — a STRUCT column root offers
 * **Flatten**, a LIST column root offers **Explode**, and every field reached
 * through structs only offers **Extract path** of its full dotted path. The
 * panel only emits the *intent* (`NestedAction`); composition happens in
 * `sql/nested-actions.ts` and execution in the m2-4 SQL pane. Actions are
 * native buttons (keyboard reachable) with full accessible names.
 */

interface SchemaPanelProps {
  readonly columns: readonly ColumnSchema[]
  /** Called with a node's action intent; the caller composes + runs the SQL. */
  readonly onAction: (action: NestedAction) => void
}

/**
 * The one-click action a node offers, if any (m3-5). Column roots act on the
 * whole column (STRUCT → flatten, LIST → explode); field nodes extract their
 * dotted path — but only when the chain from the column root traversed
 * structs alone: the tree has no list indices, so an extract *through* a list
 * element (e.g. the fields of `events`, a `STRUCT(…)[]` column) would compose
 * SQL the engine must reject, and those nodes offer no action instead.
 *
 * A column root is the single-segment node that is NOT a list element
 * continuation: a list root renders its element type under the SAME segment
 * list (`viaList` lifts it out — without that check, a list-of-struct root
 * would re-offer flatten on its own element).
 */
function nodeActionFor(
  node: DuckDbType,
  segments: readonly string[],
  viaList: boolean,
): NestedAction | null {
  if (segments.length === 1 && !viaList) {
    const column = segments[0] ?? ''
    if (node.kind === 'struct') return { kind: 'flatten', column }
    if (node.kind === 'list') return { kind: 'explode', column }
    return null
  }
  return viaList ? null : { kind: 'extract', path: segments }
}

/** The trailing one-click action button of a tree node (native button, named). */
function NodeActionButton({
  action,
  onAction,
}: {
  readonly action: NestedAction
  readonly onAction: (action: NestedAction) => void
}) {
  const label = nestedActionLabel(action)
  return (
    <button
      type="button"
      className="schema-node-action"
      data-testid="schema-node-action"
      data-schema-action={action.kind}
      aria-label={label}
      title={label}
      onClick={() => {
        onAction(action)
      }}
    >
      {nestedActionVerb(action)}
    </button>
  )
}

/** Expansion state: a set of node paths (e.g. `payload/geo`); everything is collapsed by default. */
type ExpandedPaths = ReadonlySet<string>

interface TypeNodeProps {
  /** Name shown next to the node (column or field name; empty for the list element continuation). */
  readonly name: string
  readonly node: DuckDbType
  /** Unique path from the column root, used as expansion key and DOM id seed. */
  readonly path: string
  /** Field-name segments from the column root to this node (m3-5 action inputs). */
  readonly segments: readonly string[]
  /** Whether the chain root→node passed through a list element (blocks extract). */
  readonly viaList: boolean
  readonly expanded: ExpandedPaths
  readonly onToggle: (path: string) => void
  readonly onAction: (action: NestedAction) => void
}

/** DOM-id-safe form of a node path (column names can contain any characters). */
function pathId(path: string): string {
  return `schema-fields-${path.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`
}

/** Type badge — also the leaf rendering for opaque/unparsed types. */
function TypeBadge({ node }: { node: Extract<DuckDbType, { kind: 'primitive' | 'unknown' }> }) {
  const label = node.kind === 'primitive' ? node.label : node.raw
  return (
    <span
      data-testid="schema-type-badge"
      className={node.kind === 'unknown' ? 'schema-badge schema-badge-unknown' : 'schema-badge'}
      title={label}
    >
      {label}
    </span>
  )
}

function TypeNode({
  name,
  node,
  path,
  segments,
  viaList,
  expanded,
  onToggle,
  onAction,
}: TypeNodeProps) {
  const action = nodeActionFor(node, segments, viaList)
  const actionButton =
    action === null ? null : <NodeActionButton action={action} onAction={onAction} />
  const nameSpan =
    name === '' ? null : (
      <span data-testid="schema-name" className="schema-name">
        {name}
      </span>
    )

  switch (node.kind) {
    case 'primitive':
    case 'unknown':
      return (
        <span className="schema-leaf" data-testid="schema-leaf">
          {nameSpan}
          <TypeBadge node={node} />
          {actionButton}
        </span>
      )
    case 'list': {
      // Lists render as their element type plus the dimension suffix
      // (VARCHAR[], STRUCT(x INT)[2]) — "lists show their element type".
      return (
        <span className="schema-leaf" data-testid="schema-list">
          {nameSpan}
          <TypeNode
            node={node.element}
            name=""
            path={path}
            segments={segments}
            viaList={true}
            expanded={expanded}
            onToggle={onToggle}
            onAction={onAction}
          />
          <span className="schema-dims">{node.dimensions === '' ? '[]' : node.dimensions}</span>
          {actionButton}
        </span>
      )
    }
    case 'map':
      // Rendered inline (not expandable) — maps are a rare DuckDB type and
      // their two halves stay readable as one formatted line.
      return (
        <span className="schema-leaf" data-testid="schema-map">
          {nameSpan}
          <span
            data-testid="schema-type-badge"
            className="schema-badge"
            title={formatDuckDbType(node)}
          >
            {formatDuckDbType(node)}
          </span>
          {actionButton}
        </span>
      )
    case 'struct':
    case 'union': {
      const open = expanded.has(path)
      const keyword = node.kind === 'struct' ? 'STRUCT' : 'UNION'
      const detailId = pathId(path)
      return (
        <span className="schema-struct" data-testid="schema-struct">
          <button
            type="button"
            className="schema-struct-toggle"
            data-testid="schema-struct-toggle"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => {
              onToggle(path)
            }}
          >
            <span className="schema-struct-marker" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            {nameSpan}
            <span
              data-testid="schema-type-badge"
              className="schema-badge"
              title={`${keyword} with ${String(node.fields.length)} field${node.fields.length === 1 ? '' : 's'}`}
            >
              {keyword}
            </span>
          </button>
          {actionButton}
          {open && (
            <ul id={detailId} className="schema-fields" data-testid="schema-struct-fields">
              {node.fields.map((field) => (
                <li
                  key={field.name}
                  className="schema-field"
                  data-testid="schema-field"
                  data-field-name={field.name}
                >
                  <TypeNode
                    node={field.type}
                    name={field.name}
                    path={`${path}/${field.name}`}
                    segments={[...segments, field.name]}
                    viaList={viaList}
                    expanded={expanded}
                    onToggle={onToggle}
                    onAction={onAction}
                  />
                </li>
              ))}
            </ul>
          )}
        </span>
      )
    }
  }
}

/**
 * The panel is open by default (the schema is the feature); the toggle hides
 * it without losing expansion state. Expansion state is a flat path set —
 * collapsing an ancestor keeps descendants' paths valid for re-expansion.
 */
export function SchemaPanel({ columns, onAction }: SchemaPanelProps) {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<ExpandedPaths>(() => new Set<string>())

  const toggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const columnWord = columns.length === 1 ? 'column' : 'columns'

  return (
    <section className="schema" data-testid="schema-section">
      <button
        type="button"
        className="schema-panel-toggle"
        data-testid="schema-toggle"
        aria-expanded={open}
        aria-controls="schema-panel"
        onClick={() => {
          setOpen((previous) => !previous)
        }}
      >
        <span className="schema-struct-marker" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        Schema
      </button>
      {open && (
        <div
          id="schema-panel"
          className="schema-panel"
          data-testid="schema-panel"
          role="region"
          aria-label="Schema"
        >
          <p className="schema-column-count" data-testid="schema-column-count">
            {columns.length} {columnWord}
          </p>
          <ul className="schema-columns" data-testid="schema-columns">
            {columns.map((column) => (
              <li
                key={column.name}
                className="schema-column"
                data-testid="schema-column"
                data-col-name={column.name}
              >
                <TypeNode
                  node={parseDuckDbType(column.type)}
                  name={column.name}
                  path={column.name}
                  segments={[column.name]}
                  viaList={false}
                  expanded={expanded}
                  onToggle={toggle}
                  onAction={onAction}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
