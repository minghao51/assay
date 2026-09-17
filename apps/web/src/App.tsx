import { useCallback, useState, useSyncExternalStore } from 'react'
import type { EngineTableHandle } from '@assay/engine-duckdb'
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
import { SchemaPanel } from './schema/SchemaPanel'
import { SqlPanel } from './sql/SqlPanel'

/**
 * App phases. `ready` holds the composed grid: adapter (engine client) →
 * provider (`GridDataProvider`) → headless model → virtualized DOM renderer
 * (docs/architecture/02-architecture.md §8). Only the table id, row count,
 * and column count are shown — never the picked file's name (ADR 0025).
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

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /**
   * m3-3 record inspector open gesture. App holds it so a row open survives
   * the grid's re-renders; `seq` makes every gesture distinct so re-opening
   * the SAME row re-fires the inspector's open effect. Cleared when a new
   * file is opened — a request must never leak across tables.
   */
  const [recordRequest, setRecordRequest] = useState<RecordRequest | null>(null)

  const openDataFile = useCallback(async () => {
    setPhase({ kind: 'opening' })
    setRecordRequest(null)
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
          <SchemaPanel columns={phase.model.schema ?? []} />
          <FilterBar model={phase.model} />
          <DataGrid
            model={phase.model}
            onOpenRecord={(rowIndex) => {
              setRecordRequest((previous) => ({ rowIndex, seq: (previous?.seq ?? 0) + 1 }))
            }}
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
          <SqlPanel tableId={phase.tableId} />
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
