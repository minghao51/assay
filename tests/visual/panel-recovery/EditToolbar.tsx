// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { EditToolbar as RealEditToolbar } from '../../../apps/web/src/edit/EditToolbar'
import { usePanelCrash } from './injection'

export function EditToolbar(props: ComponentProps<typeof RealEditToolbar>) {
  if (usePanelCrash('editing', useSyncExternalStore))
    throw new Error('test-only panel crash: editing')
  return <RealEditToolbar {...props} />
}
