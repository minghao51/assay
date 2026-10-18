// SPDX-License-Identifier: AGPL-3.0-or-later

export type GitContextState = 'no-git' | 'no-repository' | 'untracked' | 'clean' | 'dirty'

export interface GitContextInput {
  readonly extensionPresent: boolean
  readonly repositoryRootPresent: boolean
  readonly branch?: unknown
  readonly tracked?: unknown
  readonly dirty?: unknown
}

export interface GitContextView {
  readonly state: GitContextState
  readonly detail: string
  readonly branch?: string
}

type UntrustedField = string | number | boolean | bigint | symbol | object | null | undefined

function readField(input: unknown, key: string): UntrustedField {
  try {
    if (typeof input !== 'object' || input === null) return undefined
    return (input as Record<string, UntrustedField>)[key]
  } catch {
    return undefined
  }
}

function safeBranch(value: UntrustedField): string | undefined {
  if (typeof value !== 'string') return undefined
  // A Git ref can contain path separators. Display separators as punctuation so
  // the webview gets a branch label, never a path-like string.
  const display = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f))
    })
    .join('')
    .replace(/[\\/]+/g, ' · ')
    .trim()
    .slice(0, 120)
    .trim()
  if (display.length === 0 || display === '.' || display === '..') return undefined
  return display
}

/** Projects untrusted Git API data into a bounded, path-free display model. */
export function projectGitContext(input: unknown): GitContextView {
  const extensionPresent = readField(input, 'extensionPresent')
  const repositoryRootPresent = readField(input, 'repositoryRootPresent')
  const branch = safeBranch(readField(input, 'branch'))
  const base = branch === undefined ? {} : { branch }

  if (extensionPresent !== true) {
    return {
      state: 'no-git',
      detail: extensionPresent === false ? 'Git extension unavailable' : 'unknown',
      ...base,
    }
  }
  if (repositoryRootPresent !== true) {
    return {
      state: 'no-repository',
      detail: repositoryRootPresent === false ? 'No repository' : 'unknown',
      ...base,
    }
  }

  const tracked = readField(input, 'tracked')
  const dirty = readField(input, 'dirty')
  if (tracked === false) return { state: 'untracked', detail: 'Untracked file', ...base }
  if (tracked === true && dirty === false)
    return { state: 'clean', detail: 'Tracked file is clean', ...base }
  if (tracked === true && dirty === true)
    return { state: 'dirty', detail: 'Tracked file has changes', ...base }

  // Missing or malformed status fields must not be represented as clean.
  return { state: 'untracked', detail: 'unknown', ...base }
}

export type DiffCommandArgs =
  | { readonly kind: 'two-uris'; readonly a: unknown; readonly b: unknown }
  | { readonly kind: 'pick' }
  | { readonly kind: 'invalid' }

function isFileUri(value: unknown): boolean {
  try {
    if (typeof value === 'string') {
      return new URL(value).protocol === 'file:'
    }
    if (typeof value !== 'object' || value === null) return false
    return readField(value, 'scheme') === 'file'
  } catch {
    return false
  }
}

/** Accepts exactly two file URIs; absent arguments use the interactive pick flow. */
export function normalizeDiffCommandArgs(uris: unknown): DiffCommandArgs {
  if (uris === undefined || uris === null) return { kind: 'pick' }
  try {
    if (!Array.isArray(uris)) return { kind: 'invalid' }
    if (uris.length === 0) return { kind: 'pick' }
    if (uris.length !== 2 || !isFileUri(uris[0]) || !isFileUri(uris[1])) return { kind: 'invalid' }
    return { kind: 'two-uris', a: uris[0], b: uris[1] }
  } catch {
    return { kind: 'invalid' }
  }
}
