# Invalid fixtures

Deliberately invalid inputs, kept tiny and synthetic. They exist so the
workbench's *failure* surfaces have a committed pin instead of being exercised
only through fakes.

| File | Purpose |
| --- | --- |
| `corrupt.parquet` | Plain text behind a `.parquet` name: the engine's Parquet reader refuses it with a "no magic bytes" diagnostic. Pins the open-failure recovery path (UG-5): one-line human cause, `Choose a different file…` retry, raw engine detail behind a `<details>` disclosure. |

These files deliberately live outside `fixtures/parquet/`, whose
`manifest.json` is verified bidirectionally against the *generated* golden
Parquet corpus (`packages/testing/src/fixtures.test.ts`). A corrupt file is not
a golden fixture and must never enter that manifest.

Never add real or sensitive data here — synthetic only.
