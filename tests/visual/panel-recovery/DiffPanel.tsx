// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { DiffPanel as RealDiffPanel } from '../../../apps/web/src/diff/DiffPanel'
import { usePanelCrash } from './injection'

export function DiffPanel(props: ComponentProps<typeof RealDiffPanel>) {
  if (usePanelCrash('compare', useSyncExternalStore))
    throw new Error('test-only panel crash: compare')
  return <RealDiffPanel {...props} />
}
