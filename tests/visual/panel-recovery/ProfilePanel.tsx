// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
// eslint-disable-next-line no-restricted-imports -- Authorized isolated browser harness must render the real App panel.
import { ProfilePanel as RealProfilePanel } from '../../../apps/web/src/profile/ProfilePanel'
import { usePanelCrash } from './injection'

export function ProfilePanel(props: ComponentProps<typeof RealProfilePanel>) {
  if (usePanelCrash('profile', useSyncExternalStore))
    throw new Error('test-only panel crash: profile')
  return <RealProfilePanel {...props} />
}
