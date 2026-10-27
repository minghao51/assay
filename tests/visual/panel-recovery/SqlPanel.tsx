// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { SqlPanel as RealSqlPanel } from '../../../apps/web/src/sql/SqlPanel'
import { usePanelCrash } from './injection'

export function SqlPanel(props: ComponentProps<typeof RealSqlPanel>) {
  if (usePanelCrash('sql', useSyncExternalStore)) throw new Error('test-only panel crash: sql')
  return <RealSqlPanel {...props} />
}
