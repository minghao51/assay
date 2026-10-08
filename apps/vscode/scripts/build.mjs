// SPDX-License-Identifier: AGPL-3.0-or-later
/* global process, console */

/**
 * Spike build (ptv-1). esbuild-bundles the four spike entry points and copies
 * the two DuckDB-WASM bundle pairs into `dist/webview/` so the extension host
 * can hand their `vscode-webview-resource:` URIs to the webview. Emits
 * `dist/spike-artifacts.json` with exact byte sizes for the Q6 packaging
 * evidence (the runner merges it into the report).
 *
 * Deliberately spike-local: no root config, no tsconfig changes, no build
 * integration into `pnpm build` (queue row ptv-1: scaffold + harness only).
 */
import { build } from 'esbuild'
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const dist = path.join(appRoot, 'dist')
const webviewDist = path.join(dist, 'webview')

const require = createRequire(import.meta.url)
const duckdbDist = path.dirname(require.resolve('@duckdb/duckdb-wasm'))

const WASM_ASSETS = [
  'duckdb-browser-mvp.worker.js',
  'duckdb-mvp.wasm',
  'duckdb-browser-eh.worker.js',
  'duckdb-eh.wasm',
]

/** Shared browser build options for the webview main thread and its worker. */
const browserBuild = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'warning',
}

async function main() {
  await rm(dist, { recursive: true, force: true })
  await mkdir(webviewDist, { recursive: true })

  await build({
    entryPoints: [path.join(appRoot, 'src/extension.ts')],
    outfile: path.join(dist, 'extension.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    sourcemap: false,
    logLevel: 'warning',
  })

  await build({
    ...browserBuild,
    entryPoints: [path.join(appRoot, 'webview/main.ts')],
    outfile: path.join(webviewDist, 'main.js'),
  })

  await build({
    ...browserBuild,
    entryPoints: [path.join(appRoot, 'webview/worker.ts')],
    outfile: path.join(webviewDist, 'worker.js'),
  })

  await build({
    entryPoints: [path.join(appRoot, 'test/spike-runner.ts')],
    outfile: path.join(dist, 'spike-test.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    sourcemap: false,
    logLevel: 'warning',
  })

  for (const asset of WASM_ASSETS) {
    await cp(path.join(duckdbDist, asset), path.join(webviewDist, asset))
  }
  await writeFile(path.join(webviewDist, 'probe.json'), '{"spike":true}\n')

  const files = [
    path.join(dist, 'extension.cjs'),
    path.join(dist, 'spike-test.cjs'),
    ...(await readdir(webviewDist)).map((name) => path.join(webviewDist, name)),
  ]
  const artifacts = []
  for (const file of files.sort()) {
    artifacts.push({
      path: path.relative(dist, file).split(path.sep).join('/'),
      bytes: (await stat(file)).size,
    })
  }
  await writeFile(
    path.join(dist, 'spike-artifacts.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), files: artifacts }, null, 2) + '\n',
  )

  console.log(`spike build: ${artifacts.length} artifacts`)
  for (const artifact of artifacts) {
    console.log(`  ${String(artifact.bytes).padStart(10)}  ${artifact.path}`)
  }
}

await main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
