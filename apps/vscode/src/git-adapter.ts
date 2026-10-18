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
    const all = [
      ...entries(field(state, 'untrackedChanges')),
      ...entries(field(state, 'workingTreeChanges')),
      ...entries(field(state, 'indexChanges')),
    ]
    const matching = all.filter((change) => safePath(change) === targetPath)
    const untracked = entries(field(state, 'untrackedChanges')).some(
      (change) => safePath(change) === targetPath,
    )
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
