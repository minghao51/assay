#!/usr/bin/env node
/**
 * pack-consumer-smoke.mjs — the ar-5 done-when harness (ADR 0042).
 *
 * Proves, empirically and repeatably, that the publishable workspace packages
 * and the CLI produce installable npm artifacts:
 *
 *   1. build the tsc artifacts fresh (`tsc --build`), so we pack what ships;
 *   2. `pnpm pack` every publishable package plus the private packages the
 *      CLI's dependency closure needs at install time (engine-duckdb — the
 *      npm org claim M1 means nothing is on the registry);
 *   3. assert every publishable tarball's `publishConfig` was applied — the
 *      top-level `exports` point at `dist/`, `files` is present, and no
 *      `src/` leaked in — and that the private engine tarball's `./node`
 *      subpath resolves to `dist/` too;
 *   4. create a CLEAN temp consumer, install only the packed tarballs with
 *      npm (`file:` protocol; D10 is npm-only, and npm dedupes the CLI's
 *      rewritten `0.0.0` workspace ranges to the tarballs — nothing is on the
 *      registry), and smoke it:
 *        - resolve every publishable package to a `dist/` module and import
 *          one named export under PLAIN `node` (no `tsx`, no loader) — the
 *          packed dist graph must be plain-Node-loadable;
 *        - run the installed `assay` bin under PLAIN `node` (no loader):
 *          `--version` / `--help` (the shipped entrypoint must not need tsx);
 *        - run one REAL command end-to-end from the installed bin:
 *          `assay profile <copy of fixtures/csv/customers.csv>` (human mode),
 *          asserting exit 0 and non-empty stdout.
 *
 * Packaging honesty:
 *   - The CLI build script chmods the emitted `dist/index.js`. That bit is
 *     belt-and-braces for running the artifact from a working tree; it is NOT
 *     what makes the packed bin runnable — `pnpm pack`/`npm install` normalize
 *     bin-target modes to 755 regardless. The enforceable leg is the shebang
 *     in the compiled entry plus the `bin` path.
 *   - The CLI cannot be installed standalone from npm today: its `workspace:*`
 *     ranges are rewritten to `0.0.0`, and nothing is on the registry. This
 *     harness installs the whole local closure by `file:` tarball to prove the
 *     artifacts themselves work; publishing the closure is a release-time task
 *     (ADR 0042).
 *
 * Nothing publishes. Run `corepack pnpm --filter @assay/cli exec node
 * scripts/pack-consumer-smoke.mjs` (or `node apps/cli/scripts/...` from the
 * repo root) to reproduce. Pass `--keep` to leave the temp dir in place.
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..', '..')

/** The packages meant to publish, each with one representative export. */
const PUBLISHABLE = [
  { name: '@assay/domain', dir: 'packages/domain', exportName: 'baseRowId' },
  { name: '@assay/contracts', dir: 'packages/contracts', exportName: 'parseContract' },
  { name: '@assay/validation', dir: 'packages/validation', exportName: 'compileContract' },
  { name: '@assay/diff', dir: 'packages/diff', exportName: 'diffDatasets' },
  { name: '@assay/grid', dir: 'packages/grid', exportName: 'GridViewportModel' },
]

/**
 * Private packages needed to satisfy the CLI's dependency closure at install
 * time. `@assay/engine-duckdb` stays private (its browser surface is
 * harness/wasm-bound; publishing it needs the ADR 0042 bundler addendum), but
 * the CLI declares it as a real runtime dependency, so the consumer must
 * install a tarball for it or the install cannot resolve.
 */
const PRIVATE_FOR_CLOSURE = [{ name: '@assay/engine-duckdb', dir: 'packages/engine-duckdb' }]

const CLI = { name: '@assay/cli', dir: 'apps/cli' }

const keep = process.argv.includes('--keep')

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function pnpm(args, options = {}) {
  return run('corepack', ['pnpm', ...args], options)
}

function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'assay-pack-'))
const tarballDir = join(tmpRoot, 'tarballs')
const consumerDir = join(tmpRoot, 'consumer')
mkdirSync(tarballDir, { recursive: true })
mkdirSync(consumerDir, { recursive: true })

try {
  process.stdout.write(`workspace: ${repoRoot}\ntemp:      ${tmpRoot}\n`)

  process.stdout.write('\n[1/5] build the tsc artifacts fresh (plain-node-loadable dist graphs)\n')
  // Build through the package scripts, not a bare `tsc --build`: the CLI's
  // build chmods its emitted bin target, and `tsc --build` follows the project
  // references so the whole CLI dependency closure (including the private
  // engine's `./node` graph) is emitted before packing.
  pnpm(['run', 'build'], { cwd: join(repoRoot, 'apps', 'cli') })
  pnpm(['run', 'build'], { cwd: join(repoRoot, 'packages', 'grid') })

  process.stdout.write('\n[2/5] pnpm pack every publishable package + the CLI closure\n')
  const packed = []
  for (const pkg of [...PUBLISHABLE, ...PRIVATE_FOR_CLOSURE, CLI]) {
    const pkgDir = join(repoRoot, pkg.dir)
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    pnpm(['pack', '--pack-destination', tarballDir], { cwd: pkgDir })
    const tarballPath = join(tarballDir, tarballName(manifest.name, manifest.version))
    assert.ok(existsSync(tarballPath), `pack did not produce ${tarballPath}`)
    const packedManifest = JSON.parse(
      run('tar', ['-xzf', tarballPath, '-O', 'package/package.json']),
    )
    packed.push({ ...pkg, version: manifest.version, tarballPath, manifest: packedManifest })
    process.stdout.write(`  packed ${manifest.name}@${manifest.version} -> ${tarballPath}\n`)
  }

  process.stdout.write('\n[3/5] assert publishConfig was applied (dist exports, no src)\n')
  for (const pkg of packed) {
    if (pkg.name === CLI.name) continue
    if (PRIVATE_FOR_CLOSURE.some((entry) => entry.name === pkg.name)) continue
    const entry = pkg.manifest.exports?.['.']
    const target = typeof entry === 'string' ? entry : entry?.default
    assert.ok(
      typeof target === 'string' && target.includes('/dist/'),
      `${pkg.name}: tarball exports are not dist: ${JSON.stringify(pkg.manifest.exports)}`,
    )
    assert.ok(Array.isArray(pkg.manifest.files), `${pkg.name}: tarball manifest has no files`)
    const listing = run('tar', ['-tzf', pkg.tarballPath])
    assert.ok(
      !/(^|\n)package\/src\//.test(listing),
      `${pkg.name}: tarball leaked src/ (files should be dist-only)`,
    )
    process.stdout.write(`  ok ${pkg.name}: exports -> ${target}; no src/\n`)
  }
  const cli = packed.find((pkg) => pkg.name === CLI.name)
  assert.equal(
    cli.manifest.bin?.assay,
    './dist/index.js',
    `CLI bin is not dist: ${JSON.stringify(cli.manifest.bin)}`,
  )
  process.stdout.write('  ok @assay/cli: bin -> ./dist/index.js\n')
  // The private engine tarball stays private, but its publishConfig must still
  // point the `./node` seam at the emitted dist graph — that is what makes the
  // installed CLI runnable (a src-pointing subpath dies under Node's type
  // stripping inside node_modules).
  const engine = packed.find((pkg) => pkg.name === '@assay/engine-duckdb')
  const nodeEntry = engine.manifest.exports?.['./node']
  const nodeTarget = typeof nodeEntry === 'string' ? nodeEntry : nodeEntry?.default
  assert.ok(
    typeof nodeTarget === 'string' && nodeTarget.includes('/dist/'),
    `engine-duckdb ./node is not dist: ${JSON.stringify(engine.manifest.exports)}`,
  )
  const engineListing = run('tar', ['-tzf', engine.tarballPath])
  assert.ok(
    engineListing.includes('package/dist/node.js'),
    'engine-duckdb tarball is missing dist/node.js (files allowlist / build)',
  )
  assert.ok(
    !engineListing.includes('package/src/'),
    'engine-duckdb tarball leaked src/ despite the dist-only files allowlist',
  )
  process.stdout.write(
    `  ok @assay/engine-duckdb: ./node -> ${nodeTarget}; dist/node.js present, no src/\n`,
  )

  process.stdout.write('\n[4/5] create a clean consumer and install the tarballs with npm\n')
  const dependencies = {}
  for (const pkg of packed) dependencies[pkg.name] = `file:${pkg.tarballPath}`
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      { name: 'assay-pack-consumer', private: true, type: 'module', dependencies },
      null,
      2,
    ) + '\n',
  )
  // npm (not pnpm): D10 distribution is npm-only, and npm dedupes the CLI's
  // rewritten `0.0.0` workspace ranges to the packed `file:` tarballs without
  // the registry.
  run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], {
    cwd: consumerDir,
    stdio: 'inherit',
  })

  process.stdout.write('\n[5/5] smoke: import the libraries, run the installed bin\n')
  const smokePath = join(consumerDir, 'smoke.mjs')
  writeFileSync(
    smokePath,
    `import { strict as assert } from 'node:assert'\n` +
      `const checks = ${JSON.stringify(
        PUBLISHABLE.map((pkg) => ({ name: pkg.name, exportName: pkg.exportName })),
      )}\n` +
      `for (const { name, exportName } of checks) {\n` +
      `  const resolved = import.meta.resolve(name)\n` +
      `  assert.ok(resolved.includes('/dist/'), name + ' did not resolve to dist: ' + resolved)\n` +
      `  const mod = await import(name)\n` +
      `  assert.ok(exportName in mod, name + ' is missing export ' + exportName)\n` +
      `  assert.notEqual(mod[exportName], undefined, name + '.' + exportName + ' is undefined')\n` +
      `  console.log('  ok ' + name + ' -> ' + resolved.replace(/^.*\\/node_modules\\//, 'node_modules/') + ' (' + exportName + ')')\n` +
      `}\n`,
  )
  const smokeOut = run(process.execPath, [smokePath], { cwd: consumerDir })
  process.stdout.write(smokeOut)

  const binPath = join(consumerDir, 'node_modules', '.bin', 'assay')
  assert.ok(existsSync(binPath), `installed bin not found: ${binPath}`)
  // Run the installed bin DIRECTLY (its shebang + executable bit), under
  // plain node resolution — no loader.
  const version = run(binPath, ['--version'])
  assert.equal(version.trim(), 'assay 0.0.0', `unexpected --version output: ${version}`)
  const help = run(binPath, ['--help'])
  assert.ok(help.includes('usage:'), '--help did not print usage')
  process.stdout.write('  ok installed bin: .bin/assay --version / --help (direct, no tsx)\n')

  // Real-command leg: the packed CLI + packed engine closure must actually
  // execute against a dataset. Copy a small golden fixture in (read-only; the
  // repo's fixtures/** is never touched) and run the human profile report.
  const fixtureCopy = join(consumerDir, 'customers.csv')
  copyFileSync(join(repoRoot, 'fixtures', 'csv', 'customers.csv'), fixtureCopy)
  const profileOut = run(binPath, ['profile', fixtureCopy])
  assert.ok(profileOut.trim().length > 0, 'profile printed no stdout')
  assert.ok(profileOut.includes('dataset: customers.csv'), 'profile report shape unexpected')
  process.stdout.write(
    '  ok installed bin: .bin/assay profile customers.csv (human, exit 0, non-empty)\n',
  )

  process.stdout.write('\nPACK CONSUMER SMOKE: PASS\n')
} finally {
  if (keep) {
    process.stdout.write(`kept temp dir: ${tmpRoot}\n`)
  } else {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}
