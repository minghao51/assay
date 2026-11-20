# @assay/data-sources

Adapters that produce `DataHandle`s from files, directories, and (later)
remote systems. The `DataSource`/`DataHandle`/`DataSourceMetadata` interfaces
mirror docs/architecture/01-architecture.md §6.

Two entry points:

- **`@assay/data-sources`** (root, `src/index.ts`) — environment-neutral:
  only the portable interfaces. Packages export raw TypeScript source, so
  importers type-check this module under their own compiler options; the
  root entry therefore stays DOM-free (`@assay/engine` imports it without a
  DOM lib).
- **`@assay/data-sources/browser`** (`src/browser.ts`) — everything that
  names DOM types (`File`, `FileSystemFileHandle`, `document`). Import from
  DOM-typed contexts only (web app, webview, harness).

The browser entry ships (M1-3):

- **`BrowserFileSource`** — a `DataSource` for one local file, constructed
  from either a `FileSystemFileHandle` (File System Access API) or a `File`
  (`<input type="file">` fallback). Local-first by construction (ADR 0001):
  it only holds references the user already granted; no bytes are read here
  and nothing is logged — not even file names (ADR 0025).
- **`detectFileSystemCapabilities`** — capability detection (roadmap risk R5):
  `{ filePicker, dataTransferHandle }`, each `true` only when the
  corresponding API exists as a function. The inspected globals are
  injectable (`FileSystemCapabilityScope`) for tests.
- **`pickDataFile`** — one entry point to ask the user for a single file.
  Returns `{ via, source: BrowserFileSource }`, or `null` when the user
  cancels. Both browser touch-points (`showOpenFilePicker`, the hidden-input
  DOM flow) are injectable for Node tests and dialog-free e2e.

## Fallback matrix (risk R5)

| Environment                                     | `showOpenFilePicker` | `DataTransferItem.getAsFileSystemHandle` | `pickDataFile` strategy                                     |
| ----------------------------------------------- | -------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Chromium / Edge / other Chromium-based browsers | ✅                   | ✅                                       | File System Access picker                                   |
| Firefox                                         | ❌                   | ❌                                       | hidden `<input type="file">`                                |
| Safari                                          | ❌                   | partial (versions vary)                  | hidden `<input type="file">`                                |
| Non-browser (Node, SSR) or missing DOM          | —                    | —                                        | rejects with a clear error unless dependencies are injected |

The hidden-input fallback resolves on the input's `change` event; user-cancel
resolution uses the input's `cancel` event (Chromium 113+, Firefox 91+). On
engines without `cancel` the promise stays pending — the same trade-off most
picker libraries make.

## Documented semantics

- **Identity:** one `BrowserFileSource` instance ⇔ one immutable
  `sourceId` (`crypto.randomUUID()` at construction). `open()` is idempotent —
  every call returns the same frozen `DataHandle`. Re-picking the same file
  creates a new source with a new id: no persistent file identity is claimed,
  because that would require persistent browser storage (ADR 0017 allows it
  for disposable caches only).
- **Snapshot and retry (Q3):** the underlying `File` is acquired lazily
  through **one in-flight attempt** (`handle.getFile()` on the FSA path; the
  given `File` on the fallback path). Concurrent `open()`/`metadata()`/
  `getFile()` calls share that attempt and all observe its outcome.
  - A **failed** attempt is deliberately retryable: the error propagates
    unchanged to every waiting caller, the attempt is retired _only while it is
    still the cached attempt_ (so an older rejection can never clear a newer
    one), and the next call starts one fresh attempt. A source therefore never
    caches a permanent failure — callers that want to give up point at a new
    source.
  - A **fulfilled** attempt is retained for the instance's lifetime: its
    `File` is never re-fetched because the file changed on disk, so
    `open()`/`metadata()` keep observing one consistent snapshot.
  - A synchronous `getFile()` throw is captured into the same attempt path, so
    the accessor never throws synchronously.
  - Nothing is logged on either path — not even the file name (ADR 0025).
- **Metadata without reads:** `metadata()` uses `File.size` (plain file
  metadata) and the file-name extension. Extension rules (case-insensitive,
  last extension only): `parquet`, `jsonl`, `json`, `csv`, `arrow`,
  `feather`; anything else — including compressed names like
  `data.parquet.gz` — is `'unknown'`. `rowCount`/`partitions` stay unset;
  engines fill them (task M1-4). Unknown formats do not block `open()`;
  engines decide whether they can read a file.
- **Handle opacity:** `DataHandle` stays `{ kind: 'data-handle', sourceId }`;
  engines get byte access from the source/file they already hold (M1-4), not
  through the handle.

## Harness (M1-3 e2e)

`harness/` builds a dialog-free proof page (`vite build` → served by the root
Playwright config on port 4180, see `tests/e2e/data-sources.spec.ts`):

- **FSA path:** the page synthesizes a _real_ `FileSystemFileHandle` without
  a native dialog — staging the fixture bytes in the origin's private OPFS
  sandbox (`navigator.storage.getDirectory()` → `getFileHandle(…, {
create: true })` → `createWritable()`) and taking the genuine
  `FileSystemFileHandle` from it — and injects it as the picker's
  `showOpenFilePicker` into `pickDataFile`, exercising the genuine FSA
  branch. (The often-cited `DataTransfer` → `getAsFileSystemHandle()` trick
  does not yield a handle for JS-constructed `File`s — Chromium resolves
  `undefined`; see `harness/main.ts`. OPFS use here is a disposable e2e
  cache, within ADR 0017's allowance.)
- **Fallback path:** injects capabilities with `filePicker: false`, forcing
  the package's hidden-input implementation; Playwright intercepts the file
  chooser (`page.waitForEvent('filechooser')` → `chooser.setFiles(...)`).

The harness also hosts the **shared data-source behavior suite** (task T3):
one button per scenario runs the suite from `@assay/testing` against the real
`BrowserFileSource` via the subject adapter in `src/behavior-subject.ts`, with
genuine OPFS-staged handles and real browser capability globals;
`tests/e2e/data-source-behavior.spec.ts` asserts each scenario's result and
evidence. This locks the m1-3/m1-4 semantics (identity/idempotency, one-shot
`getFile`, metadata = format+size, cancel → `null`, capability matrix, R5
fallback order) and the B06/Q3 acquisition-retry contract (one shared in-flight
attempt, exactly one retry after a failure, a retained fulfilled snapshot, a
captured synchronous throw, and no name logging) against regression.

`harness/public/customers.csv` is a byte-identical copy of the canonical
`fixtures/csv/customers.csv` (sha-256 `202ea367…`), kept inside the harness so
the e2e can fetch it from the page origin. Not a new top-level fixture.
