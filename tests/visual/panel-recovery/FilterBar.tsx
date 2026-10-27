// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { FilterBar as RealFilterBar } from '../../../apps/web/src/grid/FilterBar'
import { usePanelCrash } from './injection'

export function FilterBar(props: ComponentProps<typeof RealFilterBar>) {
  if (usePanelCrash('filters', useSyncExternalStore))
    throw new Error('test-only panel crash: filters')
  return <RealFilterBar {...props} />
}
