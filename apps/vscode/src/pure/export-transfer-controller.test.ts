// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOnlyWriter } from './create-only-writer'
import type { CreateOnlyWriter } from './create-only-writer'
import {
  createExportTransferController,
  type ExportDestination,
  type ExportTransferController,
} from './export-transfer-controller'
import type { ExportHostResponse } from './export-transfer'

const SOURCE_PATH = '/data/source.csv'
const REQUEST_ID = 'request-1'
const GENERATION = 7

/** Flush the pending microtask queue (the controller dispatches async work). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeWriter implements CreateOnlyWriter {
  readonly written: Uint8Array[] = []
  closed = false
  cleaned = false
  /** When set, `write` settles through this deferred instead of immediately. */
  writeGate: { readonly promise: Promise<void> } | undefined

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(bytes)
    if (this.writeGate !== undefined) await this.writeGate.promise
  }
  async close(): Promise<void> {
    this.closed = true
  }
  async cleanup(): Promise<void> {
    this.cleaned = true
  }
}

interface HarnessOptions {
  readonly destination?: ExportDestination | (() => Promise<ExportDestination>)
  readonly sourcePaths?: readonly string[]
  readonly writerFactory?: (
    destination: string,
    sourcePaths: readonly string[],
  ) => Promise<CreateOnlyWriter>
}

interface Harness {
  readonly controller: ExportTransferController
  readonly posted: ExportHostResponse[]
  /** Every format the controller asked a destination for. */
  readonly acquired: string[]
  /** Every writer the injected factory was asked to create. */
  readonly created: { readonly destination: string; readonly sourcePaths: readonly string[] }[]
  readonly writers: FakeWriter[]
  /** Replace the acquisition behaviour for the next request. */
  setDestination(destination: ExportDestination | (() => Promise<ExportDestination>)): void
  /** Replace the writer factory for the next request. */
  setWriterFactory(
    factory: (destination: string, sourcePaths: readonly string[]) => Promise<CreateOnlyWriter>,
  ): void
}

function selected(fsPath: string, scheme = 'file'): ExportDestination {
  return { kind: 'selected', scheme, fsPath }
}

function harness(options: HarnessOptions = {}): Harness {
  const posted: ExportHostResponse[] = []
  const acquired: string[] = []
  const created: { destination: string; sourcePaths: readonly string[] }[] = []
  const writers: FakeWriter[] = []
  const resolveDestination = (): Promise<ExportDestination> =>
    typeof initialDestination === 'function'
      ? initialDestination()
      : Promise.resolve(initialDestination)
  let initialDestination: ExportDestination | (() => Promise<ExportDestination>) =
    options.destination ?? selected('/export/new.csv')
  let factory: (destination: string, sourcePaths: readonly string[]) => Promise<CreateOnlyWriter> =
    options.writerFactory ??
    (() => {
      const writer = new FakeWriter()
      writers.push(writer)
      return Promise.resolve(writer)
    })
  const controller = createExportTransferController({
    post: (message) => posted.push(message),
    acquireDestination: async (format) => {
      acquired.push(format)
      return await resolveDestination()
    },
    createWriter: async (destination, sourcePaths) => {
      created.push({ destination, sourcePaths })
      return await factory(destination, sourcePaths)
    },
    sourcePaths: options.sourcePaths ?? [SOURCE_PATH],
  })
  return {
    controller,
    posted,
    acquired,
    created,
    writers,
    setDestination(destination) {
      initialDestination = destination
    },
    setWriterFactory(next) {
      factory = next
    },
  }
}

const request = {
  kind: 'export-request',
  id: REQUEST_ID,
  generation: GENERATION,
  format: 'csv',
} as const

/** Drive request → ready → start for one owned transfer. */
async function begun(h: Harness, totalBytes = 3): Promise<FakeWriter> {
  h.controller.request(request)
  await flush()
  expect(h.posted).toContainEqual({ kind: 'export-ready', id: REQUEST_ID, generation: GENERATION })
  h.controller.start({ kind: 'export-start', id: REQUEST_ID, generation: GENERATION, totalBytes })
  expect(h.posted).toContainEqual({ kind: 'export-credit', id: REQUEST_ID, generation: GENERATION })
  const writer = h.writers[0]
  if (writer === undefined) throw new Error('no writer created')
  return writer
}

function chunkFrame(
  sequence: number,
  offset: number,
  bytes: readonly number[] = [sequence + 1],
  totalBytes = 3,
): Record<string, unknown> {
  return {
    kind: 'export-chunk',
    id: REQUEST_ID,
    generation: GENERATION,
    sequence,
    offset,
    totalBytes,
    bytes,
  }
}

const finishFrame = { kind: 'export-finish', id: REQUEST_ID, generation: GENERATION }
const cancelFrame = { kind: 'export-cancel', id: REQUEST_ID, generation: GENERATION }

const errorKinds = (posted: readonly ExportHostResponse[]): string[] =>
  posted
    .filter((message) => message.kind === 'export-error')
    .map((message) => (message.kind === 'export-error' ? message.errorKind : ''))

describe('export transfer controller: ingress', () => {
  it('refuses malformed request envelopes before any destination or writer work', () => {
    const h = harness()
    for (const malformed of [
      null,
      'export-request',
      {},
      { ...request, id: undefined },
      { ...request, id: '' },
      { ...request, id: 'x'.repeat(65) },
      { ...request, generation: undefined },
      { ...request, generation: -1 },
      { ...request, generation: 1.5 },
      { ...request, generation: '3' },
      { ...request, format: 'xlsx' },
      { ...request, format: undefined },
    ])
      h.controller.request(malformed)
    expect(h.acquired).toEqual([])
    expect(h.created).toEqual([])
    expect(h.posted).toEqual([])
  })

  it('refuses a destination that is not a local file or aliases a source, before creating a writer', async () => {
    for (const destination of [
      selected('/export/new.csv', 'untitled'),
      selected('/data/source.csv'),
    ]) {
      const h = harness({ destination })
      h.controller.request(request)
      await flush()
      expect(h.created).toEqual([])
      expect(h.posted).toEqual([
        {
          kind: 'export-error',
          id: REQUEST_ID,
          generation: GENERATION,
          errorKind: 'destination-refused',
        },
      ])
    }
  })

  it('reports cancelled when the picker is dismissed, and owns nothing afterwards', async () => {
    const h = harness({ destination: { kind: 'cancelled' } })
    h.controller.request(request)
    await flush()
    expect(h.posted).toEqual([{ kind: 'export-cancelled', id: REQUEST_ID, generation: GENERATION }])
    expect(h.created).toEqual([])
    // The slot is released again: a second request is not busy.
    h.setDestination(selected('/export/retry.csv'))
    h.controller.request(request)
    await flush()
    expect(h.created).toEqual([{ destination: '/export/retry.csv', sourcePaths: [SOURCE_PATH] }])
    expect(errorKinds(h.posted)).toEqual([])
  })

  it('posts destination-refused when the create-only factory refuses', async () => {
    const h = harness({
      writerFactory: () => Promise.reject(new Error('destination-refused')),
    })
    h.controller.request(request)
    await flush()
    expect(h.posted).toEqual([
      {
        kind: 'export-error',
        id: REQUEST_ID,
        generation: GENERATION,
        errorKind: 'destination-refused',
      },
    ])
  })

  it('owns at most one transfer: a second request during acquisition or ownership is busy', async () => {
    const gate = deferred<ExportDestination>()
    const h = harness({ destination: () => gate.promise })
    h.controller.request(request)
    await flush()
    h.controller.request({ ...request, id: 'request-2' })
    expect(h.posted).toEqual([
      { kind: 'export-error', id: 'request-2', generation: GENERATION, errorKind: 'export-busy' },
    ])
    gate.resolve(selected('/export/new.csv'))
    await flush()
    h.controller.start({
      kind: 'export-start',
      id: REQUEST_ID,
      generation: GENERATION,
      totalBytes: 3,
    })
    h.controller.request({ ...request, id: 'request-3', generation: 8 })
    expect(h.posted).toContainEqual({
      kind: 'export-error',
      id: 'request-3',
      generation: 8,
      errorKind: 'export-busy',
    })
    expect(h.created).toHaveLength(1)
  })
})

describe('export transfer controller: frame bounds', () => {
  it('writes nothing until a contiguous in-bounds chunk is accepted', async () => {
    const invalid = [
      { ...chunkFrame(0, 0), id: 'other-request' },
      { ...chunkFrame(0, 0), generation: GENERATION - 1 },
      chunkFrame(1, 0),
      chunkFrame(0, 1),
      { ...chunkFrame(0, 0), totalBytes: 4 },
      chunkFrame(0, 0, []),
      chunkFrame(0, 0, [256]),
      chunkFrame(0, 0, [-1]),
      { ...chunkFrame(0, 0), sequence: undefined },
      { kind: 'export-chunk' },
      null,
      'export-chunk',
    ]
    for (const frame of invalid) {
      const h = harness()
      const writer = await begun(h)
      h.controller.chunk(frame)
      await flush()
      expect(writer.written).toEqual([])
      expect(writer.cleaned).toBe(true)
      expect(errorKinds(h.posted)).toEqual(['export-failed'])
    }
  })

  it('accepts the exact next chunk and refuses a duplicate or early chunk', async () => {
    const h = harness()
    const writer = await begun(h)
    h.controller.chunk(chunkFrame(0, 0))
    await flush()
    expect(writer.written.map((bytes) => [...bytes])).toEqual([[1]])
    expect(h.posted.filter((message) => message.kind === 'export-credit')).toHaveLength(2)

    // The same frame again (duplicate) stops the transfer.
    h.controller.chunk(chunkFrame(0, 0))
    await flush()
    expect(writer.written.map((bytes) => [...bytes])).toEqual([[1]])
    expect(writer.cleaned).toBe(true)
    expect(errorKinds(h.posted)).toEqual(['export-failed'])
  })

  it('refuses a second chunk while the previous write is still in flight', async () => {
    const h = harness()
    const writer = await begun(h)
    const gate = deferred<void>()
    writer.writeGate = { promise: gate.promise }
    h.controller.chunk(chunkFrame(0, 0))
    await flush()
    h.controller.chunk(chunkFrame(1, 1))
    await flush()
    expect(writer.written.map((bytes) => [...bytes])).toEqual([[1]])
    expect(writer.cleaned).toBe(true)
    expect(errorKinds(h.posted)).toEqual(['export-failed'])
    gate.resolve()
    await flush()
  })

  it('refuses start frames with a stale generation or a bad total', async () => {
    for (const frame of [
      { ...finishFrame, kind: 'export-start', totalBytes: 3, id: 'other-request' },
      { kind: 'export-start', id: REQUEST_ID, generation: GENERATION - 1, totalBytes: 3 },
      { kind: 'export-start', id: REQUEST_ID, generation: GENERATION, totalBytes: -1 },
      { kind: 'export-start', id: REQUEST_ID, generation: GENERATION, totalBytes: 1.5 },
      {
        kind: 'export-start',
        id: REQUEST_ID,
        generation: GENERATION,
        totalBytes: 512 * 1024 * 1024 + 1,
      },
      { kind: 'export-start', id: REQUEST_ID, generation: GENERATION },
      null,
    ]) {
      const h = harness()
      const writer = await begun(h)
      h.controller.start(frame)
      await flush()
      expect(writer.cleaned).toBe(true)
      // The existing invalid-start branch refuses silently (no credit).
      expect(errorKinds(h.posted)).toEqual([])
    }
  })

  it('refuses a duplicate start instead of rewinding the sequence bounds', async () => {
    const h = harness()
    const writer = await begun(h)
    h.controller.chunk(chunkFrame(0, 0))
    await flush()
    h.controller.start({
      kind: 'export-start',
      id: REQUEST_ID,
      generation: GENERATION,
      totalBytes: 3,
    })
    await flush()
    expect(writer.written.map((bytes) => [...bytes])).toEqual([[1]])
    expect(writer.cleaned).toBe(true)
  })

  it('completes only when the delivered offset matches totalBytes', async () => {
    const incomplete = harness()
    const incompleteWriter = await begun(incomplete)
    incomplete.controller.finish(finishFrame)
    await flush()
    expect(incompleteWriter.closed).toBe(false)
    expect(incompleteWriter.cleaned).toBe(true)
    expect(incomplete.posted.some((message) => message.kind === 'export-complete')).toBe(false)

    const stale = harness()
    const staleWriter = await begun(stale)
    stale.controller.chunk(chunkFrame(0, 0, [1]))
    await flush()
    stale.controller.finish({ ...finishFrame, generation: GENERATION - 1 })
    await flush()
    expect(staleWriter.closed).toBe(false)
    expect(staleWriter.cleaned).toBe(true)

    const complete = harness()
    const completeWriter = await begun(complete)
    complete.controller.chunk(chunkFrame(0, 0, [1, 2, 3]))
    await flush()
    complete.controller.finish(finishFrame)
    await flush()
    expect(completeWriter.closed).toBe(true)
    expect(complete.posted).toContainEqual({
      kind: 'export-complete',
      id: REQUEST_ID,
      generation: GENERATION,
    })
  })

  it('refuses a write failure and reports export-failed', async () => {
    const h = harness()
    const writer = await begun(h)
    const gate = deferred<void>()
    writer.writeGate = { promise: gate.promise }
    h.controller.chunk(chunkFrame(0, 0))
    await flush()
    gate.reject(new Error('write-failed'))
    await flush()
    expect(writer.cleaned).toBe(true)
    expect(errorKinds(h.posted)).toEqual(['export-failed'])
  })

  it('cancels the owned transfer only for the matching id and generation', async () => {
    const h = harness()
    const writer = await begun(h)
    h.controller.cancel({ ...cancelFrame, generation: GENERATION - 1 })
    await flush()
    expect(writer.cleaned).toBe(false)
    h.controller.cancel({ ...cancelFrame, id: 'other-request' })
    await flush()
    expect(writer.cleaned).toBe(false)
    h.controller.cancel({ ...cancelFrame, id: undefined })
    h.controller.cancel(null)
    await flush()
    expect(writer.cleaned).toBe(false)
    h.controller.cancel(cancelFrame)
    await flush()
    expect(writer.cleaned).toBe(true)
    expect(h.posted).toContainEqual({
      kind: 'export-cancelled',
      id: REQUEST_ID,
      generation: GENERATION,
    })
  })
})

describe('export transfer controller: disposal and session change', () => {
  it('cancels the owned transfer on dispose and ignores later frames', async () => {
    const h = harness()
    const writer = await begun(h)
    await h.controller.dispose()
    expect(writer.cleaned).toBe(true)
    const posted = h.posted.length
    h.controller.chunk(chunkFrame(0, 0))
    h.controller.finish(finishFrame)
    h.controller.cancel(cancelFrame)
    h.controller.request({ ...request, id: 'request-late' })
    h.controller.start({
      kind: 'export-start',
      id: REQUEST_ID,
      generation: GENERATION,
      totalBytes: 3,
    })
    await flush()
    expect(writer.written).toEqual([])
    expect(writer.closed).toBe(false)
    expect(h.posted).toHaveLength(posted)
    expect(h.acquired).toEqual(['csv'])
    // Disposal is idempotent and terminal.
    await h.controller.dispose()
    expect(writer.cleaned).toBe(true)
  })

  it('does not create a writer when disposal lands during acquisition', async () => {
    const gate = deferred<ExportDestination>()
    const h = harness({ destination: () => gate.promise })
    h.controller.request(request)
    await flush()
    await h.controller.dispose()
    gate.resolve(selected('/export/new.csv'))
    await flush()
    expect(h.created).toEqual([])
    expect(h.posted).toEqual([])
  })

  it('cleans up a writer created by a continuation that raced disposal', async () => {
    const gate = deferred<CreateOnlyWriter>()
    const raced = new FakeWriter()
    const h = harness({ writerFactory: () => gate.promise })
    h.controller.request(request)
    await flush()
    await h.controller.dispose()
    gate.resolve(raced)
    await flush()
    expect(raced.cleaned).toBe(true)
    expect(h.posted).toEqual([])
  })

  it('stops crediting after disposal during an in-flight write', async () => {
    const h = harness()
    const writer = await begun(h)
    const gate = deferred<void>()
    writer.writeGate = { promise: gate.promise }
    h.controller.chunk(chunkFrame(0, 0))
    await flush()
    const credits = h.posted.filter((message) => message.kind === 'export-credit').length
    await h.controller.dispose()
    gate.resolve()
    await flush()
    expect(h.posted.filter((message) => message.kind === 'export-credit')).toHaveLength(credits)
    expect(writer.cleaned).toBe(true)
  })
})

describe('export transfer controller: create-only delivery', () => {
  let directory = ''
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })
  async function tempDir(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'assay-transfer-'))
    return directory
  }
  /** Poll until `assert` holds (real `node:fs` work settles over several turns). */
  async function settle(assert: () => unknown): Promise<void> {
    await vi.waitFor(assert, { timeout: 5_000, interval: 5 })
  }
  async function deliver(
    h: Harness,
    id: string,
    bytes: readonly number[],
    totalBytes = bytes.length,
  ): Promise<void> {
    h.controller.request({ ...request, id })
    await settle(() => {
      expect(h.posted).toContainEqual({ kind: 'export-ready', id, generation: GENERATION })
    })
    h.controller.start({ kind: 'export-start', id, generation: GENERATION, totalBytes })
    h.controller.chunk({ ...chunkFrame(0, 0, bytes, totalBytes), id })
    await settle(() => {
      expect(h.posted.filter((message) => message.kind === 'export-credit')).toHaveLength(2)
    })
  }

  it('delivers the exact bytes through the real create-only writer', async () => {
    const dir = await tempDir()
    const source = join(dir, 'source.csv')
    const destination = join(dir, 'delivered.csv')
    await writeFile(source, 'id\n1\n')
    const h = harness({
      destination: selected(destination),
      sourcePaths: [source],
      writerFactory: (path, sourcePaths) => createOnlyWriter(path, sourcePaths),
    })
    await deliver(h, 'real-1', [1, 2, 3])
    h.controller.finish({ ...finishFrame, id: 'real-1' })
    await settle(() => {
      expect(h.posted).toContainEqual({
        kind: 'export-complete',
        id: 'real-1',
        generation: GENERATION,
      })
    })
    expect([...(await readFile(destination))]).toEqual([1, 2, 3])
    expect(await readFile(source, 'utf8')).toBe('id\n1\n')
  })

  it('never overwrites an existing destination', async () => {
    const dir = await tempDir()
    const existing = join(dir, 'existing.csv')
    await writeFile(existing, 'original')
    const h = harness({
      destination: selected(existing),
      sourcePaths: [],
      writerFactory: (path, sourcePaths) => createOnlyWriter(path, sourcePaths),
    })
    h.controller.request({ ...request, id: 'real-2' })
    await settle(() => {
      expect(errorKinds(h.posted)).toEqual(['destination-refused'])
    })
    expect(await readFile(existing, 'utf8')).toBe('original')
  })

  it('refuses a source alias before the writer exists', async () => {
    const dir = await tempDir()
    const source = join(dir, 'source.csv')
    await writeFile(source, 'id\n1\n')
    const h = harness({
      destination: selected(source),
      sourcePaths: [source],
      writerFactory: (path, sourcePaths) => createOnlyWriter(path, sourcePaths),
    })
    h.controller.request({ ...request, id: 'real-3' })
    await settle(() => {
      expect(errorKinds(h.posted)).toEqual(['destination-refused'])
    })
    expect(h.created).toEqual([])
    expect(await readFile(source, 'utf8')).toBe('id\n1\n')
  })

  it('removes its owned partial file on cancellation', async () => {
    const dir = await tempDir()
    const destination = join(dir, 'partial.csv')
    const h = harness({
      destination: selected(destination),
      sourcePaths: [],
      writerFactory: (path, sourcePaths) => createOnlyWriter(path, sourcePaths),
    })
    await deliver(h, 'real-4', [9, 9, 9])
    h.controller.cancel({ kind: 'export-cancel', id: 'real-4', generation: GENERATION })
    await settle(async () => {
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
