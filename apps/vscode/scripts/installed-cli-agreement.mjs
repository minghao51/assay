// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** Build an isolated packed consumer containing the recursive @assay CLI closure. */
export function installCliConsumer() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'assay-cli-consumer-'))
  const tarballsDir = path.join(tempRoot, 'tarballs')
  const consumerDir = path.join(tempRoot, 'consumer')
  mkdirSync(tarballsDir)
  mkdirSync(consumerDir)

  const pending = ['apps/cli']
  const packages = new Map()
  while (pending.length > 0) {
    const relativeDir = pending.pop()
    if (relativeDir === undefined || packages.has(relativeDir)) continue
    const manifestPath = path.join(workspaceRoot, relativeDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    packages.set(relativeDir, manifest)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependency.startsWith('@assay/')) continue
      const depDir = path.join('packages', dependency.slice('@assay/'.length))
      if (!packages.has(depDir)) pending.push(depDir)
    }
  }

  // The runner assumes `corepack pnpm build` ran first: packing a package
  // whose dist/ is missing silently produces an empty tarball and the
  // consumer install fails far away with a confusing module error.
  for (const relativeDir of [...packages.keys()].sort()) {
    if (!existsSync(path.join(workspaceRoot, relativeDir, 'dist'))) {
      throw new Error(`${relativeDir} has no dist/ — run \`corepack pnpm build\` before the e2e`)
    }
  }
  const tarballs = []
  for (const relativeDir of [...packages.keys()].sort()) {
    execFileSync('corepack', ['pnpm', 'pack', '--pack-destination', tarballsDir], {
      cwd: path.join(workspaceRoot, relativeDir),
      stdio: 'pipe',
    })
  }
  for (const name of readdirSync(tarballsDir)
    .filter((entry) => entry.endsWith('.tgz'))
    .sort()) {
    tarballs.push(path.join(tarballsDir, name))
  }
  if (tarballs.length !== packages.size) throw new Error('packed CLI closure is incomplete')

  writeFileSync(path.join(consumerDir, 'package.json'), '{"private":true}\n')
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], {
    cwd: consumerDir,
    stdio: 'pipe',
  })
  const require = createRequire(path.join(consumerDir, 'package.json'))
  const cliPath = require.resolve('@assay/cli/dist/index.js')
  return { tempRoot, cliPath, packageCount: packages.size }
}

export function cleanupCliConsumer(tempRoot) {
  rmSync(tempRoot, { recursive: true, force: true })
}
