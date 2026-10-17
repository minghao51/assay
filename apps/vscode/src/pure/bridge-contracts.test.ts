// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  DatasetOpenError,
  normalizeEditProof,
  normalizeValidationProof,
  WEBVIEW_ERROR_TEXT,
  type DatasetErrorKind,
} from './bridge-contracts'

describe('desktop bridge error contracts', () => {
  it('projects validation proof to bounded value-free counts and flags', () => {
    const proof = {
      baselineFailures: 1,
      editedFailures: 0,
      insertedFailures: 2,
      deletedFailures: 0,
      staleAfterEdit: true,
      logicalNavigation: true,
      sampleValue: 'private-content',
    }
    expect(normalizeValidationProof(proof)).toEqual({
      baselineFailures: 1,
      editedFailures: 0,
      insertedFailures: 2,
      deletedFailures: 0,
      staleAfterEdit: true,
      logicalNavigation: true,
    })
    expect(normalizeValidationProof({ ...proof, insertedFailures: -1 })).toBeUndefined()
    expect(
      normalizeValidationProof({ ...proof, sampleValue: undefined, deletedFailures: 'secret' }),
    ).toBeUndefined()
  })

  it('projects test proof to exact booleans and drops content-bearing properties', () => {
    const proof = {
      cellIdentity: true,
      keyboardCancel: true,
      undoRedo: false,
      insertDelete: true,
      branchTruncation: false,
      queryStatePreserved: true,
      sessionWarningVisible: true,
      fullViewCastRefusal: false,
      privateCell: 'synthetic-secret',
      path: '/private/source.csv',
    }
    expect(normalizeEditProof(proof)).toEqual({
      cellIdentity: true,
      keyboardCancel: true,
      undoRedo: false,
      insertDelete: true,
      branchTruncation: false,
      queryStatePreserved: true,
      sessionWarningVisible: true,
      fullViewCastRefusal: false,
    })
    expect(normalizeEditProof({ ...proof, undoRedo: 'secret' })).toBeUndefined()
    expect(normalizeEditProof('content-bearing')).toBeUndefined()
  })

  it('preserves typed kind and host-side message semantics', () => {
    const error = new DatasetOpenError('missing-file', 'file not found: /private/source.csv')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('DatasetOpenError')
    expect(error.kind).toBe('missing-file')
    expect(error.message).toBe('file not found: /private/source.csv')
  })

  it('pins fixed path-free webview text for every error kind', () => {
    expect(WEBVIEW_ERROR_TEXT).toEqual({
      'missing-file': 'the file does not exist or is not accessible',
      'unsupported-format':
        'not a supported dataset format (supported: Parquet, CSV, JSONL/NDJSON, JSON, Arrow/Feather/IPC)',
      'empty-file': 'the file is empty',
      'read-failed': 'the file could not be read',
      'engine-failed': 'the dataset could not be opened',
    })
    for (const kind of Object.keys(WEBVIEW_ERROR_TEXT) as DatasetErrorKind[]) {
      expect(WEBVIEW_ERROR_TEXT[kind]).not.toContain('/private/source.csv')
      expect(WEBVIEW_ERROR_TEXT[kind]).not.toContain('file:///')
    }
  })
})
