// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path'
import { fileURLToPath } from 'node:url'
// eslint-disable-next-line no-restricted-imports -- Authorized harness reuses stock web build definitions without changing them.
import webConfig from '../../apps/web/vite.config.ts'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const webRoot = path.join(repositoryRoot, 'apps/web')
const webSource = path.join(webRoot, 'src')
const fixtureRoot = path.join(repositoryRoot, 'tests/visual/panel-recovery')
const outputDirectory =
  process.env['ASSAY_PANEL_RECOVERY_OUT_DIR'] ??
  '/tmp/assay-ux-ug7-followup-worker/panel-recovery-dist'
const previewPort = Number(process.env['ASSAY_E2E_PORT_WEB'] ?? 4473)

/**
 * Isolated real-App build aliases only the ten component entry points to
 * test-local wrappers. Every wrapper imports and renders the actual panel;
 * App, ErrorBoundary, engine, grid, and section state remain production code.
 */
const appPanelWrappers: Readonly<Record<string, string>> = {
  './schema/SchemaPanel': 'SchemaPanel.tsx',
  './edit/EditToolbar': 'EditToolbar.tsx',
  './export/ExportDialog': 'ExportDialog.tsx',
  './edit/HistoryPanel': 'HistoryPanel.tsx',
  './grid/FilterBar': 'FilterBar.tsx',
}
const lazyPanelWrappers: Readonly<Record<string, string>> = {
  '../validation/ValidationPanel': 'ValidationPanel.tsx',
  '../diff/DiffPanel': 'DiffPanel.tsx',
  '../sql/SqlPanel': 'SqlPanel.tsx',
  '../profile/ProfilePanel': 'ProfilePanel.tsx',
  '../pipeline/PipelinePanel': 'PipelinePanel.tsx',
}

const panelTestAliases = {
  name: 'assay-panel-recovery-test-aliases',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    const cleanImporter = importer?.split('?')[0]
    const wrappers =
      cleanImporter === path.join(webSource, 'App.tsx')
        ? appPanelWrappers
        : cleanImporter === path.join(webSource, 'lib/bottom-panels.ts')
          ? lazyPanelWrappers
          : undefined
    const wrapper = wrappers?.[source]
    return wrapper === undefined ? null : path.join(fixtureRoot, wrapper)
  },
}

export default {
  ...webConfig,
  root: webRoot,
  plugins: [...(webConfig.plugins ?? []), panelTestAliases],
  resolve: {
    ...webConfig.resolve,
    alias: [{ find: 'react', replacement: path.join(webRoot, 'node_modules/react') }],
    dedupe: ['react', 'react-dom'],
  },
  build: {
    ...webConfig.build,
    outDir: outputDirectory,
    emptyOutDir: true,
  },
  preview: {
    ...webConfig.preview,
    host: '127.0.0.1',
    port: previewPort,
    strictPort: true,
  },
}
