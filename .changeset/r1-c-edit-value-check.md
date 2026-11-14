---
'@assay/engine-duckdb': patch
'@assay/web': patch
---

fix(r1-c): refuse a staged cell-edit value the engine cannot convert **before
anything is activated**. The commit's `refresh()` only reads metadata
(`schema()` + `rowCount()`), which never evaluates an edited value, so with
honest engine messages (R1-A) a bad edit committed and the conversion failure
only surfaced later as retryable `!` cells with no message.

`@assay/engine-duckdb`: `composeOverlayCastCheckSql` now omits its un-edited
base arm when that arm is **provably empty** — when the folded effective column
still carries its base column's type and the check targets that same type, every
non-NULL base value already has it, so only a pending cast (an effective/target
type that differs from the base type) can make base values fail. Those shapes
keep the full scan, the `LIMIT 1` early exit and the insert arms, so a cast
pre-check is unchanged, while a same-type cell-value check composes **no
per-row base predicate** (no `TRY_CAST(<base> …)` and no `NOT IN (…)` arm): what
remains is one predicate per edit plus the ordinal subquery and `LIMIT 1`. Unit
tests byte-pin all three shapes and prove the behaviour against the pinned DuckDB
CLI (a bad edited literal is still found with the arm elided; a bad base value is
still found with the arm retained).

`@assay/web`: `CommitEffects`/`commitWithRollback` gain an optional `validate`
that runs before `setActive`; a rejection means "refused, nothing applied" and
reuses the existing rejection framing (no new copy, no rollback, no refresh).
The editing session wires it for `cell-set` only, and every history-changing
gesture now runs through **one serialized mutation chain** (cell edits, insert,
delete, rename, undo, redo, the selective cursor move, and the cast append),
reading the live history when its task runs. That is what makes the ordering
load-bearing rather than hopeful: a cell edit takes its engine verdict and then
activates inside a single chain task, so no other activation can land in
between — there is no retry loop and **no reachable path that activates a staged
edit value without a verdict**. The edited column's **effective** type is read
from the domain fold of the prospective overlay and `overlayCastCheck` is asked
whether that type rejects any value; the refusal summary is shared with
`engineErrorSummary`'s fallback through one exported constant. A replaced table
drops the in-flight check on **either** outcome — a resolved verdict and a
rejected one alike — with nothing activated, nothing refreshed and no stale edit
(a rejection without a replacement is still framed; the only abort there is);
`row-insert` stays uncovered (v1 inserts carry empty values; the later cell-sets
on them are checked). Pins: three overlapping hostile edits are all refused with
no history entry and no refresh, two overlapping valid edits land in order, and
an undo issued during a check waits for the chain instead of racing it. The e2e
engine-rejection pin now asserts the pre-activation refusal: the observed exact
alert text, no `_setThrew`, no failed window/retry, an unchanged staged count,
and a following valid edit that still commits.
