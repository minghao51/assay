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
 * ptv1-2 (vendored engine assets, local-first), R1-B (desktop ships `eh`
 * only, ADR 0048 decision 3): the production `eh` bundle (`duckdb-eh.wasm` +
 * `duckdb-browser-eh.worker.js`) and the `wasm_eh` Parquet/JSON extensions are
 * COMMITTED under `assets/duckdb/` (with a `.pinned` suffix — formatters skip
 * unknown extensions, so `pnpm format` can never rewrite the pinned bytes) and
 * copied from there, NOT from node_modules — with two hard verifications
 * before every build:
 *   1. the committed bytes match the recorded SHA-256 checksums (pin drift
 *      fails the build), and
 *   2. the committed wasm/worker are byte-identical to the copy in the
 *      lockfile-pinned `@duckdb/duckdb-wasm` package (the version pin is the
 *      lockfile's; a bump without re-vendoring fails the build).
 * The `mvp` pair is no longer served by the desktop package: its Electron
 * Chromium is fixed and validates wasm exception handling, so the `eh` pair is
 * the only bundle shipped here and the extensions follow its `wasm_eh`
 * platform (an `eh` engine requests `/v1.4.3/wasm_eh/…` autoload paths). See
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
  extensionPlatform: 'wasm_eh',
  files: [
    {
      name: 'duckdb-eh.wasm',
      committedName: 'duckdb-eh.wasm.pinned',
      sha256: '4c221bfa59c11f24dbd750e70c90b9252eca6eec5633936e6a2ec766e55fd879',
      // Present in the lockfile-pinned npm package: pin-equality is verified.
      fromNpmPackage: true,
    },
    {
      name: 'duckdb-browser-eh.worker.js',
      committedName: 'duckdb-browser-eh.worker.js.pinned',
      sha256: 'f8ab72b6b90b3ad83077d47426d4a99d5d9a4c7e07cba1a2be37d655adc7c1ab',
      fromNpmPackage: true,
    },
    {
      name: 'parquet.duckdb_extension.wasm',
      committedName: 'parquet.duckdb_extension.wasm.eh.pinned',
      sha256: '22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55',
      // `wasm_eh` build, fetched ONCE at vendor time (R1-A, 2026-11-14) from:
      //   https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm
      // The engine pairs extensions with the selected bundle's platform tag:
      // an `eh` engine autoloads `/v1.4.3/wasm_eh/…`, so the mvp-platform
      // binary would be the wrong build for it. Runtime NEVER fetches: the
      // harness blocks extensions.duckdb.org (CSP + in-worker interceptor; see
      // VENDORED_ASSETS.md).
      fromNpmPackage: false,
    },
    {
      name: 'json.duckdb_extension.wasm',
      committedName: 'json.duckdb_extension.wasm.eh.pinned',
      sha256: 'b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9',
      // `wasm_eh` build, fetched ONCE at vendor time (R1-A) from:
      //   https://extensions.duckdb.org/v1.4.3/wasm_eh/json.duckdb_extension.wasm
      // Runtime NEVER fetches: the harness blocks extensions.duckdb.org.
      fromNpmPackage: false,
    },
  ],
  license:
    'DuckDB-WASM is MIT-licensed — AGPL-compatible per AGENTS.md (repo is AGPL-3.0-or-later, ADR 0036)',
}

/** Shared browser build options for the webview main thread and its worker. */
const browserBuild = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'warning',
}

/**
 * R-10: the test-only webview entry must NOT contain a second copy of the
 * production app. `webview/test-proof/entry.ts` imports `../dataset` (the real
 * module, so `pnpm typecheck` still checks the seam), but the emitted
 * `dist/webview/dataset-proof.js` keeps that one specifier as an EXTERNAL
 * runtime import of the sibling `./dataset.js` — i.e. the browser loads the
 * production bundle once, and the test-only bundle adds only the D03b proofs.
 * Without this, the proof entry would inline the whole app and the packaged
 * payload would grow by ~1 MB for a test-only artifact.
 */
const externalProductionDataset = {
  name: 'assay-external-production-dataset',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^\.\.\/dataset$/ }, () => ({
      path: './dataset.js',
      external: true,
    }))
  },
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

  // R-10: the TEST-ONLY dataset webview entry. It composes the D03b proofs with
  // the same production app and is loaded by the pinned test host ONLY
  // (`src/dataset.ts` `buildDatasetConfig` selects it under the test
  // predicate). The production entry above has no import edge to
  // `webview/test-proof/**`, so esbuild drops all six proof modules from
  // `dist/webview/dataset.js`; this bundle is the only output that carries
  // them, and it imports the production bundle instead of duplicating it.
  await build({
    ...browserBuild,
    entryPoints: [path.join(appRoot, 'webview/test-proof/entry.ts')],
    outfile: path.join(webviewDist, 'dataset-proof.js'),
    plugins: [externalProductionDataset],
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

  // ptv1-2: verify the vendored pin, then copy the committed assets. Any
  // drift (edited binary, partial vendoring, package bump) fails the build.
  // R1-B: the pin IS the production pair, so every artifact is copied exactly
  // once here (the old harness-only `eh` copy loop is gone).
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
