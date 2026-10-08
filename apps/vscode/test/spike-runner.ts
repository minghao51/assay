// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Spike test entry (ptv-1) — loaded by VS Code's extension test host via
 * `--extensionTestsPath`. It runs the spike command against the generated
 * fixture and writes the webview's evidence report to `ASSAY_SPIKE_RESULTS`.
 * There is no test framework here on purpose: the "assertion" is the report
 * itself plus a non-zero exit if the harness could not produce one.
 */
import * as vscode from 'vscode'

export async function run(): Promise<void> {
  const fixturePath = process.env['ASSAY_SPIKE_FIXTURE']
  const resultsPath = process.env['ASSAY_SPIKE_RESULTS']
  if (fixturePath === undefined || fixturePath.length === 0) {
    throw new Error('ASSAY_SPIKE_FIXTURE is not set')
  }
  if (resultsPath === undefined || resultsPath.length === 0) {
    throw new Error('ASSAY_SPIKE_RESULTS is not set')
  }
  const results = await vscode.commands.executeCommand('assay.spike.run', fixturePath)
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(resultsPath),
    new TextEncoder().encode(JSON.stringify(results, null, 2) + '\n'),
  )
}
