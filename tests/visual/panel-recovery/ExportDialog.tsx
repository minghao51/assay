// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { ExportDialog as RealExportDialog } from '../../../apps/web/src/export/ExportDialog'
import { usePanelCrash } from './injection'

export function ExportDialog(props: ComponentProps<typeof RealExportDialog>) {
  if (usePanelCrash('export', useSyncExternalStore))
    throw new Error('test-only panel crash: export')
  return <RealExportDialog {...props} />
}
