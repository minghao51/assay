// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { PipelinePanel as RealPipelinePanel } from '../../../apps/web/src/pipeline/PipelinePanel'
import { usePanelCrash } from './injection'

export function PipelinePanel(props: ComponentProps<typeof RealPipelinePanel>) {
  if (usePanelCrash('pipeline', useSyncExternalStore))
    throw new Error('test-only panel crash: pipeline')
  return <RealPipelinePanel {...props} />
}
