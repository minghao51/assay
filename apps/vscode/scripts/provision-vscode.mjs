// SPDX-License-Identifier: AGPL-3.0-or-later
/* global console, process */
import { resolveVSCodeRuntime } from './vscode-runtime.mjs'

try {
  const runtime = await resolveVSCodeRuntime()
  console.log(`VS Code runtime ready: ${runtime.source}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
