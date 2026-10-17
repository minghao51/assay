// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOnlyWriter } from './create-only-writer'

let directory = ''
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function tempDir(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'assay-export-'))
  return directory
}

describe('create-only export writer', () => {
  it('refuses an existing file without changing it', async () => {
    const dir = await tempDir()
    const target = join(dir, 'target.csv')
    await writeFile(target, 'original')
    await expect(createOnlyWriter(target)).rejects.toThrow('destination-refused')
    expect(await readFile(target, 'utf8')).toBe('original')
  })
  it('removes only its owned partial file on cancellation', async () => {
    const dir = await tempDir()
    const target = join(dir, 'partial.csv')
    const writer = await createOnlyWriter(target)
    await writer.write(Uint8Array.from([1, 2, 3]))
    await writer.cleanup()
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('never removes a replacement inode during cleanup', async () => {
    const dir = await tempDir()
    const target = join(dir, 'raced.csv')
    const writer = await createOnlyWriter(target)
    await unlink(target)
    await writeFile(target, 'replacement')
    await writer.cleanup()
    expect(await readFile(target, 'utf8')).toBe('replacement')
  })
  it('refuses a source alias', async () => {
    const dir = await tempDir()
    const target = join(dir, 'source.csv')
    await writeFile(target, 'source')
    await expect(createOnlyWriter(target, [target])).rejects.toThrow('destination-refused')
    expect(await readFile(target, 'utf8')).toBe('source')
  })
})
