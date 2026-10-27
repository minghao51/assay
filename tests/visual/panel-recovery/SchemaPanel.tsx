// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { SchemaPanel as RealSchemaPanel } from '../../../apps/web/src/schema/SchemaPanel'
import { usePanelCrash } from './injection'

export function SchemaPanel(props: ComponentProps<typeof RealSchemaPanel>) {
  if (usePanelCrash('schema', useSyncExternalStore))
    throw new Error('test-only panel crash: schema')
  return <RealSchemaPanel {...props} />
}
