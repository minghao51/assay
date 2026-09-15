import { useCallback, useState } from 'react'
import type { ColumnSchema } from '@assay/grid'
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
 */

interface SchemaPanelProps {
  readonly columns: readonly ColumnSchema[]
}

/** Expansion state: a set of node paths (e.g. `payload/geo`); everything is collapsed by default. */
type ExpandedPaths = ReadonlySet<string>

interface TypeNodeProps {
  /** Name shown next to the node (column or field name; empty for the list element continuation). */
  readonly name: string
  readonly node: DuckDbType
  /** Unique path from the column root, used as expansion key and DOM id seed. */
  readonly path: string
  readonly expanded: ExpandedPaths
  readonly onToggle: (path: string) => void
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

function TypeNode({ name, node, path, expanded, onToggle }: TypeNodeProps) {
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
            expanded={expanded}
            onToggle={onToggle}
          />
          <span className="schema-dims">{node.dimensions === '' ? '[]' : node.dimensions}</span>
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
                    expanded={expanded}
                    onToggle={onToggle}
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
export function SchemaPanel({ columns }: SchemaPanelProps) {
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
                  expanded={expanded}
                  onToggle={toggle}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
