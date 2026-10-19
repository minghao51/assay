// SPDX-License-Identifier: AGPL-3.0-or-later
/* global process, console */

/**
 * Spike build (ptv-1, assets vendored by ptv1-2). esbuild-bundles the four
 * spike entry points and copies the DuckDB-WASM bundle assets into
 * `dist/webview/` so the extension host can hand their
 * `vscode-webview-resource:` URIs to the webview. Emits
 * `dist/spike-artifacts.json` with exact byte sizes for the Q6 packaging
 * evidence and `dist/vendored-assets.json` with the version-pin evidence
 * (the runner merges both into the report).
 *
 * ptv1-2 (vendored engine assets, local-first): the production `mvp` bundle
 * (`duckdb-mvp.wasm` + `duckdb-browser-mvp.worker.js`) and the Parquet/JSON
 * extensions are COMMITTED under `assets/duckdb/` (with a `.pinned` suffix —
 * formatters skip unknown extensions, so `pnpm format` can never rewrite the
 * pinned bytes) and copied from there, NOT from node_modules — with two hard
 * verifications before every build:
 *   1. the committed bytes match the recorded SHA-256 checksums (pin drift
 *      fails the build), and
 *   2. the committed wasm/worker are byte-identical to the copy in the
 *      lockfile-pinned `@duckdb/duckdb-wasm` package (the version pin is the
 *      lockfile's; a bump without re-vendoring fails the build).
 * The `eh` pair is harness-only (boot probe, never opens a dataset) and
 * continues to come from the same pinned package. See
 * `assets/duckdb/VENDORED_ASSETS.md` for the full pin, the one-time vendor
 * fetch URL, and the DuckDB-WASM MIT license note (AGPL-compatible per
 * AGENTS.md).
 *
 * Invoked by the package's standard `build` script (and retained
 * `build:spike` compatibility alias), so root Turbo build verifies production
 * extension/webview outputs and vendored asset pins. Since ptv1-3 this build also emits the
 * PRODUCTION dataset surface bundles: the dataset webview entry
 * (`dist/webview/dataset.js`) and the ptv1-3 e2e test entry
 * (`dist/e2e-test.cjs`), alongside the spike artifacts (ptv1-5's harness
 * seed stays intact).
 */
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')
const dist = path.join(appRoot, 'dist')
const webviewDist = path.join(dist, 'webview')

const require = createRequire(import.meta.url)
const duckdbDist = path.dirname(require.resolve('@duckdb/duckdb-wasm'))

/**
 * The vendored-asset pin (ptv1-2) — the machine-readable half of
 * `assets/duckdb/VENDORED_ASSETS.md`. sha256 values are of the COMMITTED
 * files in `assets/duckdb/`; a mismatch fails the build.
 */
const VENDORED_ASSETS = {
  /** @duckdb/duckdb-wasm version pinned in pnpm-lock.yaml — do NOT bump here alone. */
  duckdbWasmVersion: '1.32.0',
  /** The DuckDB runtime embedded in that bundle (asserted at runtime by run:spike). */
  duckdbVersion: 'v1.4.3',
  extensionPlatform: 'wasm_mvp',
  files: [
    {
      name: 'duckdb-mvp.wasm',
      committedName: 'duckdb-mvp.wasm.pinned',
      sha256: '45d72a81fba8e57693d890da837c7041310e385e75619a8559839b15388dfe97',
      // Present in the lockfile-pinned npm package: pin-equality is verified.
      fromNpmPackage: true,
    },
    {
      name: 'duckdb-browser-mvp.worker.js',
      committedName: 'duckdb-browser-mvp.worker.js.pinned',
      sha256: 'b0387027f174e2b60c2d5cfa31cecca9b89d8a9762346b6449a784cd1c4dde3c',
      fromNpmPackage: true,
    },
    {
      name: 'parquet.duckdb_extension.wasm',
      committedName: 'parquet.duckdb_extension.wasm.pinned',
      sha256: '0785c6c95d003eff4faa7b3b4b660f02c9c92f6d68d135ddf330d42e3a650600',
      // Fetched ONCE at vendor time (2026-10-12, ptv1-2) from:
      //   https://extensions.duckdb.org/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm
      // Runtime NEVER fetches: the harness blocks extensions.duckdb.org
      // (CSP + in-worker interceptor; see VENDORED_ASSETS.md).
      fromNpmPackage: false,
    },
    {
      name: 'json.duckdb_extension.wasm',
      committedName: 'json.duckdb_extension.wasm.pinned',
      sha256: '5771b6d57335eca8e2ba4fdaacb491a53b49577bd7f1b0c39e2cd7a39b4e9313',
      // Fetched ONCE at vendor time from:
      //   https://extensions.duckdb.org/v1.4.3/wasm_mvp/json.duckdb_extension.wasm
      // Runtime NEVER fetches: the harness blocks extensions.duckdb.org.
      fromNpmPackage: false,
    },
  ],
  license:
    'DuckDB-WASM is MIT-licensed — AGPL-compatible per AGENTS.md (repo is AGPL-3.0-or-later, ADR 0036)',
}

/** The eh pair stays a harness-only copy from the pinned package. */
const WASM_ASSETS = ['duckdb-browser-eh.worker.js', 'duckdb-eh.wasm']

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

  // ptv1-3: the production dataset viewer webview (shared engine-boot module).
  await build({
    ...browserBuild,
    entryPoints: [path.join(appRoot, 'webview/dataset.ts')],
    outfile: path.join(webviewDist, 'dataset.js'),
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

  await build({
    entryPoints: [path.join(appRoot, 'src/pure/cli-agreement.ts')],
    outfile: path.join(dist, 'cli-agreement.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    logLevel: 'warning',
  })

  // ptv1-3: the e2e test entry (real VS Code via @vscode/test-electron,
  // launched by scripts/run-e2e.mjs).
  await build({
    entryPoints: [path.join(appRoot, 'test/e2e/dataset-runner.ts')],
    outfile: path.join(dist, 'e2e-test.cjs'),
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

  // ptv1-2: verify the vendored pin, then copy the committed assets. Any
  // drift (edited binary, partial vendoring, package bump) fails the build.
  const vendoredDir = path.join(appRoot, 'assets', 'duckdb')
  const vendoredEvidence = []
  for (const entry of VENDORED_ASSETS.files) {
    const committed = await readFile(path.join(vendoredDir, entry.committedName))
    const observed = createHash('sha256').update(committed).digest('hex')
    if (observed !== entry.sha256) {
      throw new Error(
        `vendored asset drift: assets/duckdb/${entry.committedName} sha256 ${observed} != pinned ${entry.sha256} ` +
          '(see assets/duckdb/VENDORED_ASSETS.md — re-vendor deliberately, never silently)',
      )
    }
    if (entry.fromNpmPackage) {
      const pinned = await readFile(path.join(duckdbDist, entry.name))
      if (!pinned.equals(committed)) {
        throw new Error(
          `vendored asset is not byte-identical to the lockfile-pinned @duckdb/duckdb-wasm copy of ${entry.name} — ` +
            'a version bump must go through a deliberate re-vendor (VENDORED_ASSETS.md), not a silent copy',
        )
      }
    }
    await cp(path.join(vendoredDir, entry.committedName), path.join(webviewDist, entry.name))
    vendoredEvidence.push({ name: entry.name, bytes: committed.byteLength, sha256: observed })
  }
  await writeFile(
    path.join(dist, 'vendored-assets.json'),
    JSON.stringify({ ...VENDORED_ASSETS, files: vendoredEvidence }, null, 2) + '\n',
  )
  await writeFile(path.join(webviewDist, 'probe.json'), '{"spike":true}\n')

  const files = [
    path.join(dist, 'extension.cjs'),
    path.join(dist, 'spike-test.cjs'),
    path.join(dist, 'e2e-test.cjs'),
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
