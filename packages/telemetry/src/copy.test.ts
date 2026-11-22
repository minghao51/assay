// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  CLI_DISCLOSURE_COPY,
  DISCLOSURE_REVISION,
  WEB_DISCLOSURE_BODY,
  WEB_DISCLOSURE_KEEP_ON_LABEL,
  WEB_DISCLOSURE_TURN_OFF_LABEL,
} from './index.js'

interface ImportMetaWithGlob {
  glob: (
    pattern: string,
    options: { query: string; import: string; eager: true },
  ) => Record<string, string>
}

/**
 * Byte-exactness pin: the disclosure constants must equal the §6.3 drafts in
 * the design document, character for character. The contract file is loaded as
 * a raw string through Vite's glob (the same mechanism as `red-lines.test.ts`),
 * so drift in either the copy or the design fails here.
 */
const DOC_MATCHES = (import.meta as unknown as ImportMetaWithGlob).glob(
  '../../../docs/engineering/06-telemetry-design.md',
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
)

function designDisclosureBlocks(): readonly [string, string] {
  const doc = Object.values(DOC_MATCHES)[0]
  if (doc === undefined) throw new Error('could not load the telemetry design document')
  const section = doc.slice(doc.indexOf('### 6.3'), doc.indexOf('### 6.4'))
  const blocks = [...section.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1] ?? '')
  if (blocks.length < 2) throw new Error('could not locate the §6.3 disclosure blocks')
  return [blocks[0] as string, blocks[1] as string]
}

describe('§6.3 disclosure copy — byte-exact (revision 1)', () => {
  it('pins the revision marker', () => {
    expect(DISCLOSURE_REVISION).toBe(1)
  })

  it('pins the E01 opt-out sentence: stops attempts, aborts in flight, no recall claim', () => {
    // E01 option A (§3.4): the superseded "nothing further is sent" overstated
    // the guarantee; the replacement states the in-flight limit and claims no
    // recall of already-delivered metadata.
    const flat = WEB_DISCLOSURE_BODY.replace(/\s+/g, ' ')
    expect(flat).toContain(
      'Turning it off stops further attempts and attempts to abort in-flight delivery; metadata already delivered is not recalled.',
    )
    expect(flat).not.toContain('nothing further is sent')
    expect(flat.toLowerCase()).not.toContain('recall' + 'ed after')
  })

  it('leaves the CLI copy untouched (CLI parity is out of scope, E01 §7)', () => {
    expect(CLI_DISCLOSURE_COPY).toContain('This notice is shown once.')
    expect(CLI_DISCLOSURE_COPY).not.toContain('in-flight')
  })

  it('pins the web body and button labels against the design document', () => {
    const [web] = designDisclosureBlocks()
    const buttonLine = web.slice(web.lastIndexOf('\n\n[ ') + 2).trimEnd()
    const body = web.slice(0, web.lastIndexOf('\n\n[ '))
    expect(WEB_DISCLOSURE_BODY).toBe(body)
    expect(`[ ${WEB_DISCLOSURE_KEEP_ON_LABEL} ]   [ ${WEB_DISCLOSURE_TURN_OFF_LABEL} ]`).toBe(
      buttonLine,
    )
  })

  it('pins the CLI block against the design document', () => {
    const [, cli] = designDisclosureBlocks()
    expect(CLI_DISCLOSURE_COPY).toBe(cli.replace(/\n$/, ''))
  })
})
