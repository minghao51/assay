// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineCsvPreviewResult } from '@assay/engine-duckdb'
import type { ArrowTableLike } from '../grid/provider'
import { CsvReviewDialog, CSV_PREVIEW_SAMPLE_ROWS } from './CsvReviewDialog'

/**
 * EW-03I-b — the CSV review surface, pinned against the accepted ledger.
 *
 * Copy is asserted as INDEPENDENT literals here (never imported from `copy.ts`),
 * the `replace/messages`/export/help precedent. Three classes of pin:
 *
 * 1. **Every user-visible sentence**, so no row can quietly reword honesty
 *    copy (D3/D5/D6/D13/D14, `sample_size` scope, "stopped reviewing", the
 *    sample cap and its "never an evaluation of the whole file" boundary).
 * 2. **The prohibited wording, negatively** (ADR 0049 item 6): over the whole
 *    rendered surface in a POPULATED (successful) sample state, none of
 *    "validated", "checked", "verified" or "confirmed" may appear — that is
 *    the mutation this file exists to catch.
 * 3. **The adoption contract**: exactly once, carrying exactly the option set
 *    the sample on screen was read with and never `sample_size`; disabled
 *    whenever the form, a refusal, an in-flight read or a failed read means
 *    the screen no longer represents what would be opened.
 *
 * Late results are dropped by the generation guard, including after
 * abandonment; dataset values never reach `console.*`, and the picked file's
 * name is never rendered (ADR 0025). This repo has no jest-dom matchers, so
 * assertions read `textContent`/`disabled` directly.
 */

const APPROVED = {
  title: 'Review CSV options',
  scope: 'This review opens nothing. The file stays a candidate until you choose Open this file.',
  adopt: 'Open this file',
  stop: 'Stop reviewing',
  adoptHelperIdle: 'Opens the file with the options this sample used, over the whole file.',
  adoptHelperReplace: 'Opens the file with the options this sample used and replaces this session.',
  optionsHeading: 'Read options',
  optionsScope:
    'Anything left unset stays the reader’s guess. An option the reader does not accept is refused here, before anything is read.',
  unset: 'Reader choice',
  yes: 'Yes',
  no: 'No',
  delimLabel: 'Delimiter',
  delimHelper:
    'One character, for example ; or |. The reader accepts delim only; delimiter and separator are refused.',
  headerLabel: 'First row is a header',
  allVarcharLabel: 'All columns as text',
  sampleSizeLabel: 'Rows read to guess types',
  sampleSizeHelper: 'Inference only. 0 reads no rows; -1 (every row) is refused.',
  nullstrLabel: 'Text that means NULL',
  dateformatLabel: 'Date format',
  quoteLabel: 'Quote character',
  escapeLabel: 'Escape character',
  commentLabel: 'Comment prefix',
  skipLabel: 'Rows to skip first',
  typesLabel: 'Column types',
  typesHelper:
    'One column per line, as name: TYPE (for example id: BIGINT). A type the reader does not accept is refused before it is sent.',
  typesLineError: 'Each line must read name: TYPE.',
  duplicateColumnError: 'Each column name may be declared only once.',
  unsupportedColumnNameError: 'That column name cannot be declared here.',
  update: 'Update sample',
  stale:
    'These options changed after the sample was read. Choose Update sample so the sample and the disclosure match what Open this file would use.',
  loading: 'Reading the sample…',
  effectiveHeading: 'Options this sample used',
  effectiveNone: 'No option was set, so the read used the reader’s guess for every setting.',
  sniffHeading: 'What the reader inferred from the head of the file',
  sniffNote:
    'These are the reader’s own settings and types, inferred from a sample of rows. They describe how the file will be read, not what it contains.',
  sniffColumnsHeading: 'Column names and types',
  sniffPromptHeading: 'The read_csv call for these settings',
  sniffPromptNote:
    'Display text only. It names the reader’s staging name, not your file, and nothing here runs it.',
  sampleHeading: 'Bounded sample',
  sampleTableCaption: 'Bounded sample, read-only',
  sampleScope:
    'A sample is not an evaluation of the whole file. A value the column type cannot take can appear past these rows, and that is normal: the dataset is read in full when it is opened, and such a row fails that read.',
  sampleMore: 'The file holds more rows than this sample shows.',
  sampleMismatch:
    'The sample does not match the column list the reader reported, so it is not shown.',
  refusalPrefix: 'These options were not sent: ',
  refusalSuffix: ' The sample below is unchanged.',
  meaningsHeading: 'What the default settings mean',
  nullDefault:
    'By default an empty field and a quoted empty field both read as NULL, and the reader has no setting that tells them apart.',
  nullDefault2:
    'Naming a text that means NULL replaces an empty field with that text instead; the two shapes still read the same.',
  dates:
    'A date or timestamp column keeps the type the reader guessed, and the guessed format is shown above. No locale or date-order inference is applied: only a date format set here overrides the guess.',
  headerRenames:
    'The reader renames duplicate and empty header names on its own: an empty name becomes column0 for the first column, column1 for the second, and so on; a repeated name gets a numeric suffix such as id_1. The names above are the names after those renames, and they are the names the opened dataset will have.',
  headerRenamesList:
    'The reader renames duplicate and empty header names on its own. This is what it renamed in this file’s header:',
  headerRenamesNone:
    'The reader renamed nothing in this header: every name above is the name the file itself uses.',
  headerRenamesUnavailable:
    'No per-file rename list is shown for this file: it could not be derived safely from the head of the file.',
  renameEmpty: '(empty name)',
  renameArrow: '→',
  unsafeInts:
    'A whole number column can be guessed as DOUBLE, and whole numbers above 2^53 lose precision that way: 9007199254740993 reads as 9007199254740992. Reading every column as text, or declaring an exact type for the column, keeps the digits; nothing here forces a type.',
  noRowSkip:
    'Rows are never skipped silently. The row-dropping and reject-table options are refused, so a row the reader cannot parse fails the read instead of disappearing.',
  sampleSizeScope:
    'The number of rows read to guess types applies to this review only. It never applies to the opened dataset, which guesses its own types, so a column type can differ after opening.',
  nullCell: 'NULL',
  noneValue: 'None',
} as const

/** The cap sentence, composed from the CAP THE RESPONSE REPORTS. */
function sampleCap(rowCap: number): string {
  return `Sample cap: the first ${String(rowCap)} rows of the file.`
}

/** The four words ADR 0049 item 6 forbids around a sample. */
const PROHIBITED_WORDING = /validated|checked|verified|confirmed/i

type SampleBatch = NonNullable<EngineCsvPreviewResult['sample']>['batch']

/** One column-major batch double (the structural slice the projector reads). */
function batch(columns: readonly (readonly unknown[])[]): ArrowTableLike {
  return {
    numRows: columns[0]?.length ?? 0,
    numCols: columns.length,
    getChildAt: (index: number) => {
      const values = columns[index]
      if (values === undefined) return null
      return { get: (rowIndex: number) => values[rowIndex] }
    },
  }
}

function sampleBatch(columns: readonly (readonly unknown[])[]): SampleBatch {
  return batch(columns) as unknown as SampleBatch
}

/** A populated, entirely ordinary preview response. */
function previewResult(overrides: Partial<EngineCsvPreviewResult> = {}): EngineCsvPreviewResult {
  return {
    previewId: 'p1',
    sniff: {
      delimiter: ';',
      quote: '"',
      escape: '',
      newLineDelimiter: '\n',
      comment: '',
      skipRows: 0,
      hasHeader: true,
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'note', type: 'VARCHAR' },
      ],
      dateFormat: null,
      timestampFormat: null,
      prompt: "read_csv('preview_p1', delim = ';')",
    },
    effectiveOptions: {},
    sample: {
      batch: sampleBatch([
        [1, 2],
        ['alpha', null],
      ]),
      hasMore: true,
      rowCap: 50,
    },
    ...overrides,
  }
}

interface PreviewCall {
  readonly options: Record<string, unknown> | undefined
  readonly sampleRows: number | undefined
}

interface Harness {
  readonly calls: PreviewCall[]
  readonly onAdopt: ReturnType<typeof vi.fn>
  readonly onStop: ReturnType<typeof vi.fn>
  /** Unmount the surface, as the parent does after `onStop` (production path). */
  readonly unmount: () => void
}

/**
 * Mount the dialog with a fake engine boundary. `responder` decides what each
 * read returns (a response, a rejection, or a promise the test settles), so a
 * test can hold results and settle them out of order.
 */
function mount(
  responder: (call: PreviewCall, index: number) => Promise<EngineCsvPreviewResult> = () =>
    Promise.resolve(previewResult()),
  mode: 'idle' | 'replace' = 'idle',
  /** The picked file's bytes; the default head disagrees with `sniff.columns`. */
  fileText = 'id;name\n1;anna\n',
  /** Holds the head read open, so the pending state is observable. */
  headGate?: Promise<void>,
): Harness {
  const calls: PreviewCall[] = []
  const onAdopt = vi.fn()
  const onStop = vi.fn()
  const file = new File([fileText], 'picked-source-name.csv')
  const getFile = (): Promise<File> =>
    headGate === undefined ? Promise.resolve(file) : headGate.then(() => file)
  const rendered = render(
    <CsvReviewDialog
      mode={mode}
      source={{ name: file.name, getFile }}
      requestPreview={(_source, options, sampleRows) => {
        const call: PreviewCall = { options, sampleRows }
        calls.push(call)
        return responder(call, calls.length - 1)
      }}
      onAdopt={onAdopt as never}
      onStop={onStop as never}
    />,
  )
  return { calls, onAdopt, onStop, unmount: rendered.unmount }
}

function dialogElement(): HTMLDialogElement {
  const element = screen.getByTestId('csv-review')
  if (!(element instanceof HTMLDialogElement)) {
    throw new Error(`the review must be a native <dialog>, got <${element.tagName}>`)
  }
  return element
}

/** The whole rendered surface, for the negative wording assertion. */
function surfaceText(): string {
  return dialogElement().textContent ?? ''
}

function textOf(testId: string): string {
  return screen.getByTestId(testId).textContent ?? ''
}

function button(testId: string): HTMLButtonElement {
  const element = screen.getByTestId(testId)
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`${testId} must be a <button>`)
  }
  return element
}

function selectOptions(testId: string): string[] {
  const element = screen.getByTestId(testId)
  if (!(element instanceof HTMLSelectElement)) throw new Error(`${testId} must be a <select>`)
  return Array.from(element.options).map((option) => option.textContent ?? '')
}

async function waitForSample(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('csv-review-sample-table')).toBeTruthy()
  })
}

function change(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CSV review — the surface and its promises', () => {
  it('is a native modal <dialog> with the review title and the non-adoption promise', async () => {
    mount()
    const dialog = dialogElement()
    expect(dialog.open).toBe(true)
    expect(dialog.getAttribute('aria-labelledby')).toBe('csv-review-title')
    expect(surfaceText()).toContain(APPROVED.title)
    expect(textOf('csv-review-scope')).toBe(APPROVED.scope)
    await waitForSample()
  })

  it('reads the reader own choices first, with no option set and the documented cap', async () => {
    const harness = mount()
    await waitForSample()
    expect(harness.calls).toHaveLength(1)
    // No options at all: the request carries none (the quick-open request shape).
    expect(harness.calls[0]?.options).toBeUndefined()
    expect(harness.calls[0]?.sampleRows).toBe(CSV_PREVIEW_SAMPLE_ROWS)
    expect(CSV_PREVIEW_SAMPLE_ROWS).toBe(50)
  })

  it('states the cap the RESPONSE applied, not a local constant', async () => {
    mount(() =>
      Promise.resolve(
        previewResult({
          // One row, both disclosed columns: only the CAP differs from the
          // ordinary response, so the assertion isolates it.
          sample: { batch: sampleBatch([[1], ['alpha']]), hasMore: false, rowCap: 7 },
        }),
      ),
    )
    await waitForSample()
    expect(textOf('csv-review-sample-cap')).toBe(sampleCap(7))
  })

  it('renders the D8/D13 boundary: the sample is not an evaluation of the whole file', async () => {
    mount()
    await waitForSample()
    expect(textOf('csv-review-sample-scope')).toBe(APPROVED.sampleScope)
    expect(textOf('csv-review-sample-more')).toBe(APPROVED.sampleMore)
    expect(surfaceText()).toContain(APPROVED.sampleHeading)
    expect(surfaceText()).toContain(APPROVED.sampleTableCaption)
  })

  it('drops the truncation sentence when the response says the sample is the whole file', async () => {
    mount(() =>
      Promise.resolve(
        previewResult({
          sample: { batch: sampleBatch([[1], ['alpha']]), hasMore: false, rowCap: 50 },
        }),
      ),
    )
    await waitForSample()
    expect(screen.queryByTestId('csv-review-sample-more')).toBeNull()
  })

  it('renders a NULL cell as NULL, never as a blank cell', async () => {
    mount()
    await waitForSample()
    const cells = screen.getAllByTestId('csv-review-sample-cell')
    expect(cells.map((cell) => cell.textContent)).toEqual(['1', 'alpha', '2', APPROVED.nullCell])
  })
})

describe('CSV review — the sniff and effective-option disclosure (ADR 0049 item 6)', () => {
  it('renders every disclosed dialect field, the column list and the prompt as text', async () => {
    mount()
    await waitForSample()
    const sniff = textOf('csv-review-sniff')
    expect(sniff).toContain(APPROVED.sniffHeading)
    expect(sniff).toContain(APPROVED.sniffNote)
    expect(textOf('csv-review-sniff-delimiter')).toBe(';')
    expect(textOf('csv-review-sniff-quote')).toBe('"')
    // '' from the engine reads as an explicit None, never a blank cell.
    expect(textOf('csv-review-sniff-escape')).toBe(APPROVED.noneValue)
    expect(textOf('csv-review-sniff-newline')).toBe('\\n')
    expect(textOf('csv-review-sniff-comment')).toBe(APPROVED.noneValue)
    expect(textOf('csv-review-sniff-skip')).toBe('0')
    expect(textOf('csv-review-sniff-header')).toBe(APPROVED.yes)
    expect(textOf('csv-review-sniff-dateformat')).toBe(APPROVED.noneValue)
    expect(textOf('csv-review-sniff-timestampformat')).toBe(APPROVED.noneValue)
    const columns = screen.getAllByTestId('csv-review-sniff-column')
    expect(columns.map((column) => column.textContent)).toEqual(['id BIGINT', 'note VARCHAR'])
    expect(sniff).toContain(APPROVED.sniffColumnsHeading)
    expect(sniff).toContain(APPROVED.sniffPromptHeading)
    expect(sniff).toContain(APPROVED.sniffPromptNote)
    expect(textOf('csv-review-sniff-prompt')).toBe("read_csv('preview_p1', delim = ';')")
  })

  it('states the effective option set the sample read composed, sample_size included', async () => {
    mount(() =>
      Promise.resolve(
        previewResult({
          effectiveOptions: { delim: ';', sample_size: 100, header: true },
        }),
      ),
    )
    await waitForSample()
    expect(textOf('csv-review-effective-delim')).toBe(';')
    expect(textOf('csv-review-effective-header')).toBe('yes')
    expect(textOf('csv-review-effective-sample_size')).toBe('100')
  })

  it('says so explicitly when the read composed no option', async () => {
    mount()
    await waitForSample()
    expect(textOf('csv-review-effective-none')).toBe(APPROVED.effectiveNone)
    expect(textOf('csv-review-effective')).toContain(APPROVED.effectiveHeading)
  })
})

describe('CSV review — the ledger disclosures are all present before adoption', () => {
  const cases = [
    ['csv-review-meaning-null', APPROVED.nullDefault],
    ['csv-review-meaning-null', APPROVED.nullDefault2],
    ['csv-review-meaning-dates', APPROVED.dates],
    ['csv-review-meaning-renames', APPROVED.headerRenames],
    ['csv-review-meaning-unsafe-ints', APPROVED.unsafeInts],
    ['csv-review-meaning-no-skip', APPROVED.noRowSkip],
    ['csv-review-meaning-sample-size', APPROVED.sampleSizeScope],
  ] as const

  it.each(cases)('%s carries its accepted sentence', async (testId, sentence) => {
    mount()
    await waitForSample()
    expect(textOf('csv-review-meanings')).toContain(APPROVED.meaningsHeading)
    expect(textOf(testId)).toContain(sentence)
  })
})

describe('CSV review — D3, the per-file header rename list (verified or absent)', () => {
  /** `fixtures/csv/dup-header.csv`, and the sniff the real engine reports for it. */
  const DUP_HEADER = 'id,,id\n1,x,2\n3,y,4\n'
  function dupHeaderResult(
    overrides: Partial<EngineCsvPreviewResult> = {},
  ): EngineCsvPreviewResult {
    return {
      ...previewResult(),
      // The engine's REAL payload shape: unset dialect values arrive as the
      // literal text `(empty)` and the terminator as the escape text `\\n`.
      sniff: {
        delimiter: ',',
        quote: '(empty)',
        escape: '(empty)',
        newLineDelimiter: '\\n',
        comment: '',
        skipRows: 0,
        hasHeader: true,
        columns: [
          { name: 'id', type: 'BIGINT' },
          { name: 'column1', type: 'VARCHAR' },
          { name: 'id_1', type: 'BIGINT' },
        ],
        dateFormat: null,
        timestampFormat: null,
        prompt: null,
      },
      effectiveOptions: {},
      sample: {
        // Column-major, like an Arrow batch: id, column1, id_1.
        batch: sampleBatch([
          [1, 3],
          ['x', 'y'],
          [2, 4],
        ]),
        hasMore: false,
        rowCap: 50,
      },
      ...overrides,
    }
  }

  /** `fixtures/csv/quoted-newline.csv`, and the sniff the real engine reports. */
  const QUOTED_NEWLINE = '"a,b",id,"line\none",id,\n1,alpha,3,4,5\n2,beta,6,7,8\n'
  function quotedNewlineResult(): EngineCsvPreviewResult {
    return dupHeaderResult({
      sniff: {
        ...dupHeaderResult().sniff,
        quote: '"',
        columns: [
          { name: 'a,b', type: 'BIGINT' },
          { name: 'id', type: 'VARCHAR' },
          { name: 'line\none', type: 'BIGINT' },
          { name: 'id_1', type: 'BIGINT' },
          { name: 'column4', type: 'BIGINT' },
        ],
      },
      sample: {
        // Column-major: `a,b`, `id`, `line\none`, `id_1`, `column4`.
        batch: sampleBatch([
          [1, 2],
          ['alpha', 'beta'],
          [3, 6],
          [4, 7],
          [5, 8],
        ]),
        hasMore: false,
        rowCap: 50,
      },
    })
  }

  /** One listed pair, as the surface renders it. */
  function pairs(): string[] {
    return screen.getAllByTestId('csv-review-rename').map((item) => item.textContent ?? '')
  }

  async function waitForList(): Promise<void> {
    await waitFor(() => {
      expect(screen.getByTestId('csv-review-rename-list')).toBeTruthy()
    })
  }

  async function waitForLimit(): Promise<void> {
    await waitFor(() => {
      expect(textOf('csv-review-meaning-renames')).toContain(APPROVED.headerRenamesUnavailable)
    })
  }

  it('shows the file own rename list before adoption, and nothing else', async () => {
    const harness = mount(() => Promise.resolve(dupHeaderResult()), 'idle', DUP_HEADER)
    await waitForSample()
    await waitForList()
    expect(pairs()).toEqual([
      `${APPROVED.renameEmpty} ${APPROVED.renameArrow} column1`,
      `id ${APPROVED.renameArrow} id_1`,
    ])
    const disclosure = textOf('csv-review-meaning-renames')
    expect(disclosure).toContain(APPROVED.headerRenamesList)
    // The list REPLACES the behaviour sentence; it does not sit beside it.
    expect(disclosure).not.toContain(APPROVED.headerRenames)
    // Still disclosed before adoption: the list is not a state gate.
    expect(button('csv-review-adopt').disabled).toBe(false)
    expect(harness.onAdopt).not.toHaveBeenCalled()
    expect(surfaceText()).not.toMatch(PROHIBITED_WORDING)
  })

  it('reads a header record that holds a quoted delimiter and a quoted newline', async () => {
    mount(() => Promise.resolve(quotedNewlineResult()), 'idle', QUOTED_NEWLINE)
    await waitForSample()
    await waitForList()
    // Only the two real renames. A naive split on the delimiter would report
    // nothing here or the wrong names for the quoted fields.
    expect(pairs()).toEqual([
      `id ${APPROVED.renameArrow} id_1`,
      `${APPROVED.renameEmpty} ${APPROVED.renameArrow} column4`,
    ])
    expect(textOf('csv-review-rename-list')).not.toContain('line')
    expect(textOf('csv-review-rename-list')).not.toContain('a,b')
  })

  it('says plainly when the reader renamed nothing in this header', async () => {
    mount(() => Promise.resolve(previewResult()), 'idle', 'id;note\n1;alpha\n')
    await waitForSample()
    await waitFor(() => {
      expect(textOf('csv-review-meaning-renames')).toBe(APPROVED.headerRenamesNone)
    })
    expect(screen.queryByTestId('csv-review-rename-list')).toBeNull()
  })

  it('never shows a list whose reconstruction disagrees with the engine', async () => {
    // The head really is `id,,id`, but the engine says `column2`, not
    // `column1`. A best-effort list would print the wrong name.
    mount(
      () =>
        Promise.resolve(
          dupHeaderResult({
            sniff: {
              ...dupHeaderResult().sniff,
              columns: [
                { name: 'id', type: 'BIGINT' },
                { name: 'column2', type: 'VARCHAR' },
                { name: 'id_1', type: 'BIGINT' },
              ],
            },
          }),
        ),
      'idle',
      DUP_HEADER,
    )
    await waitForSample()
    await waitForLimit()
    expect(screen.queryByTestId('csv-review-rename-list')).toBeNull()
    expect(textOf('csv-review-meaning-renames')).toContain(APPROVED.headerRenames)
  })

  it('never shows a list from a head that holds no complete record', async () => {
    mount(
      () => Promise.resolve(dupHeaderResult()),
      'idle',
      // No record terminator inside the file at all.
      'id,,id',
    )
    await waitForSample()
    await waitForLimit()
    expect(screen.queryByTestId('csv-review-rename-list')).toBeNull()
  })

  it('never shows a limit sentence while the head read is still in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mount(() => Promise.resolve(dupHeaderResult()), 'idle', DUP_HEADER, gate)
    // Before the derivation settles the behaviour sentence stands ALONE: no
    // list and no limit sentence, so a pending read is never read as a refusal.
    await waitForSample()
    expect(screen.queryByTestId('csv-review-rename-list')).toBeNull()
    expect(textOf('csv-review-meaning-renames')).toBe(APPROVED.headerRenames)
    release()
    await waitForList()
  })

  it('has no list when the file has no header row to rename', async () => {
    mount(
      () =>
        Promise.resolve(
          dupHeaderResult({
            sniff: {
              ...dupHeaderResult().sniff,
              hasHeader: false,
              columns: [
                { name: 'column0', type: 'VARCHAR' },
                { name: 'column1', type: 'VARCHAR' },
                { name: 'column2', type: 'VARCHAR' },
              ],
            },
          }),
        ),
      'idle',
      DUP_HEADER,
    )
    await waitForSample()
    await waitForLimit()
    expect(screen.queryByTestId('csv-review-rename-list')).toBeNull()
  })

  it('has no list when the reader skipped rows before the header', async () => {
    mount(
      () =>
        Promise.resolve(dupHeaderResult({ sniff: { ...dupHeaderResult().sniff, skipRows: 1 } })),
      'idle',
      DUP_HEADER,
    )
    await waitForSample()
    await waitForLimit()
    expect(screen.queryByTestId('csv-review-rename-list')).toBeNull()
  })

  it('has no list when a declared column map replaced the reader naming', async () => {
    mount(
      () =>
        Promise.resolve(
          dupHeaderResult({
            effectiveOptions: { columns: { id: 'BIGINT', column1: 'VARCHAR', id_1: 'BIGINT' } },
          }),
        ),
      'idle',
      DUP_HEADER,
    )
    await waitForSample()
    await waitForLimit()
    expect(screen.queryByTestId('csv-review-rename-list')).toBeNull()
  })

  /**
   * The fixed marker shape this surface is allowed to hang off an element: its
   * own `csv-review…` `data-testid` names. Nothing here is ever derived from the
   * file — an option key (`csv-review-effective-sample_size`) is engine
   * configuration, and no other value exists.
   */
  const SURFACE_MARKER = /^csv-review-[a-z0-9_-]+$/

  /** Every `data-*` attribute currently mounted inside the dialog. */
  function dataAttributes(): Attr[] {
    return Array.from(dialogElement().querySelectorAll('*')).flatMap((element) =>
      Array.from(element.attributes).filter((attribute) => attribute.name.startsWith('data-')),
    )
  }

  /**
   * The needle half of the privacy check: no `data-*` attribute VALUE may
   * contain header text or the picked file's name. `needles` must carry BOTH
   * halves of the disclosure — the rename ORIGINALS (including the `(empty
   * name)` placeholder an empty original renders as) and the RENAMED names —
   * because a leak of either names a column in a place that can be copied,
   * logged or scraped. An empty needle is skipped: `''` is a substring of
   * every value and would assert nothing.
   */
  function assertNoHeaderTextInDataAttributes(needles: readonly string[]): void {
    const text = needles.filter((needle) => needle !== '')
    const leaked = dataAttributes()
      .filter((attribute) => text.some((needle) => attribute.value.includes(needle)))
      .map((attribute) => `${attribute.name}=${attribute.value}`)
    expect(leaked).toEqual([])
  }

  /**
   * The structural half — the part a needle list cannot do. A header original
   * is often an ordinary word (`id`) or empty, so the shape is pinned instead:
   * every `data-*` attribute in the surface must be one of its own fixed
   * `data-testid` markers, which no file content can ever match.
   */
  function assertOnlySurfaceMarkers(): void {
    const foreign = dataAttributes()
      .filter(
        (attribute) => attribute.name !== 'data-testid' || !SURFACE_MARKER.test(attribute.value),
      )
      .map((attribute) => `${attribute.name}=${attribute.value}`)
    expect(foreign).toEqual([])
  }

  it('keeps header text on screen only: no console sink, no data-* attribute', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    )
    mount(() => Promise.resolve(quotedNewlineResult()), 'idle', QUOTED_NEWLINE)
    await waitForSample()
    await waitForList()
    // Non-vacuity: the header text really is rendered — both the ORIGINALS of
    // the listed pairs (one of them empty ⇒ `(empty name)`) and the renamed
    // names the list promises.
    expect(screen.getAllByTestId('csv-review-rename-original').map((e) => e.textContent)).toEqual([
      'id',
      APPROVED.renameEmpty,
    ])
    expect(surfaceText()).toContain('line')
    expect(surfaceText()).toContain('a,b')
    // …and none of it reaches a console sink…
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
    }
    // …and no `data-*` attribute carries it (ADR 0025). The quoted-newline
    // fixture's OWN header texts (`a,b`, `line\none`) are needles alongside
    // the listed pairs' originals (`id`, the empty placeholder) and the renamed
    // names (`id_1`, `column4`) — both halves, not just the renamed half.
    assertNoHeaderTextInDataAttributes([
      // rename originals
      'a,b',
      'line\none',
      'id',
      APPROVED.renameEmpty,
      // renamed names
      'id_1',
      'column4',
      // the picked file's name
      'picked-source-name',
    ])
    assertOnlySurfaceMarkers()
  })

  it('keeps the empty-name original off every data-* attribute too', async () => {
    // `dup-header.csv`: the listed pairs are `(empty name) → column1` and
    // `id → id_1`, so the ORIGINAL half is exactly the empty placeholder plus
    // the ordinary word `id` — the case a renamed-name needle list cannot see.
    mount(() => Promise.resolve(dupHeaderResult()), 'idle', DUP_HEADER)
    await waitForSample()
    await waitForList()
    expect(screen.getAllByTestId('csv-review-rename-original').map((e) => e.textContent)).toEqual([
      APPROVED.renameEmpty,
      'id',
    ])
    assertNoHeaderTextInDataAttributes([
      APPROVED.renameEmpty,
      'id',
      'column1',
      'id_1',
      'picked-source-name',
    ])
    assertOnlySurfaceMarkers()
  })
})

describe('CSV review — the prohibited wording (ADR 0049 item 6)', () => {
  it('never describes a sample as validated/checked/verified/confirmed, in a successful state', async () => {
    mount()
    await waitForSample()
    // The sample rendered and its cap is stated, and the surface still claims
    // no verdict about the data — anywhere.
    expect(surfaceText()).not.toMatch(PROHIBITED_WORDING)
  })

  it('still claims nothing after a stale edit and a refusal', async () => {
    mount()
    await waitForSample()
    change('csv-review-sample-size', '-1')
    await waitFor(() => {
      expect(screen.getByTestId('csv-review-refusal')).toBeTruthy()
    })
    expect(surfaceText()).not.toMatch(PROHIBITED_WORDING)
  })
})

describe('CSV review — the option form composes through the engine vocabulary', () => {
  it('dispatches the typed option set on Update sample', async () => {
    const harness = mount()
    await waitForSample()
    change('csv-review-delim', ';')
    change('csv-review-header', 'no')
    change('csv-review-all-varchar', 'yes')
    change('csv-review-sample-size', '10')
    fireEvent.click(button('csv-review-update'))
    await waitFor(() => {
      expect(harness.calls).toHaveLength(2)
    })
    expect(harness.calls[1]?.options).toEqual({
      header: false,
      delim: ';',
      all_varchar: true,
      sample_size: 10,
    })
  })

  it('refuses an out-of-budget inference sample before dispatch, naming the key', async () => {
    const harness = mount()
    await waitForSample()
    change('csv-review-sample-size', '-1')
    const refusal = textOf('csv-review-refusal')
    expect(refusal).toContain(APPROVED.refusalPrefix)
    expect(refusal).toContain('CSV option sample_size = -1')
    expect(refusal).toContain(APPROVED.refusalSuffix)
    expect(button('csv-review-update').disabled).toBe(true)
    expect(harness.calls).toHaveLength(1)
  })

  it('refuses a malformed types line with its own sentence and never echoes it', async () => {
    mount()
    await waitForSample()
    change('csv-review-types', 'id BIGINT')
    const refusal = textOf('csv-review-refusal')
    expect(refusal).toBe(
      `${APPROVED.refusalPrefix}${APPROVED.typesLineError}${APPROVED.refusalSuffix}`,
    )
    expect(refusal).not.toContain('id BIGINT')
  })

  it('refuses a repeated column name: nothing is dispatched, adoption is blocked', async () => {
    // B01 regression: the parser used to assign `columns[name] = type` per
    // line, so `id: BIGINT` followed by `id: VARCHAR` silently declared only
    // VARCHAR. The repeat is now refused before dispatch — and the refusal is
    // value-free, so neither the column name nor either type appears.
    const harness = mount()
    await waitForSample()
    change('csv-review-types', 'id: BIGINT\nid: VARCHAR')
    const refusal = textOf('csv-review-refusal')
    expect(refusal).toBe(
      `${APPROVED.refusalPrefix}${APPROVED.duplicateColumnError}${APPROVED.refusalSuffix}`,
    )
    expect(refusal).not.toContain('id')
    expect(refusal).not.toContain('BIGINT')
    expect(refusal).not.toContain('VARCHAR')
    // A refusal blocks the re-read and the adoption; the settled sample on
    // screen is untouched (the review opens nothing in the first place).
    expect(button('csv-review-update').disabled).toBe(true)
    expect(button('csv-review-adopt').disabled).toBe(true)
    fireEvent.click(button('csv-review-update'))
    expect(harness.calls).toHaveLength(1)
    expect(harness.onAdopt).not.toHaveBeenCalled()
  })

  it('sends a declared column map when the lines are well formed', async () => {
    const harness = mount()
    await waitForSample()
    change('csv-review-types', 'id: BIGINT')
    fireEvent.click(button('csv-review-update'))
    await waitFor(() => {
      expect(harness.calls).toHaveLength(2)
    })
    expect(harness.calls[1]?.options).toEqual({ columns: { id: 'BIGINT' } })
  })
})

describe('CSV review — adoption carries exactly the reviewed set, exactly once', () => {
  it('is disabled until a preview settles, then adopts the previewed options', async () => {
    const harness = mount()
    expect(button('csv-review-adopt').disabled).toBe(true)
    await waitForSample()
    expect(button('csv-review-adopt').disabled).toBe(false)
    fireEvent.click(button('csv-review-adopt'))
    expect(harness.onAdopt).toHaveBeenCalledTimes(1)
    // Nothing was set, so the adoption carries an empty (no-option) set.
    expect(harness.onAdopt.mock.calls[0]?.[0]).toEqual({})
  })

  it('drops sample_size from the adopted set (ADR 0049 item 1)', async () => {
    const harness = mount()
    await waitForSample()
    change('csv-review-delim', ';')
    change('csv-review-sample-size', '10')
    fireEvent.click(button('csv-review-update'))
    await waitFor(() => {
      expect(button('csv-review-adopt').disabled).toBe(false)
    })
    fireEvent.click(button('csv-review-adopt'))
    expect(harness.onAdopt).toHaveBeenCalledTimes(1)
    expect(harness.onAdopt.mock.calls[0]?.[0]).toEqual({ delim: ';' })
  })

  it('adopts at most once even if the control is activated twice', async () => {
    const harness = mount()
    await waitForSample()
    fireEvent.click(button('csv-review-adopt'))
    fireEvent.click(button('csv-review-adopt'))
    expect(harness.onAdopt).toHaveBeenCalledTimes(1)
  })

  it('blocks adoption while the form no longer matches the sample on screen', async () => {
    const harness = mount()
    await waitForSample()
    expect(button('csv-review-adopt').disabled).toBe(false)
    change('csv-review-delim', ',')
    expect(button('csv-review-adopt').disabled).toBe(true)
    expect(textOf('csv-review-stale')).toBe(APPROVED.stale)
    fireEvent.click(button('csv-review-adopt'))
    expect(harness.onAdopt).not.toHaveBeenCalled()
  })

  it('states the mode-appropriate adoption promise', async () => {
    mount(undefined, 'replace')
    await waitForSample()
    expect(textOf('csv-review-adopt-helper')).toBe(APPROVED.adoptHelperReplace)
    expect(button('csv-review-adopt').textContent).toBe(APPROVED.adopt)
  })

  it('states the idle adoption promise by default', async () => {
    mount()
    await waitForSample()
    expect(textOf('csv-review-adopt-helper')).toBe(APPROVED.adoptHelperIdle)
  })
})

describe('CSV review — the failure surface (ADR 0048 / EW-03D D10)', () => {
  it('uses the engine first line with the operation framing, and drops the rest', async () => {
    mount(() =>
      Promise.reject(
        new Error('CSV Error on Line: 5: expected 3 values per row\nLINE 1: SELECT * FROM x'),
      ),
    )
    await waitFor(() => {
      expect(screen.getByTestId('csv-review-failure')).toBeTruthy()
    })
    const failure = textOf('csv-review-failure')
    expect(failure).toBe(
      'The preview could not be read: CSV Error on Line: 5: expected 3 values per row. Nothing was opened.',
    )
    expect(failure).not.toContain('LINE 1')
  })

  it('degrades the opaque bundle error to a value-free refusal, never a classification', async () => {
    mount(() => Promise.reject(new Error('_setThrew is not defined')))
    await waitFor(() => {
      expect(screen.getByTestId('csv-review-failure')).toBeTruthy()
    })
    expect(textOf('csv-review-failure')).toBe(
      'The preview could not be read: the engine reported an error. Nothing was opened.',
    )
  })

  it('blocks adoption after a failed read', async () => {
    mount(() => Promise.reject(new Error('CSV Error on Line: 5')))
    await waitFor(() => {
      expect(screen.getByTestId('csv-review-failure')).toBeTruthy()
    })
    expect(button('csv-review-adopt').disabled).toBe(true)
  })
})

describe('CSV review — abandonment and late results', () => {
  it('reports Stop through the abandonment handler', async () => {
    const harness = mount()
    await waitForSample()
    fireEvent.click(button('csv-review-stop'))
    expect(harness.onStop).toHaveBeenCalledTimes(1)
  })

  it("treats Escape's native cancel as Stop", async () => {
    const harness = mount()
    await waitForSample()
    fireEvent(dialogElement(), new Event('cancel', { cancelable: true }))
    expect(harness.onStop).toHaveBeenCalledTimes(1)
  })

  it('drops a late result that resolves after a newer read', async () => {
    const held: Array<(result: EngineCsvPreviewResult) => void> = []
    mount((call) => {
      if (call.options === undefined) return Promise.resolve(previewResult())
      return new Promise<EngineCsvPreviewResult>((resolve) => {
        held.push(resolve)
      })
    })
    await waitForSample()
    change('csv-review-delim', ',')
    fireEvent.click(button('csv-review-update'))
    change('csv-review-delim', '|')
    fireEvent.click(button('csv-review-update'))
    await waitFor(() => {
      expect(held).toHaveLength(2)
    })
    // The NEWER read settles first, the older one after it. Each settlement runs
    // inside `act`, which flushes the continuation microtask, so the older
    // result is actually APPLIED before the assertion — that is what makes the
    // generation guard observable: removing it lets the older view overwrite
    // the newer one and this assertion fails (`{ delim: ',' }` vs `'|'`).
    await act(async () => {
      held[1]?.(previewResult({ previewId: 'p3', effectiveOptions: { delim: '|' } }))
    })
    expect(textOf('csv-review-effective-delim')).toBe('|')
    await act(async () => {
      held[0]?.(previewResult({ previewId: 'p2', effectiveOptions: { delim: ',' } }))
    })
    expect(textOf('csv-review-effective-delim')).toBe('|')
  })

  it('never renders a late result after abandonment', async () => {
    const held: Array<(result: EngineCsvPreviewResult) => void> = []
    const errorSpy = vi.spyOn(console, 'error')
    const harness = mount((call) => {
      if (call.options === undefined) return Promise.resolve(previewResult())
      return new Promise<EngineCsvPreviewResult>((resolve) => {
        held.push(resolve)
      })
    })
    await waitForSample()
    change('csv-review-delim', ';')
    fireEvent.click(button('csv-review-update'))
    await waitFor(() => {
      expect(held).toHaveLength(1)
    })
    fireEvent.click(button('csv-review-stop'))
    expect(harness.onStop).toHaveBeenCalledTimes(1)
    // The surface the late read would overwrite is the INITIAL one (no option
    // composed ⇒ the explicit "no option was set" line). Settling the held read
    // inside `act` flushes its continuation, so a removed abandonment bump
    // paints the late view here and this assertion catches it.
    expect(screen.getByTestId('csv-review-effective-none')).toBeTruthy()
    await act(async () => {
      held[0]?.(previewResult({ previewId: 'p9', effectiveOptions: { delim: ';' } }))
    })
    expect(screen.queryByTestId('csv-review-effective-delim')).toBeNull()
    expect(screen.getByTestId('csv-review-effective-none')).toBeTruthy()
    // Nothing was adopted, and nothing reached a console sink.
    expect(harness.onAdopt).not.toHaveBeenCalled()
    expect(button('csv-review-adopt').disabled).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('is silent when a read settles after the surface is gone', async () => {
    const held: Array<(result: EngineCsvPreviewResult) => void> = []
    const errorSpy = vi.spyOn(console, 'error')
    const harness = mount((call) => {
      if (call.options === undefined) return Promise.resolve(previewResult())
      return new Promise<EngineCsvPreviewResult>((resolve) => {
        held.push(resolve)
      })
    })
    await waitForSample()
    change('csv-review-delim', ';')
    fireEvent.click(button('csv-review-update'))
    await waitFor(() => {
      expect(held).toHaveLength(1)
    })
    fireEvent.click(button('csv-review-stop'))
    // The production path: the parent removes the surface on `onStop`.
    harness.unmount()
    await act(async () => {
      held[0]?.(previewResult({ previewId: 'p9', effectiveOptions: { delim: ';' } }))
    })
    expect(screen.queryByTestId('csv-review')).toBeNull()
    expect(harness.onAdopt).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('CSV review — privacy (ADR 0025)', () => {
  it('never renders the picked file name or its extension', async () => {
    mount()
    await waitForSample()
    expect(surfaceText()).not.toContain('picked-source-name.csv')
    expect(surfaceText()).not.toContain('.csv')
  })

  it('never writes a dataset value to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    )
    mount()
    await waitForSample()
    // The sample carries 'alpha' and '2'; none of it reaches a console sink.
    expect(surfaceText()).toContain('alpha')
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('withholds a sample whose columns disagree with the disclosure', async () => {
    mount(() =>
      Promise.resolve(
        previewResult({
          sample: { batch: sampleBatch([['only-one']]), hasMore: false, rowCap: 50 },
        }),
      ),
    )
    await waitFor(() => {
      expect(screen.getByTestId('csv-review-sample-mismatch')).toBeTruthy()
    })
    expect(textOf('csv-review-sample-mismatch')).toBe(APPROVED.sampleMismatch)
    expect(screen.queryByTestId('csv-review-sample-table')).toBeNull()
  })
})

describe('CSV review — the form controls and their labels', () => {
  it('labels every option control the vocabulary exposes', async () => {
    mount()
    await waitForSample()
    const form = textOf('csv-review-options')
    expect(form).toContain(APPROVED.optionsHeading)
    expect(form).toContain(APPROVED.optionsScope)
    const labelled: readonly (readonly [string, string])[] = [
      ['csv-review-delim', APPROVED.delimLabel],
      ['csv-review-header', APPROVED.headerLabel],
      ['csv-review-all-varchar', APPROVED.allVarcharLabel],
      ['csv-review-sample-size', APPROVED.sampleSizeLabel],
      ['csv-review-nullstr', APPROVED.nullstrLabel],
      ['csv-review-dateformat', APPROVED.dateformatLabel],
      ['csv-review-quote', APPROVED.quoteLabel],
      ['csv-review-escape', APPROVED.escapeLabel],
      ['csv-review-comment', APPROVED.commentLabel],
      ['csv-review-skip', APPROVED.skipLabel],
      ['csv-review-types', APPROVED.typesLabel],
    ]
    for (const [testId, label] of labelled) {
      expect(screen.getByLabelText(label)).toBe(screen.getByTestId(testId))
    }
    expect(textOf('csv-review-delim-helper')).toBe(APPROVED.delimHelper)
    expect(textOf('csv-review-sample-size-helper')).toBe(APPROVED.sampleSizeHelper)
    expect(textOf('csv-review-types-helper')).toBe(APPROVED.typesHelper)
    expect(selectOptions('csv-review-header')).toEqual([APPROVED.unset, APPROVED.yes, APPROVED.no])
    expect(selectOptions('csv-review-all-varchar')).toEqual([
      APPROVED.unset,
      APPROVED.yes,
      APPROVED.no,
    ])
    expect(button('csv-review-update').textContent).toBe(APPROVED.update)
    expect(button('csv-review-stop').textContent).toBe(APPROVED.stop)
  })
})
