// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { normalizeDiffCommandArgs, projectGitContext } from './git-context'

describe('desktop Git context projection', () => {
  it('projects absent Git, absent repository, untracked, clean, and dirty states', () => {
    expect(projectGitContext({ extensionPresent: false, repositoryRootPresent: false })).toEqual({
      state: 'no-git',
      detail: 'Git extension unavailable',
    })
    expect(projectGitContext({ extensionPresent: true, repositoryRootPresent: false })).toEqual({
      state: 'no-repository',
      detail: 'No repository',
    })
    expect(
      projectGitContext({ extensionPresent: true, repositoryRootPresent: true, tracked: false }),
    ).toEqual({ state: 'untracked', detail: 'Untracked file' })
    expect(
      projectGitContext({
        extensionPresent: true,
        repositoryRootPresent: true,
        tracked: true,
        dirty: false,
        branch: 'main',
      }),
    ).toEqual({ state: 'clean', detail: 'Tracked file is clean', branch: 'main' })
    expect(
      projectGitContext({
        extensionPresent: true,
        repositoryRootPresent: true,
        tracked: true,
        dirty: true,
      }),
    ).toEqual({ state: 'dirty', detail: 'Tracked file has changes' })
  })

  it('degrades malformed state and branch fields to generic unknown details', () => {
    const expected = { state: 'untracked', detail: 'unknown' }
    expect(projectGitContext({ extensionPresent: true, repositoryRootPresent: true })).toEqual(
      expected,
    )
    expect(
      projectGitContext({
        extensionPresent: true,
        repositoryRootPresent: true,
        tracked: true,
        dirty: 'yes',
        branch: { value: '/private/file' },
      }),
    ).toEqual({ state: 'untracked', detail: 'unknown' })
    expect(
      projectGitContext({
        extensionPresent: true,
        repositoryRootPresent: true,
        tracked: true,
        dirty: false,
        branch: 42,
      }),
    ).toEqual({ state: 'clean', detail: 'Tracked file is clean' })
    expect(projectGitContext(null)).toEqual({ state: 'no-git', detail: 'unknown' })
  })

  it('bounds and sanitizes a branch label while never emitting path separators', () => {
    const view = projectGitContext({
      extensionPresent: true,
      repositoryRootPresent: true,
      tracked: true,
      dirty: false,
      branch: `feature/private\u0000name/${'x'.repeat(200)}`,
    })
    expect(view.branch).toBeDefined()
    expect(view.branch).not.toContain('/')
    expect(view.branch).not.toContain('\\')
    expect(view.branch).not.toContain('\u0000')
    expect(view.branch?.length).toBeLessThanOrEqual(120)

    const pathFree = projectGitContext({
      extensionPresent: true,
      repositoryRootPresent: true,
      tracked: true,
      dirty: true,
      branch: '/home/user/private.csv',
    })
    for (const value of Object.values(pathFree)) {
      if (typeof value === 'string') expect(value).not.toContain('/')
    }
  })

  it('accepts exactly two file URIs, picks on absent arguments, and rejects invalid shapes', () => {
    const a = { scheme: 'file', path: '/a.csv' }
    const b = 'file:///b.csv'
    expect(normalizeDiffCommandArgs(undefined)).toEqual({ kind: 'pick' })
    expect(normalizeDiffCommandArgs([])).toEqual({ kind: 'pick' })
    expect(normalizeDiffCommandArgs([a, b])).toEqual({ kind: 'two-uris', a, b })
    expect(normalizeDiffCommandArgs([a])).toEqual({ kind: 'invalid' })
    expect(normalizeDiffCommandArgs([a, { scheme: 'https' }])).toEqual({ kind: 'invalid' })
    expect(normalizeDiffCommandArgs([a, b, b])).toEqual({ kind: 'invalid' })
    expect(normalizeDiffCommandArgs({ a, b })).toEqual({ kind: 'invalid' })
  })
})
