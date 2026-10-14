// SPDX-License-Identifier: AGPL-3.0-or-later
/* global process */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Single source of truth shared by the real-VSCode harnesses and CI. */
export const PINNED_VSCODE_VERSION = '1.130.0'

export const VSCODE_CACHE_PATH = path.join(homedir(), '.vscode-test')
export const CACHED_VSCODE_EXECUTABLE = path.join(
  VSCODE_CACHE_PATH,
  `vscode-linux-x64-${PINNED_VSCODE_VERSION}`,
  'code',
)

function systemExecutable() {
  for (const candidate of ['/usr/share/code/code', '/usr/bin/code']) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the real test runtime. In CI only the exact pinned cache/download is
 * allowed; local machines retain an explicitly labeled system fallback.
 * VSCODE_EXECUTABLE is an intentional caller-supplied override in either mode.
 */
export async function resolveVSCodeRuntime() {
  const explicit = process.env['VSCODE_EXECUTABLE']
  if (explicit !== undefined) {
    if (!existsSync(explicit)) throw new Error(`VSCODE_EXECUTABLE does not exist: ${explicit}`)
    return { executable: explicit, source: `explicit VSCODE_EXECUTABLE override: ${explicit}` }
  }

  if (existsSync(CACHED_VSCODE_EXECUTABLE)) {
    return {
      executable: CACHED_VSCODE_EXECUTABLE,
      source: `canonical pinned cache (offline-safe): ${CACHED_VSCODE_EXECUTABLE}`,
    }
  }

  try {
    const { downloadAndUnzipVSCode } = await import('@vscode/test-electron')
    const executable = await downloadAndUnzipVSCode({
      version: PINNED_VSCODE_VERSION,
      cachePath: VSCODE_CACHE_PATH,
    })
    return { executable, source: `downloaded pinned ${PINNED_VSCODE_VERSION}: ${executable}` }
  } catch (error) {
    const ciValue = process.env['CI']?.toLowerCase()
    const strictCI =
      ciValue !== undefined && ciValue !== '' && ciValue !== '0' && ciValue !== 'false'
    if (strictCI) {
      throw new Error(
        `pinned VS Code ${PINNED_VSCODE_VERSION} unavailable in CI cache and download failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const system = systemExecutable()
    if (system !== undefined) {
      return { executable: system, source: `LOCAL SYSTEM FALLBACK (pin unavailable): ${system}` }
    }
    throw new Error(
      `pinned VS Code ${PINNED_VSCODE_VERSION} download failed and no local system VS Code was found: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
