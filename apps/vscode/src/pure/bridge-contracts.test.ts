// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { DatasetOpenError, WEBVIEW_ERROR_TEXT, type DatasetErrorKind } from './bridge-contracts'

describe('desktop bridge error contracts', () => {
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
