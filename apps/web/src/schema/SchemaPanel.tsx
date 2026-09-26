// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from 'react'
import type { ColumnSchema } from '@assay/grid'
import { nestedActionLabel, nestedActionVerb } from '../sql/nested-actions'
import type { NestedAction } from '../sql/nested-actions'
import {
  CAST_CUSTOM_OPTION,
  COMMON_CAST_TARGETS,
  validateCastTarget,
  validateRenameTarget,
} from '../edit/column-ops'
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
 *
 * m4-4: each column root also carries **Rename** / **Cast** controls
 * (`ColumnControls`). Rename refuses empty names inline and leaves collisions
 * to the domain (a typed conflict the app surfaces); cast validates every
 * target spelling with the engine's exported validator before composing an op
 * (see `edit/column-ops.ts`). The panel still emits intents only — the app
 * owns the ops.
 */

interface SchemaPanelProps {
  readonly columns: readonly ColumnSchema[]
  /** Called with a node's action intent; the caller composes + runs the SQL. */
  readonly onAction: (action: NestedAction) => void
  /**
   * m4-4 column rename affordance. Omitted = no controls (the panel stays a
   * pure schema viewer, e.g. in the m4-0 component pin). The callback emits
   * the *intent*; the app appends the domain op and surfaces the typed
   * outcome/conflict.
   */
  readonly onRenameColumn?: (from: string, to: string) => void
  /** m4-4 column cast affordance; `targetType` is pre-validated by the caller UI. */
  readonly onCastColumn?: (column: string, targetType: string) => void
  /**
   * Column whose cast pre-check is in flight (m4-4 fix round 2). Its cast
   * control renders a pending state and is disabled, so a slow engine check
   * is visible and a double-click cannot queue a second intent. `null`/
   * omitted means no check is running.
   */
  readonly castPendingColumn?: string | null
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

/**
 * Per-column rename/cast controls (m4-4). Self-contained editor state per
 * column (rename draft / cast target / inline error); the component emits
 * only validated *intents*.
 *
 * Failure classes, surfaced honestly and distinctly:
 * - **Rename**: empty is refused inline (a real reason, no op); a collision
 *   is *not* pre-checked — it is a domain `rename-collision` conflict the app
 *   surfaces through the toolbar alert, and the effective schema does not
 *   change.
 * - **Cast**: every spelling is run through the engine's exported
 *   `validateEngineTypeExpression` *before* an op is composed. An invalid
 *   spelling is refused inline with no op appended. A well-shaped spelling
 *   the engine does not know still reaches the engine and fails at schema
 *   materialization; the app's commit rollback path surfaces that and rolls
 *   back (some `column-cast` spellings are structurally legal but not in the
 *   engine's catalog).
 *
 * Text-only; no dataset values are read here.
 */
function ColumnControls({
  name,
  type,
  castPending,
  onRename,
  onCast,
}: {
  readonly name: string
  readonly type: string
  readonly castPending: boolean
  readonly onRename: (from: string, to: string) => void
  readonly onCast: (column: string, targetType: string) => void
}) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'cast'>('idle')
  const [renameDraft, setRenameDraft] = useState(name)
  const [castChoice, setCastChoice] = useState('')
  const [customTarget, setCustomTarget] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reset = (): void => {
    setMode('idle')
    setRenameDraft(name)
    setCastChoice('')
    setCustomTarget('')
    setError(null)
  }

  const submitRename = (): void => {
    const result = validateRenameTarget(renameDraft)
    if (!result.ok) {
      setError(result.reason)
      return
    }
    onRename(name, result.name)
    reset()
  }

  const submitCast = (): void => {
    const target = castChoice === CAST_CUSTOM_OPTION ? customTarget : castChoice
    const result = validateCastTarget(target)
    if (!result.ok) {
      setError(result.reason)
      return
    }
    onCast(name, result.targetType)
    reset()
  }

  return (
    <span className="schema-column-controls" data-testid="schema-column-controls">
      {mode === 'idle' && (
        <>
          <button
            type="button"
            className="schema-column-op"
            data-testid="column-rename-open"
            data-col-name={name}
            aria-label={`Rename column ${name}`}
            title={`Rename column ${name}`}
            disabled={castPending}
            onClick={() => {
              setMode('rename')
              setError(null)
            }}
          >
            Rename
          </button>{' '}
          <button
            type="button"
            className="schema-column-op"
            data-testid="column-cast-open"
            data-col-name={name}
            aria-label={`Cast column ${name}`}
            title={`Cast column ${name} (currently ${type})`}
            disabled={castPending}
            onClick={() => {
              setMode('cast')
              setError(null)
            }}
          >
            Cast
          </button>{' '}
          {castPending && (
            <span
              className="schema-column-pending"
              data-testid="column-cast-pending"
              role="status"
              data-col-name={name}
            >
              Checking…
            </span>
          )}
        </>
      )}
      {mode === 'rename' && (
        <span className="schema-column-editor">
          <input
            className="schema-column-input"
            data-testid="column-rename-input"
            data-col-name={name}
            aria-label={`New name for column ${name}`}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={renameDraft}
            onChange={(event) => {
              setRenameDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                reset()
              }
            }}
          />{' '}
          <button
            type="button"
            className="schema-column-confirm"
            data-testid="column-rename-commit"
            onClick={submitRename}
          >
            Rename
          </button>{' '}
          <button
            type="button"
            className="schema-column-cancel"
            data-testid="column-op-cancel"
            onClick={reset}
          >
            Cancel
          </button>
        </span>
      )}
      {mode === 'cast' && (
        <span className="schema-column-editor">
          <select
            className="schema-column-select"
            data-testid="column-cast-select"
            data-col-name={name}
            aria-label={`Target type for column ${name}`}
            autoFocus
            value={castChoice}
            onChange={(event) => {
              setCastChoice(event.target.value)
            }}
          >
            <option value="" disabled>
              Choose a type…
            </option>
            {COMMON_CAST_TARGETS.map((target) => (
              <option key={target} value={target}>
                {target}
              </option>
            ))}
            <option value={CAST_CUSTOM_OPTION}>Custom…</option>
          </select>{' '}
          {castChoice === CAST_CUSTOM_OPTION && (
            <input
              className="schema-column-input"
              data-testid="column-cast-custom"
              data-col-name={name}
              aria-label={`Custom target type for column ${name}`}
              spellCheck={false}
              autoComplete="off"
              placeholder="e.g. DECIMAL(10,2)"
              value={customTarget}
              onChange={(event) => {
                setCustomTarget(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitCast()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  reset()
                }
              }}
            />
          )}{' '}
          <button
            type="button"
            className="schema-column-confirm"
            data-testid="column-cast-commit"
            onClick={submitCast}
          >
            Cast
          </button>{' '}
          <button
            type="button"
            className="schema-column-cancel"
            data-testid="column-op-cancel"
            onClick={reset}
          >
            Cancel
          </button>
        </span>
      )}
      {error !== null && (
        <span className="schema-column-error" role="alert" data-testid="column-op-error">
          {error}
        </span>
      )}
    </span>
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
export function SchemaPanel({
  columns,
  onAction,
  onRenameColumn,
  onCastColumn,
  castPendingColumn = null,
}: SchemaPanelProps) {
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
                <div className="schema-column-row">
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
                  {onRenameColumn !== undefined && onCastColumn !== undefined && (
                    <ColumnControls
                      name={column.name}
                      type={column.type}
                      castPending={castPendingColumn === column.name}
                      onRename={onRenameColumn}
                      onCast={onCastColumn}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
