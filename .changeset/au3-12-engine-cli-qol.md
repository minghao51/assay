---
'@assay/engine-duckdb': patch
'@assay/cli': patch
---

chore(au3-12): engine + CLI QoL residue batch.

**engine-duckdb**

- Document the deliberate CSV **no-BOM** policy next to the header guard: exports stay byte-stable for golden/conformance fixtures and programmatic consumers; an Excel double-click BOM is a non-goal, never emitted.
- Fix the `TableRegistry.reserve()` doc comment (`confirm()` → `remove()`; no `confirm()` method exists).
- Document the `-0`→`+0` normalization at the single SQL-literal boundary (`String(-0) === '0'`), consistent with `JSON.stringify(-0) === '0'`; pinned for both `cellLiteralSql`/`cellLiteralRawSql`.
- **Fail-first disposal:** a permanent sentinel now makes `dispose()` terminal even when it races an in-flight boot. A boot reply arriving after disposal can no longer resurrect the client to `'ready'`; post-dispose calls reject with the existing typed `EngineDisposedError`, and the in-flight boot settles harmlessly.
- Document the `streamFirstBatch` cancel-failure policy: `reader.cancel()`/`cancelSent()` cleanup is best-effort and never masks the op's result or original error; pinned with failure-injection tests.

**cli**

- Stamp a `reportVersion` field (the CLI package version, the same source `--version` prints) into every `--format json` envelope (validate/profile/diff).
- `validate` now rejects extra positionals with the same usage-error idiom as `profile`/`diff` (`validate takes exactly one dataset path (got N)`, exit 2).
- Align `NO_COLOR`/`FORCE_COLOR` with the ecosystem convention: `NO_COLOR` (any value, including empty) disables color; `FORCE_COLOR` `''`/`0`/`false` disables it, and any other `FORCE_COLOR` value forces color on a terminal (beating `NO_COLOR`). Non-TTY output stays plain. Help text updated.
