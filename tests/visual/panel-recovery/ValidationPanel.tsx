// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { ValidationPanel as RealValidationPanel } from '../../../apps/web/src/validation/ValidationPanel'
import { usePanelCrash } from './injection'

export function ValidationPanel(props: ComponentProps<typeof RealValidationPanel>) {
  if (usePanelCrash('validation', useSyncExternalStore))
    throw new Error('test-only panel crash: validation')
  return <RealValidationPanel {...props} />
}
