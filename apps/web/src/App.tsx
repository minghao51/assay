import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { viewNameForTableId } from '@assay/engine-duckdb'
import { GridViewportModel } from '@assay/grid'
import { pickDataFile } from '@assay/data-sources/browser'
import { DataGrid } from './grid/DataGrid'
import { DuckDbGridProvider } from './grid/provider'
import { FilterBar } from './grid/FilterBar'
import { APP_NAME, NEXT_MILESTONE, SCAFFOLD_STATUS, TAGLINE } from './lib/app'
import { engineClient } from './lib/engine'
import { ProfilePanel } from './profile/ProfilePanel'
import { RecordInspector } from './record/RecordInspector'
import type { RecordRequest } from './record/RecordInspector'
import { parseDuckDbType } from './schema/parseType'
import { SchemaPanel } from './schema/SchemaPanel'
import { composeNestedAction } from './sql/nested-actions'
import type { NestedAction } from './sql/nested-actions'
import { SqlPanel } from './sql/SqlPanel'
import type { SqlRunRequest } from './sql/SqlPanel'

/**
 * App phases. `ready` holds the composed grid: adapter (engine client) →
 * provider (`GridDataProvider`) → headless model → virtualized DOM renderer
 * (docs/architecture/02-architecture.md §8). Only the table id, row count,
 * and column count are shown — never the picked file's name (ADR 0025).
 *
 * m3-5: the ready phase also wires the one-click nested actions — schema
 * tree and grid headers emit intents, the app composes them through m3-4's
 * pure composer and dispatches the SQL to the m2-4 editor/result pane. No
 * SQL, results, or file names are ever logged (ADR 0025).
 */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready'
      readonly model: GridViewportModel
      readonly tableId: string
      readonly handle: EngineTableHandle
    }

/**
 * Live summary line for the opened table (m2-3 row-count truth): the total
 * is read from the model — which re-reads it from the provider after every
 * accepted filter change — so the count always reflects the active filters.
 */
function LiveTableInfo({ model, tableId }: { model: GridViewportModel; tableId: string }) {
  useSyncExternalStore(model.subscribe, model.getVersion)
  return (
    <p data-testid="table-info">
      table <code data-testid="open-table-id">{tableId}</code> ·{' '}
      <span data-testid="grid-total-rows">{model.totalRows ?? 0}</span> rows ·{' '}
      <span data-testid="grid-column-count">{model.schema?.length ?? 0}</span> columns
    </p>
  )
}

/** Stable empty-schema constant for the pre-open phases (useMemo stability). */
const NO_COLUMNS: readonly { readonly name: string; readonly type: string }[] = []

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /**
   * m3-3 record inspector open gesture. App holds it so a row open survives
   * the grid's re-renders; `seq` makes every gesture distinct so re-opening
   * the SAME row re-fires the inspector's open effect. Cleared when a new
   * file is opened — a request must never leak across tables.
   */
  const [recordRequest, setRecordRequest] = useState<RecordRequest | null>(null)

  /**
   * m3-5 nested-action dispatch: both click surfaces (schema tree, grid
   * headers) emit a `NestedAction`; the app composes it through m3-4's pure
   * composer against the parsed schema and the SQL-facing view name, then
   * hands the SQL to the m2-4 pane via `sqlRequest` (the pane shows the
   * statement and runs it — one click, honest visibility). Composition
   * failures surface as a readable alert here — never a silent no-op.
   */
  const [sqlRequest, setSqlRequest] = useState<SqlRunRequest | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const schemaColumns = phase.kind === 'ready' ? (phase.model.schema ?? []) : NO_COLUMNS
  const nestedSpecs = useMemo(
    () =>
      schemaColumns.map((column) => ({ name: column.name, type: parseDuckDbType(column.type) })),
    [schemaColumns],
  )
  const runNestedAction = useCallback(
    (action: NestedAction): void => {
      if (phase.kind !== 'ready') return
      const composed = composeNestedAction(viewNameForTableId(phase.tableId), nestedSpecs, action)
      if (!composed.ok) {
        setActionError(composed.reason)
        return
      }
      setActionError(null)
      requestSeq.current += 1
      setSqlRequest({ sql: composed.sql, seq: requestSeq.current })
    },
    [phase, nestedSpecs],
  )

  const openDataFile = useCallback(async () => {
    setPhase({ kind: 'opening' })
    setRecordRequest(null)
    // m3-5: a new table invalidates the previous table's SQL dispatch state.
    setSqlRequest(null)
    setActionError(null)
    try {
      const picked = await pickDataFile()
      if (picked === null) {
        // User dismissed the picker — back to idle, nothing opened.
        setPhase({ kind: 'idle' })
        return
      }
      // BrowserFileSource exposes getFile() but not its input's name, and the
      // EngineFileSource seam needs the name for extension detection only.
      // Resolving the File here is a cheap reference (no dataset bytes read,
      // ADR 0001); the name is transported per protocol but never rendered or
      // logged (ADR 0025).
      const file = await picked.source.getFile()
      const handle = await engineClient.open({
        name: file.name,
        getFile: () => Promise.resolve(file),
      })
      const provider = new DuckDbGridProvider(engineClient, handle)
      const model = new GridViewportModel(provider)
      await model.load()
      setPhase({ kind: 'ready', model, tableId: handle.id, handle })
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>{TAGLINE}</p>

      <section data-testid="open-flow">
        <button
          type="button"
          data-testid="open-button"
          onClick={() => {
            void openDataFile()
          }}
          disabled={phase.kind === 'opening'}
        >
          Open a data file…
        </button>{' '}
        <span data-testid="open-status">{phase.kind}</span>
        {phase.kind === 'error' && (
          <p data-testid="open-error" role="alert">
            {phase.message}
          </p>
        )}
        {phase.kind === 'ready' && <LiveTableInfo model={phase.model} tableId={phase.tableId} />}
      </section>

      {phase.kind === 'ready' ? (
        <>
          {actionError !== null && (
            <p className="nested-action-error" role="alert" data-testid="nested-action-error">
              {actionError}
            </p>
          )}
          <SchemaPanel columns={schemaColumns} onAction={runNestedAction} />
          <FilterBar model={phase.model} />
          <DataGrid
            model={phase.model}
            onOpenRecord={(rowIndex) => {
              setRecordRequest((previous) => ({ rowIndex, seq: (previous?.seq ?? 0) + 1 }))
            }}
            onNestedAction={runNestedAction}
          />
          {/**
           * Placement (m3-3): directly under the grid it inspects. The app
           * composes single-column, full-width disclosure sections (schema →
           * filters → grid → SQL → profile); a side panel would introduce a
           * new layout concept the app does not have, and the row-level
           * inspector belongs next to the row-level surface anyway — closer
           * than the table-level SQL/profile tool panels below it.
           */}
          <RecordInspector
            model={phase.model}
            request={recordRequest}
            onClosed={() => {
              setRecordRequest(null)
            }}
          />
          <SqlPanel tableId={phase.tableId} runRequest={sqlRequest} />
          <ProfilePanel handle={phase.handle} />
        </>
      ) : (
        <>
          <p>{SCAFFOLD_STATUS}</p>
          <p>
            Next: <strong>{NEXT_MILESTONE}</strong>
          </p>
          <p>
            Documentation lives in <code>docs/</code> — start with{' '}
            <code>docs/process/handoff.md</code>.
          </p>
        </>
      )}
    </main>
  )
}
