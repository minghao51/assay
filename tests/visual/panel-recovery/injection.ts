// SPDX-License-Identifier: AGPL-3.0-or-later

/** Test-only crash control shared by the isolated panel-recovery harness. */
export const PANEL_CRASH_STORAGE_KEY = 'assay.ug7.panel-recovery.crash'
export const PANEL_CRASH_CHANGE_EVENT = 'assay:ug7-panel-crash-change'

type UseSyncExternalStore = <Snapshot>(
  subscribe: (onChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot?: () => Snapshot,
) => Snapshot

/**
 * A browser-only injection seam: test wrappers subscribe to this test-local
 * storage flag, then throw from the real App-owned panel entry. Production
 * App/ErrorBoundary modules do not import this module.
 */
export function usePanelCrash(panel: string, useStore: UseSyncExternalStore): boolean {
  return useStore<boolean>(
    (onChange) => {
      window.addEventListener(PANEL_CRASH_CHANGE_EVENT, onChange)
      return () => window.removeEventListener(PANEL_CRASH_CHANGE_EVENT, onChange)
    },
    () => window.localStorage.getItem(PANEL_CRASH_STORAGE_KEY) === panel,
    () => false,
  )
}

/** Set or clear one injected crash and notify mounted wrappers synchronously. */
export function setPanelCrash(panel: string | null): void {
  if (panel === null) window.localStorage.removeItem(PANEL_CRASH_STORAGE_KEY)
  else window.localStorage.setItem(PANEL_CRASH_STORAGE_KEY, panel)
  window.dispatchEvent(new Event(PANEL_CRASH_CHANGE_EVENT))
}
