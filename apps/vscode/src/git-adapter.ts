// SPDX-License-Identifier: AGPL-3.0-or-later
import * as vscode from 'vscode'
import { projectGitContext, type GitContextView } from './pure/git-context'

type UnknownRecord = Record<string, unknown>
type GitField = object | string | number | boolean | null | undefined
function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : undefined
}
function field(value: unknown, key: string): GitField {
  try {
    const result = record(value)?.[key]
    return result === null ||
      result === undefined ||
      ['object', 'string', 'number', 'boolean'].includes(typeof result)
      ? (result as GitField)
      : undefined
  } catch {
    return undefined
  }
}
function safePath(value: unknown): string | undefined {
  const uri = field(value, 'uri') ?? field(value, 'resourceUri')
  const path = field(uri, 'fsPath')
  return typeof path === 'string' ? path : undefined
}
function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Read-only adapter over the built-in vscode.git extension API (Git API v1.30). */
export function gitContextFor(uri: vscode.Uri): GitContextView {
  let extension: unknown
  try {
    extension = vscode.extensions.getExtension('vscode.git')
  } catch {
    return projectGitContext({})
  }
  if (extension === undefined)
    return projectGitContext({ extensionPresent: false, repositoryRootPresent: false })
  let api: unknown
  try {
    const exports = field(extension, 'exports')
    const getAPI = record(exports)?.['getAPI']
    if (typeof getAPI !== 'function') throw new Error('unavailable')
    api = getAPI.call(exports, 1)
  } catch {
    return projectGitContext({ extensionPresent: false, repositoryRootPresent: false })
  }
  let repository: unknown
  try {
    const getRepository = record(api)?.['getRepository']
    if (typeof getRepository !== 'function') throw new Error('unavailable')
    repository = getRepository.call(api, uri)
  } catch {
    return projectGitContext({ extensionPresent: true, repositoryRootPresent: false })
  }
  if (repository === undefined || repository === null || field(repository, 'state') === undefined)
    return projectGitContext({ extensionPresent: true, repositoryRootPresent: false })
  try {
    const state = field(repository, 'state')
    const head = field(state, 'HEAD')
    const branch = field(head, 'name')
    const root = field(repository, 'rootUri')
    const targetPath = uri.fsPath
    // In the vscode.git API, untracked files appear INSIDE workingTreeChanges
    // with status 'U' (there is no separate untrackedChanges array — an
    // earlier draft scraped a nonexistent field and every untracked file
    // classified as dirty). Statuses are untrusted strings; treat anything
    // not string-typed as an unknown change.
    const matching = [
      ...entries(field(state, 'workingTreeChanges')),
      ...entries(field(state, 'indexChanges')),
    ].filter((change) => safePath(change) === targetPath)
    // The vscode.git API's Change.status is the NUMERIC Status enum of the
    // pinned runtime (UNTRACKED = 7, read from the 1.130.0 extension bundle;
    // a string comparison against 'U' matched nothing). Untrusted input:
    // only the exact untracked value classifies a file untracked — every
    // other numeric status is a tracked change.
    const untracked = matching.some((change) => field(change, 'status') === 7)
    return projectGitContext({
      extensionPresent: true,
      repositoryRootPresent: typeof field(root, 'fsPath') === 'string',
      branch,
      tracked: untracked ? false : true,
      dirty: matching.length > 0,
    })
  } catch {
    return projectGitContext({ extensionPresent: true, repositoryRootPresent: true })
  }
}
