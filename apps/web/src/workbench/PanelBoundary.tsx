// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from 'react'
import { ErrorBoundary } from '../ErrorBoundary'
import type { WorkbenchSectionId } from './tasks'

/**
 * ug-7/R-06: one panel-scope boundary around a tool section's body. The
 * boundary itself owns only the failed/retry state; App owns the section's
 * visibility (managed open set or the inner-disclosure override) and the
 * focus move to the section's existing nav link on close.
 *
 * D02a: lifted out of `App.tsx` verbatim as a thin, stateless adapter — no
 * hook, no engine/session lifecycle, no visibility or focus ownership moved.
 */
export function PanelBoundary({
  id,
  onClose,
  children,
}: {
  readonly id: WorkbenchSectionId
  readonly onClose: (id: WorkbenchSectionId) => void
  readonly children: ReactNode
}) {
  return (
    <ErrorBoundary
      scope="panel"
      sectionId={id}
      onClose={() => {
        onClose(id)
      }}
    >
      {children}
    </ErrorBoundary>
  )
}
