// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { EXPORT_FORMATS, exportFormatInfo } from './formats'

/**
 * Format-metadata pins (m4-5 fix round). The advertised metadata must be
 * honest about the bytes the engine actually writes and the journeys the app
 * can actually deliver: the arrow export is an Arrow IPC *stream* (the
 * engine's worker assembles it with apache-arrow's `tableToIPC` default,
 * `RecordBatchStreamWriter` — no `ARROW1` file magic), and it is the one
 * format the open flow cannot read back.
 */
describe('export format metadata — honest advertisement', () => {
  it('advertises the arrow export as an IPC stream, not the file container', () => {
    expect(exportFormatInfo('arrow').mimeType).toBe('application/vnd.apache.arrow.stream')
  })

  it('describes arrow as an interchange stream Assay cannot re-open', () => {
    const arrow = exportFormatInfo('arrow')
    expect(arrow.description).toContain('stream')
    expect(arrow.description).toContain('other tools')
    expect(arrow.description).toContain('cannot re-open')
  })

  it('keeps the human MIME types for the re-openable formats', () => {
    expect(exportFormatInfo('parquet').mimeType).toBe('application/vnd.apache.parquet')
    expect(exportFormatInfo('csv').mimeType).toBe('text/csv')
    expect(exportFormatInfo('jsonl').mimeType).toBe('application/x-ndjson')
    expect(exportFormatInfo('json').mimeType).toBe('application/json')
  })

  it('covers every engine format, in stable display order, with matching extensions', () => {
    expect(EXPORT_FORMATS.map((info) => info.format)).toEqual([
      'parquet',
      'csv',
      'jsonl',
      'json',
      'arrow',
    ])
    for (const info of EXPORT_FORMATS) {
      expect(info.extension).toBe(info.format)
    }
  })
})
