// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveVSCodeRuntime, CACHED_VSCODE_EXECUTABLE } from '../scripts/vscode-runtime.mjs'

test('strict CI rejects an explicit executable override before inspecting or provisioning it', async () => {
  let inspected = false
  let downloaded = false
  await assert.rejects(
    resolveVSCodeRuntime({
      env: { CI: '1', VSCODE_EXECUTABLE: '/usr/bin/true' },
      exists: () => {
        inspected = true
        return true
      },
      download: async () => {
        downloaded = true
        return '/pinned/code'
      },
    }),
    /VSCODE_EXECUTABLE overrides are not permitted in CI/,
  )
  assert.equal(inspected, false)
  assert.equal(downloaded, false)
})

test('local executable override is accepted only when it exists', async () => {
  await assert.rejects(
    resolveVSCodeRuntime({
      env: { VSCODE_EXECUTABLE: '/missing/code' },
      exists: () => false,
    }),
    /VSCODE_EXECUTABLE does not exist/,
  )

  const runtime = await resolveVSCodeRuntime({
    env: { VSCODE_EXECUTABLE: '/custom/code' },
    exists: (candidate) => candidate === '/custom/code',
  })
  assert.deepEqual(runtime, {
    executable: '/custom/code',
    source: 'explicit VSCODE_EXECUTABLE override: /custom/code',
  })
})

test('cached pinned runtime resolves offline without invoking provisioning', async () => {
  let downloaded = false
  const runtime = await resolveVSCodeRuntime({
    env: { CI: 'true' },
    exists: (candidate) => candidate === CACHED_VSCODE_EXECUTABLE,
    download: async () => {
      downloaded = true
      throw new Error('network must not be used')
    },
  })
  assert.equal(runtime.executable, CACHED_VSCODE_EXECUTABLE)
  assert.match(runtime.source, /canonical pinned cache \(offline-safe\)/)
  assert.equal(downloaded, false)
})

test('strict CI refuses system fallback when pinned provisioning fails', async () => {
  let downloaded = false
  await assert.rejects(
    resolveVSCodeRuntime({
      env: { CI: '1' },
      exists: (candidate) => candidate === '/usr/bin/code',
      download: async () => {
        downloaded = true
        throw new Error('offline provisioning failure')
      },
    }),
    /pinned VS Code 1\.130\.0 unavailable in CI cache and download failed: offline provisioning failure/,
  )
  assert.equal(downloaded, true)
})

test('empty and false CI values retain local override policy', async (t) => {
  for (const ci of ['', '0', 'false', 'FALSE']) {
    await t.test(JSON.stringify(ci), async () => {
      const runtime = await resolveVSCodeRuntime({
        env: { CI: ci, VSCODE_EXECUTABLE: '/custom/code' },
        exists: (candidate) => candidate === '/custom/code',
      })
      assert.equal(runtime.executable, '/custom/code')
    })
  }
})
