/**
 * Worker-side registry of tables opened from files (task M1-4).
 *
 * Every successful `engine/open` registers one entry: a generated table id
 * (`t1`, `t2`, … — structurally compatible with `@assay/engine`'s
 * `TableHandle { kind: 'table'; id: string }`, without importing it), the
 * generated DuckDB view name the id maps to, and the generated file-system
 * name the bytes were registered under. Requests arriving later (schema,
 * range, dispose) resolve their handle through this registry — an unknown or
 * already-released id is a clean error, never a crash.
 *
 * Lifecycle: entries are created only after the file registration *and* the
 * view creation succeeded; `engine/dispose` (or a failed open's rollback)
 * removes them. Ids come from a monotonic counter so a re-open after dispose
 * can never collide with a stale handle. All names in here are
 * engine-generated; user file names are not stored, logged, or echoed (ADR
 * 0025). This class is pure bookkeeping — DuckDB calls live in `worker.ts` —
 * so it is unit-testable under Node.
 */
import { detectFileFormat } from './format-view.js'

/** One table opened from a file and registered with DuckDB. */
export interface RegisteredTable {
  readonly tableId: string
  readonly viewName: string
  readonly registeredFileName: string
  readonly format: ReturnType<typeof detectFileFormat>
}

/** View names are the table id with a namespaced prefix: `assay_t1`. */
export function viewNameForTableId(tableId: string): string {
  return `assay_${tableId}`
}

export class TableRegistry {
  private nextSequence = 1
  private readonly tables = new Map<string, RegisteredTable>()

  /**
   * Reserve the next table id. Called *before* file/view creation so the
   * caller can name things; pair with `confirm()` on success or `remove()` on
   * failure so a failed open cannot leave a phantom entry.
   */
  reserve(format: NonNullable<RegisteredTable['format']>): RegisteredTable {
    const tableId = `t${this.nextSequence++}`
    const entry: RegisteredTable = {
      tableId,
      viewName: viewNameForTableId(tableId),
      // The file is registered under the raw table id: engine-generated,
      // unique per open, free of user-controlled characters.
      registeredFileName: tableId,
      format,
    }
    this.tables.set(tableId, entry)
    return entry
  }

  /** Look up a handle sent from the main thread. */
  get(tableId: string): RegisteredTable | null {
    return this.tables.get(tableId) ?? null
  }

  /** Drop one entry (failed open rollback or explicit close). */
  remove(tableId: string): void {
    this.tables.delete(tableId)
  }

  /** All entries, oldest first (dispose iterates in creation order). */
  list(): readonly RegisteredTable[] {
    return [...this.tables.values()]
  }

  /** Drop every entry (used by `engine/dispose`). Returns what was held. */
  clear(): readonly RegisteredTable[] {
    const entries = this.list()
    this.tables.clear()
    return entries
  }

  get size(): number {
    return this.tables.size
  }
}
