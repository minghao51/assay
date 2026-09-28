// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { GridViewportModel } from '@assay/grid'
import type { ColumnSchema, FilterSpec, SortSpec } from '@assay/grid'

/** Stable empty-schema constant for the pre-open phases (useMemo stability). */
export const NO_COLUMNS: readonly { readonly name: string; readonly type: string }[] = []

/** Stable empty-filter list for the pre-open phases (snapshot stability). */
const NO_FILTERS: readonly FilterSpec[] = []

/**
 * The model slices `App` reads during render. Row data is deliberately not
 * included: the panels that consume rows (`DataGrid`, `LiveTableInfo`,
 * `FilterBar`) keep their own full-model subscriptions and update on every
 * fetch notify. `App` itself re-renders only when the schema (rename/cast)
 * or query state (shown in the export dialog) changes — q-1.
 */
interface ModelSlice {
  readonly schema: readonly ColumnSchema[] | null
  readonly sort: SortSpec | null
  readonly filters: readonly FilterSpec[]
}

/**
 * Stable no-op model subscription for the pre-open phases. `App` must call
 * `useSyncExternalStore` unconditionally (hook rules); this stands in until a
 * table is ready. A module constant so React never re-subscribes between
 * renders.
 */
const NO_SUBSCRIPTION = (): (() => void) => () => {}

/**
 * q-1: subscribe `App` to only the model slices it renders from, returning a
 * cached snapshot whose identity changes only when one of those slice
 * references does. Before this, `App` used the model's monotonically
 * increasing `getVersion`, so every viewport fetch notification re-rendered
 * the entire panel tree. The snapshot is cached (a fresh object per call
 * would make `useSyncExternalStore` loop) and rebuilt whenever the active
 * model changes (a new table open).
 *
 * f-1: lifted out of `App.tsx`; unchanged.
 */
export function useModelSlice(model: GridViewportModel | null): ModelSlice {
  const cache = useRef<{ model: GridViewportModel | null; slice: ModelSlice } | null>(null)
  const getSnapshot = useCallback((): ModelSlice => {
    const slice: ModelSlice = {
      schema: model?.schema ?? null,
      sort: model?.sort ?? null,
      filters: model?.filters ?? NO_FILTERS,
    }
    const previous = cache.current
    if (
      previous !== null &&
      previous.model === model &&
      previous.slice.schema === slice.schema &&
      previous.slice.sort === slice.sort &&
      previous.slice.filters === slice.filters
    ) {
      return previous.slice
    }
    cache.current = { model, slice }
    return slice
  }, [model])
  return useSyncExternalStore(model?.subscribe ?? NO_SUBSCRIPTION, getSnapshot)
}
