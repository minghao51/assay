// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { HistoryPanel as RealHistoryPanel } from '../../../apps/web/src/edit/HistoryPanel'
import { usePanelCrash } from './injection'

export function HistoryPanel(props: ComponentProps<typeof RealHistoryPanel>) {
  if (usePanelCrash('history', useSyncExternalStore))
    throw new Error('test-only panel crash: history')
  return <RealHistoryPanel {...props} />
}
