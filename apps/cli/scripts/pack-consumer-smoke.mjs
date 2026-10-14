#!/usr/bin/env node
/**
 * Pack and execute the CLI's complete local runtime workspace closure under
 * plain Node in an isolated npm consumer (ADR 0042). The closure is derived
 * recursively from package.json runtime dependencies; a new @assay dependency
 * cannot silently escape this proof.
 */
import { execFileSync, spawnSync } from 'node:child_process'
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
const cliDir = join(repoRoot, 'apps', 'cli')
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`invalid package manifest at ${path}`, { cause: error })
  }
}
const cliManifest = readManifest(join(cliDir, 'package.json'))
const keep = process.argv.includes('--keep')
const REPRESENTATIVE_EXPORTS = {
  '@assay/contracts': ['.', 'parseContract'],
  '@assay/diff': ['.', 'diffDatasets'],
  '@assay/domain': ['.', 'baseRowId'],
  '@assay/engine-duckdb': ['./node', 'executePipeline'],
  '@assay/pipeline': ['.', 'parsePipeline'],
  '@assay/telemetry': ['.', 'createEventBuffer'],
  '@assay/validation': ['.', 'compileContract'],
}

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
function runExpecting(command, args, expected, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  assert.equal(result.error, undefined, `failed to spawn ${command}: ${String(result.error)}`)
  assert.equal(result.signal, null, `${command} was killed by ${String(result.signal)}`)
  assert.equal(
    result.status,
    expected,
    `${command} exited ${String(result.status)}, expected ${expected}; stdout/stderr suppressed`,
  )
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}

// Find all workspace package manifests and derive the runtime @assay closure.
const workspace = new Map()
for (const root of ['packages', 'apps']) {
  for (const name of run('find', [
    join(repoRoot, root),
    '-name',
    'package.json',
    '-not',
    '-path',
    '*/node_modules/*',
  ])
    .trim()
    .split('\n')) {
    if (!name) continue
    const manifest = readManifest(name)
    if (manifest.name?.startsWith('@assay/')) {
      workspace.set(manifest.name, { dir: dirname(name), manifest })
    }
  }
}
const cli = workspace.get('@assay/cli')
assert.ok(cli, 'workspace package @assay/cli is missing')
const closure = new Map()
const visiting = new Set()
function visit(name) {
  if (closure.has(name)) return
  assert.ok(!visiting.has(name), `runtime workspace dependency cycle detected at ${name}`)
  const pkg = workspace.get(name)
  assert.ok(
    pkg,
    `CLI runtime dependency ${name} is not a local workspace package; no registry fallback allowed`,
  )
  visiting.add(name)
  const dependencies = {
    ...pkg.manifest.dependencies,
    ...pkg.manifest.optionalDependencies,
  }
  for (const dependency of Object.keys(dependencies)
    .filter((dep) => dep.startsWith('@assay/'))
    .sort()) {
    visit(dependency)
  }
  visiting.delete(name)
  closure.set(name, pkg)
}
visit('@assay/cli')
for (const name of closure.keys()) {
  if (name === '@assay/cli') continue
  const pkg = closure.get(name)
  assert.ok(
    typeof pkg.manifest.scripts?.build === 'string',
    `${name} is in the CLI runtime closure but has no build script`,
  )
}
for (const name of closure.keys()) {
  if (name !== '@assay/cli') {
    assert.ok(
      REPRESENTATIVE_EXPORTS[name],
      `${name} entered CLI runtime closure; add a plain-Node export pin`,
    )
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'assay-pack-'))
const tarballDir = join(tmpRoot, 'tarballs')
const consumerDir = join(tmpRoot, 'consumer')
mkdirSync(tarballDir, { recursive: true })
mkdirSync(consumerDir, { recursive: true })

try {
  process.stdout.write(`runtime closure: ${[...closure.keys()].join(', ')}\n`)
  process.stdout.write(`version:         ${cliManifest.version}\ntemp:            ${tmpRoot}\n`)

  process.stdout.write('\n[1/5] build the runtime closure in dependency order\n')
  for (const [name, pkg] of closure) {
    if (name === '@assay/cli') continue
    process.stdout.write(`  build ${name}\n`)
    pnpm(['run', 'build'], { cwd: pkg.dir })
  }
  pnpm(['run', 'build'], { cwd: cli.dir })

  process.stdout.write('\n[2/5] pack every package in the runtime closure\n')
  const packed = []
  for (const [name, pkg] of closure) {
    const manifest = pkg.manifest
    pnpm(['pack', '--pack-destination', tarballDir], { cwd: pkg.dir })
    const tarballPath = join(tarballDir, tarballName(name, manifest.version))
    assert.ok(existsSync(tarballPath), `${name}: pnpm pack did not create tarball`)
    const packedManifest = JSON.parse(
      run('tar', ['-xzf', tarballPath, '-O', 'package/package.json']),
    )
    packed.push({ name, pkg, version: manifest.version, tarballPath, manifest: packedManifest })
    const listing = run('tar', ['-tzf', tarballPath])
    assert.ok(
      listing.includes('package/dist/index.js') || name === '@assay/engine-duckdb',
      `${name}: missing dist/index.js`,
    )
    assert.ok(!/(^|\n)package\/src\//.test(listing), `${name}: tarball leaked src/`)
    if (name !== '@assay/cli') {
      const exports = packedManifest.exports ?? {}
      const targets = Object.values(exports).map((entry) =>
        typeof entry === 'string' ? entry : entry?.default,
      )
      assert.ok(
        targets.length > 0 &&
          targets.every((target) => typeof target === 'string' && target.includes('/dist/')),
        `${name}: packed exports do not all target dist: ${JSON.stringify(exports)}`,
      )
      assert.ok(
        Array.isArray(packedManifest.files),
        `${name}: tarball manifest has no files allowlist`,
      )
    }
    process.stdout.write(`  packed ${name}@${manifest.version}\n`)
  }
  const engine = packed.find((pkg) => pkg.name === '@assay/engine-duckdb')
  assert.ok(engine, 'CLI closure does not contain engine-duckdb')
  const engineListing = run('tar', ['-tzf', engine.tarballPath])
  const engineNode = engine.manifest.exports?.['./node']
  const engineNodeTarget = typeof engineNode === 'string' ? engineNode : engineNode?.default
  assert.ok(
    typeof engineNodeTarget === 'string' && engineNodeTarget.includes('/dist/'),
    `engine-duckdb ./node is not dist: ${JSON.stringify(engine.manifest.exports)}`,
  )
  assert.ok(engineListing.includes('package/dist/node.js'), 'engine-duckdb missing dist/node.js')
  assert.ok(
    engineListing.includes('package/dist/pipeline-runner/runner.js'),
    'engine-duckdb missing nested runtime closure',
  )

  process.stdout.write('\n[3/5] install only local tarballs into a clean npm consumer\n')
  const dependencies = Object.fromEntries(
    packed.map((pkg) => [pkg.name, `file:${pkg.tarballPath}`]),
  )
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'assay-pack-consumer',
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2,
    ) + '\n',
  )
  run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], {
    cwd: consumerDir,
    stdio: 'inherit',
  })

  process.stdout.write('\n[4/5] import every closure package and run basic CLI legs\n')
  const checks = Object.entries(REPRESENTATIVE_EXPORTS).filter(([name]) => closure.has(name))
  const smokePath = join(consumerDir, 'imports.mjs')
  writeFileSync(
    smokePath,
    `import { strict as assert } from 'node:assert'\n` +
      `const checks = ${JSON.stringify(checks)}\n` +
      `for (const [name, [subpath, exportName]] of checks) {\n` +
      ` const specifier = name + (subpath === '.' ? '' : subpath.slice(1))\n` +
      ` const resolved = import.meta.resolve(specifier)\n` +
      ` assert.ok(resolved.includes('/dist/'), name + ' did not resolve to dist')\n` +
      ` const mod = await import(specifier)\n` +
      ` assert.ok(exportName in mod && mod[exportName] !== undefined, name + ' missing ' + exportName)\n` +
      ` console.log('  loaded ' + specifier + ' (' + exportName + ')')\n}\n`,
  )
  process.stdout.write(run(process.execPath, [smokePath], { cwd: consumerDir }))

  const binPath = join(consumerDir, 'node_modules', '.bin', 'assay')
  assert.ok(existsSync(binPath), 'installed assay bin is missing')
  const version = run(binPath, ['--version']).trim()
  assert.equal(
    version,
    `assay ${cliManifest.version}`,
    'installed --version differs from package manifest',
  )
  assert.ok(run(binPath, ['--help']).includes('usage:'), 'installed --help omitted usage')

  // Preserve fixture-relative references under the isolated consumer; no repo
  // data is mutated and the fixture inputs are synthetic committed goldens.
  const fixtureRoot = join(consumerDir, 'fixtures')
  mkdirSync(join(fixtureRoot, 'pipeline', 'contracts'), { recursive: true })
  mkdirSync(join(fixtureRoot, 'csv'), { recursive: true })
  for (const file of ['cli_run.yaml', 'cli_dcr_gated.yaml']) {
    copyFileSync(join(repoRoot, 'fixtures', 'pipeline', file), join(fixtureRoot, 'pipeline', file))
  }
  copyFileSync(
    join(repoRoot, 'fixtures', 'pipeline', 'contracts', 'sg_min_rows_fail.yaml'),
    join(fixtureRoot, 'pipeline', 'contracts', 'sg_min_rows_fail.yaml'),
  )
  copyFileSync(
    join(repoRoot, 'fixtures', 'csv', 'customers.csv'),
    join(fixtureRoot, 'csv', 'customers.csv'),
  )
  copyFileSync(
    join(repoRoot, 'fixtures', 'dcr', 'cli-gated-run.yaml'),
    join(consumerDir, 'expected-dcr.yaml'),
  )

  const profile = run(binPath, ['profile', join(fixtureRoot, 'csv', 'customers.csv')])
  assert.ok(profile.trim().length > 0, 'profile returned empty output')
  const validate = runExpecting(binPath, ['validate', join(fixtureRoot, 'csv', 'customers.csv')], 2)
  assert.equal(validate.stdout, '', 'usage failure emitted a report')
  assert.equal(validate.stderr, 'validate requires --contract <file> (see --help)\n')

  const pipelinePath = join(fixtureRoot, 'pipeline', 'cli_run.yaml')
  const pipelineValidate = runExpecting(
    binPath,
    ['pipeline', 'validate', pipelinePath, '--format', 'json'],
    0,
  )
  assert.ok(
    pipelineValidate.stdout.includes('"report": "assay-pipeline-validate-report"'),
    'pipeline validate did not return report',
  )
  const pipelineRun = runExpecting(
    binPath,
    ['pipeline', 'run', pipelinePath, '--format', 'json'],
    0,
  )
  assert.ok(pipelineRun.stdout.includes('"status": "completed"'), 'pipeline run was not completed')
  const gatedPath = join(fixtureRoot, 'pipeline', 'cli_dcr_gated.yaml')
  const dcrOut = join(consumerDir, 'dcr.yaml')
  const dcr = runExpecting(
    binPath,
    [
      'dcr',
      gatedPath,
      '--out',
      dcrOut,
      '--base-node',
      'renamed',
      '--base-dataset-id',
      'customers_base',
      '--candidate-node',
      'by_country',
      '--candidate-dataset-id',
      'customers_by_country',
    ],
    1,
  )
  assert.ok(dcr.stdout.includes('run: gated'), 'DCR command did not disclose gated result')
  assert.ok(
    readFileSync(dcrOut).equals(readFileSync(join(consumerDir, 'expected-dcr.yaml'))),
    'DCR artifact bytes differ from the committed canonical golden',
  )

  const malformed = join(consumerDir, 'malformed.yaml')
  writeFileSync(malformed, 'version: 1\npipeline: broken\nnodes: [\n')
  const malformedRun = runExpecting(binPath, ['pipeline', 'validate', malformed], 2)
  assert.ok(
    malformedRun.stderr.includes('pipeline could not be parsed:'),
    'malformed pipeline did not fail with authored parse diagnostic',
  )
  const noOverwrite = runExpecting(
    binPath,
    [
      'dcr',
      gatedPath,
      '--out',
      dcrOut,
      '--base-node',
      'renamed',
      '--base-dataset-id',
      'customers_base',
      '--candidate-node',
      'by_country',
      '--candidate-dataset-id',
      'customers_by_country',
    ],
    2,
  )
  assert.ok(
    noOverwrite.stderr.includes('never overwritten'),
    'DCR existing destination did not fail',
  )
  assert.ok(
    readFileSync(dcrOut).equals(readFileSync(join(consumerDir, 'expected-dcr.yaml'))),
    'failed DCR overwrite modified artifact',
  )
  process.stdout.write(
    '  installed --version/--help/profile/validate/pipeline validate+run/DCR: PASS\n',
  )
  process.stdout.write('\nPACK CONSUMER SMOKE: PASS\n')
} finally {
  if (keep) process.stdout.write(`kept temp dir: ${tmpRoot}\n`)
  else rmSync(tmpRoot, { recursive: true, force: true })
}
