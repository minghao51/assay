# ADR 0047: Web session replacement retains retired engine tables

## Status

Accepted

## Date

Proposed 2026-11-10 → Accepted 2026-11-10

## Deciders

- Maintainer (delegated sign-off recorded in
  [the web follow-up approval record](../process/handoff/20261110-web-followup-approval.md); design in
  [WF-05](../process/handoff/20261110-wf05-replacement-design.md) §12)

## Context

The web surface opens one dataset per session and keeps the live session — engine table, provider, viewport
model, overlay history — for as long as a task surface is ready. Making dataset replacement honest (WF-05)
requires the current session to survive picker cancellation and candidate-open failure, which means a
candidate table can be registered while the old one is still live and being rendered.

`@assay/engine-duckdb` exposes **no per-table release**: `dispose()` is terminal and reclaims the whole engine
instance and every registered view/file (`packages/engine-duckdb/src/client.ts:1030-1038`). Independent review
of the WF-05 design established three facts at the current revision:

1. every successful adoption retires an old table that cannot be released (`client.ts:1030-1038`,
   `App.tsx:1261-1267`);
2. any failure **after** `engine.open` succeeds — schema, row count, viewport-model load, bottom-panel
   preload — reaches the open chain's catch without releasing that table (`App.tsx:1680-1717, 1733-1751`;
   `engine-executor.ts:476-499` rolls back only registration-time failures);
3. stale-chain returns after a newer open or `cancelOpen` drop a chain holding a registered handle
   (`App.tsx:1684, 1690, 1692, 1709, 1715`), so today's code already leaks tables without any replacement
   feature.

Retention is therefore unbounded across repeated replacements and retries until the worker is torn down. The
choice was to add an engine release primitive (a package/protocol change with its own design, test and review
budget) before any replacement guard ships, or to accept the retention explicitly and record it.

## Decision

We accept unbounded in-process table/file retention for the web session-replacement path, and we do **not**
add a per-table release primitive under this decision. The replacement feature owns _not manufacturing_
additional retirements: one pending intent at a time, no Cancel during candidate open, and no adoption
without an isolated candidate overlay. This ADR clears only the lifetime question; it does not authorize the
WF-06 runtime row.

## Consequences

### Positive

- Replacement safety can ship without an engine or protocol change, and without a hidden second worker.
- A cancelled picker, and any candidate failure **before** registration, costs nothing new: the live session
  and its table are untouched.
- The guard can make an honest promise ("this session is unchanged") because preservation comes from ordering
  and ownership, not from a dialog.
- The limitation is written down instead of being inferred from a design summary.

### Negative / risks

- Resident memory and file handles grow with each successful replacement and with each post-open failure or
  retry, for the lifetime of the worker; a long session that replaces large datasets repeatedly holds every
  retired table until teardown.
- Nothing reclaims a retired table's memory on demand, so a future release primitive would be a behaviour
  change: supersede this ADR rather than rewriting it.
- The leak is invisible to the user and to telemetry (no counts, filenames or paths are emitted), so it will
  only surface as memory pressure in long sessions.

### Neutral

- No dataset content leaves the machine; no persistence, autosave or session-restore guarantee is implied.
- CLI and VS Code surfaces are unaffected: they open one dataset per process and terminate.
- Validation/diff/pipeline/report/DCR/export byte formats are untouched.

## Alternatives considered

- **Add `releaseTable`/`closeTable` to the engine protocol first.** Rejected for now: it is a package and
  protocol change with its own design, conformance and review cost, and the replacement guarantee does not
  depend on it. It remains the better long-term fix, and is the natural trigger for superseding this ADR if
  retention becomes observable.
- **Keep today's destroy-before-acquire ordering.** Rejected: it destroys a _clean_ ready session when the
  picker is cancelled, and no dialog can mitigate a session that is already gone.
- **Restrict replacement to the idle screen only.** Rejected: that removes a shipped capability instead of
  making it honest.
- **Rely on page reload to reclaim memory.** Not a decision: a reload loses the working session, which is
  precisely the loss the guard exists to prevent.
