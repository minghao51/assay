# PT-V Slice 2 — Desktop Dataset Workflows

**ACTIVE — authored 2026-10-14.** Maintainer authorized the recommended
maintenance → PT-V slice 2 → PT-Q sequence on 2026-10-14. Entry: `980a22b`,
clean tree; [repository maintenance](20261014-repository-maintenance.md) closed.
Scope comes from [slice-1 §5](20261002-ptv-slice1-queue.md#5-closure).
This queue is not a declaration that slice 2 or the PT-V exit is delivered.

## 1. Execution and evidence

Serialized rows; `openai-codex/gpt-6-luna` implements in isolated worktrees,
parent orchestrates, independently reviews, re-runs gates and cherry-picks.
Follow [operating model](operating-model.md); never implement and approve the
same code. Parent owns shared docs, root test/workflow integration and closure.
Maintainer authorized a normal `main` push after ptv2-2 completion on
2026-10-14. Publication, credential work and other human G0 actions remain
unauthorized; workers still must not push.

Baseline: **2947 tests / 180 files**, coverage **89.16/83.33/89.22/90.73**
(thresholds unchanged), typecheck 20, build 12, browser e2e **172 + 1 skip**,
9 native runtime-policy tests, real-VSCode e2e 5 scenarios and offline harness
14 headline pins; changesets 154, doc links 106/0, ADRs 46. Remote CI has not
run. Use `DUCKDB=/tmp/duckdb` (1.5.5) for every relevant unit/coverage/e2e run;
do not first run without it and mask environment failures as successful proof.

## 2. Implementation defaults and STOP boundaries

These are bounded UI/integration defaults, not new dataset/engine semantics:

- **Desktop webview only** (D18); vscode-web remains RE-SCOPE. Preserve the
  vendored assets/checksums, measured CSP, blob-worker bootstrap, pinned
  VS Code 1.130.0 runtime and missing-extension/EH-boot negative drills.
- Reuse the real `DuckDbEngineClient` (D13), domain history/overlay functions,
  headless grid, contract/validation/diff compilers. Do not wire the orphaned
  `DataEngine` target or copy domain semantics into a surface (ADR 0008).
- Source assets stay immutable (ADRs 0011/0012). Edits are **session-scoped
  overlays**, not an in-place custom-document save implementation. Clearly
  label that closing the view discards unexported edits. Native dirty-document
  persistence/close veto is not promised; if required, STOP and scope it
  separately instead of pretending a read-only custom editor provides it.
- Export means a **new local file**, not merely an OPFS scratch path. Host owns
  destination selection; no source/other existing file overwritten, even under
  races. Cancellation is not success. No silent fallback to a download or
  `workspace.fs` overwrite. Non-file destination schemes are explicitly out of
  this slice unless a safe create-only adapter is separately agreed.
- Git context is **informational**: branch + current file's working-tree status,
  unavailable/no-repository states included. Dataset diff explicitly compares
  two selected supported datasets; no implicit HEAD/blob/revision lookup, Git
  mutation, source identity inferred from Git, or remote connector work.
- Shared-column key selection uses explicit selection and a **confirm-to-run**
  action. Inference is a disclosed proposal only; never auto-run an inferred
  key. Edit/stage generation changes mark existing reports stale and prevent
  late async results attaching to another session.
- Paths remain host-side; webview receives neutral format names, bytes and
  path-free typed errors. Local verdict/sample UI treats values as untrusted
  text. No telemetry/consent change, contents/paths/results in logs or CI
  evidence, `innerHTML`, formula-unsafe CSV or dependency-direction violations.
- No new runtime/build dependencies or accepted ADR rewrites. Existing
  workspace packages/test tools may be declared where actually consumed;
  propose lockfile/config changes for parent integration. If shared extraction
  needs a durable architecture change or export cannot safely cross OPFS →
  host, STOP with a narrow proposal before implementing a workaround.

## 3. Serialized task rows

Each code row requires relevant format/lint/typecheck/unit/coverage/build,
links/ADR checks, changeset, real-host proof for changed integration and
failure-sensitive negative pins. Parent repeats the proofs; no row closes on
worker claims or cached/no-diagnostic LSP output alone.

### ptv2-1 — Pure bridge helpers and real unit coverage

**Scope:** `apps/vscode/src/dataset.ts`, new `src/pure/**`, tests, minimal app
metadata; propose root `vitest.config.ts`/lockfile hunks for parent. Keep
host-only `vscode` APIs out of pure modules. Extract neutral format/name mapping
and typed path-free error contracts, retaining compatibility re-exports for
current harness consumers. These are surface helpers, not a reason to move
VS Code types into `domain` or an arbitrary new shared package.

**Done-when:** root Node Vitest actually discovers the new app pure tests;
format aliases, unsupported names, neutral-name/path-free-error guarantees
pinned. Deliberate wrong format/neutral-name mutation fails. No fixture,
vendor, CSP or real open-flow behavior change; existing real-host e2e/offline
harness and native runtime-policy tests green. Keep coverage's broad include
and thresholds; do not remove host modules from the denominator.

**Status:** **DONE — `dddd902`, parent approve 2026-10-14.** Pure format/name
and bridge contracts extracted with compatibility exports; 13 tests in two
files really execute in root Vitest. Parent wrong-neutral-name mutation fails;
all gates, forced types, 9 native policy tests, 5 real-host scenarios, 14
headline pins and browser e2e 172+1 independently reproduced. Unit **2960/182**,
coverage **89.23/83.34/89.32/90.80**, changesets 155; merged core gates green.

Merged-run deviation: first default unit run had 2 CLI 5-second timeouts; the
next had 8 existing CLI/fuzz/DuckDB 5-second timeouts during unrelated
`rustc`/`cc1plus` host contention. Affected CLI suites passed isolated (41/41),
the unchanged complete suite passed with `--maxWorkers=2`, then the normal
default suite passed **2960/182** after contention subsided. No timeout,
coverage threshold, test case or source fix was used to obtain green. Keep the
recorded host-load watch; do not kill other users' jobs.

### ptv2-2 — Overlay editing, history and grid projection

**Depends on:** ptv2-1. **Scope:** app pure edit controller, `webview/dataset.ts`,
`engine-session.ts`, `grid-provider.ts`, `data-grid.ts`, styles and targeted
real-host tests. Domain `appendOp`/`undo`/`redo`/`stateAtCursor` and engine overlay
schema/count/range/cast checks already exist; reuse them. Provider currently
reads base ranges and must switch to effective view + stable logical row IDs.

**Done-when:** cell edit, insert/delete row, dirty markers, undo/redo and branch
truncation work on the real grid, including sorted/filtered logical-row
identity. Engine rejection does not advance history or hide the error;
failed/no-op operations and rapid async transitions have pure regression pins.
Source bytes remain unchanged. Session-only warning is visible. Existing
keyboard/a11y, bounded DOM and measured grid envelope remain green; no claim
of persistent overlays, schema editing or native save integration.

**Status:** **DONE 2026-10-15 — `3ac2c63` + `0361e1b` + `4c57032` + `0711b3c`,
parent request-changes → corrections → independent approve.** Real logical-id
overlay reads, scalar edit/insert/delete, dirty cell/row markers, history and
session-only warning integrated. Failed casts retain the previous view;
preflight uses whole-view engine cast checks, not a sampled filtered window.
Native editor keys cannot delete rows or navigate the grid; queued undo/redo
steps resolve against current history. Host proof is test-mode-only and an
exact boolean projection. No dependency, vendor, CSP or golden-fixture change.

Parent reproduced all gates + forced types (20), unit **2977/184** including
**30 pure app tests**, coverage **89.22/83.31/89.26/90.81**, build **12**,
browser **172+1**, native **9**, real-host **6 scenarios**, offline **15 pins**
(14 existing + editing-path assertion). Real-host source hash remains unchanged.
Parent 1M-row editing-enabled measure: **236 ms** first row, **0 bytes** heap
page delta against the unchanged **2.28 MB** ceiling, bounded **31 rows**.
Final merged all core gates + real-host/offline green; changesets **156**.

Failure sensitivity: parent restoring old history logic fails **2/10** tests;
disabling full cast loop and rebuilding fails specifically the hidden 48-row
cast-refusal invariant. Worker identity/undo/dirty-annotation mutants fail;
restored source green. Early real-host helpers raced on refreshed row-cache
readiness; initial parent cast mutant failed at that unrelated race, not the
intended gate, and one worker intermediate mutant passed. None were accepted
as proof: waits now consume rendered logical rows, before-action revisions
and actual dirty markers; final worker repeated **6 times**, parent repeated
**3 times** plus follow-up/main runs, all green. Nonfatal EMFILE watcher
warnings retained in logs; no deadline, coverage or grid budget weakened.

**Editor limits:** binary, temporal, composite/enum/unfamiliar scalar types and
Arrow decimal/128-bit word-array types (DECIMAL/NUMERIC/HUGEINT/UHUGEINT)
remain explicitly read-only pending lossless codecs. BIGINT/UBIGINT exact text
and supported strings/booleans/finite floating inputs remain editable. The
read-only-cell dirty-marker branch has a bounded real-renderer DOM assertion
with a structural provider, in addition to real engine edit acceptance. No
native dirty-document save or export delivery is promised by this row.

**Push evidence / external blocker:** normal `main` push at `3a3a94b` verified
remote SHA equality and 0/0 divergence, including 218 prior commits plus the
five editing/closure commits. [CI run 38615821301](https://github.com/minghao51/assay/actions/runs/38615821301)
has three failed jobs with **zero steps**: GitHub reports account payment or
spending-limit restriction. No source gate ran remotely; local row verification
is complete, remote-green evidence remains blocked on human
[M6](../manual-actions.md). No workflow/secret/billing workaround authorized.

### ptv2-3 — Deliver edited exports to a new file

**Depends on:** ptv2-2. **Scope:** app export controller/typed host bridge,
OPFS scratch read/delivery adapter and real-host tests. `client.exportView`
returns `{path, format, rowCount, bytes}` in OPFS, NOT host destination bytes.
First demonstrate that the existing same-origin webview can read the worker's
scratch output. If it cannot, STOP and propose a narrow engine-owned seam.

**Done-when:** active overlay exports through the existing engine format
semantics, then transfers bytes to a host-selected **create-only** local
file; typed correlation, size/order/bounds validation, cancellation/disposal
and partial-write cleanup are tested. Bound memory/transfer chunks rather than
turning a large export into an unbounded JSON number array. Existing files,
source aliases and raced destination creation are refused, never overwritten.
Reopen exported copies to prove values/schema/count agreement; CSV formula
safety preserved. Scratch generation alone never produces a success message.

**Status:** PENDING.

### ptv2-4 — Validate the effective view

**Depends on:** ptv2-3. **Scope:** contract selection/read bridge and webview
validation controller/view; declare existing `@assay/contracts` and
`@assay/validation` dependencies as needed. Use the existing parser/compiler
and `client.validate(handle, plan, overlay)` rather than a parallel validator.

**Done-when:** explicit contract selection → compile → local verdicts/bounded
samples → edit → revalidate, with exact counts and logical-row navigation.
Report/export metadata honestly marks stale results. Parse/compile/engine
failure, cancelled selection, empty/bad inputs and late results are pinned;
contents/errors cannot escape into operational logs. Real-host proof shows
validation sees inserted/edited/deleted effective rows, not the base only.

**Status:** PENDING.

### ptv2-5 — Share canonical diff report projection

**Depends on:** ptv2-4. **Scope exception:** `packages/diff/**`, CLI
`report-diff.ts`, web `diff-export.ts` and their tests, package/app changesets;
no other feature work. ADR 0008 allows extracting pure shared report logic.
Existing CLI and web envelopes deliberately differ in surface metadata:
CLI version + a/b basenames versus web stale flag; do NOT call them byte-equal
or silently change either contract.

**Done-when:** shared pure/types-only projection/verdict helpers live in the
allowed library and existing CLI/web adapters preserve their exact JSON byte
contracts (ordering, rounding, newline, anchor-free keys, inference evidence,
truncation/counts). Surface metadata remains outside the shared semantic core.
No package→app or engine/browser/React imports; no copied third serializer in
VS Code. Existing cross-surface agreement, real-DuckDB fixtures, packed CLI
consumer and browser exports remain green. Parent byte/metric mutation bites.

**Status:** PENDING.

### ptv2-6 — Staged diff with confirmed keys and report agreement

**Depends on:** ptv2-5. **Scope:** typed comparison-file bridge, app diff
controller/view and report delivery using ptv2-3's safe destination adapter.
Use stage/profile/schema diff/inference and `compileRowDiffPlan` + client diff;
consume the shared projection from ptv2-5.

**Done-when:** stage/replace comparison, select/disclose/confirm keys, execute
row diff against current A overlay, navigate bounded samples and export the
same verdict/report. Key names may contain commas/quotes; no string-split
identity shortcut. Unconfirmed/invalid/duplicate/null keys, mismatched schema,
malformed/stale/late operations and engine failure are pinned. A fresh baseline
report agrees with installed CLI on all common semantic fields (known
surface-only metadata excluded explicitly), including identical, schema-only,
profile-only, added/removed/changed, empty/no-comparable and nested fixtures.
Edited-view reports set `baseViewOnly: false`; compare CLI against the exported
effective copy for that leg. Staleness is disclosed, not silently removed.

**Status:** PENDING.

### ptv2-7 — Git context and dataset diff command

**Depends on:** ptv2-6. **Scope:** app host Git adapter/command registration,
package contributes and targeted real-host tests. Use the installed built-in
Git extension API or a bounded argument-vector adapter, never shell strings.
Treat extension/repository API results as untrusted typed input.

**Done-when:** context shows branch/file state without raw paths in the
webview; absent Git/no repository/untracked/dirty and workspace transitions
have honest states. `Assay: Compare datasets` / `assay.dataset.diff` accepts
explicit two URIs or two cancellable dataset picks and reaches the same
confirmed-key diff controller. No comparison runs before confirmation; no
Git/source mutation, implicit revision fetch or stale cross-panel context.
Real-host test uses a synthetic local repository and checks source bytes.

**Status:** PENDING.

### ptv2-8 — Desktop exit acceptance and small UI polish

**Depends on:** ptv2-7. **Scope:** existing real-VSCode e2e/exit harnesses,
bounded error/a11y polish exposed by acceptance, proposed CI assertions and
parent-owned docs. Do not hide failures by raising time/heap/DOM limits.

**Done-when:** reproduce MVP scenario 11 on the real installed extension:
open → edit → undo/redo → validate → confirmed-key diff → deliver report/new
copy → CLI agreement, with immutable sources, offline vendored engine and
text-only cells. Include cancellation/refusal/late-result drills; disabling
editing, dropping overlay from validation/diff/export, bypassing confirmation
or corrupting report metrics must fail the relevant assertions. Root build,
all core gates/coverage, browser e2e, native policy tests, real-host scenarios
and existing 14-pin harness remain green; new acceptance assertions are in
CI's real-host job, not an unattached local script. Record exact counts,
limits, commits, deviations and independent reviewer approval. Parent closes
slice 2 only after this row; remote CI status remains unclaimed until run.

**Status:** PENDING.

## 4. Closure and next lane

**Not closed.** ptv2-1 foundation and ptv2-2 overlay editing are integrated;
ptv2-3…ptv2-8 remain pending. Next dispatch is ptv2-3 safe new-file export,
not the exit harness or PT-Q cleanup. Validation/diff/Git workflows and export
delivery are not yet implemented. Per-row evidence belongs
here; closure updates the living handoff,
roadmap, app README and changelog. After ptv2-8, dispatch **q-5b e2e helpers**
and **q-7 slice-2 strictness** separately under
[PT-Q §7](../../product/04-post-mvp-track.md#7-pt-q--quality--maintenance-lane).
Private registry policy and human launch gates remain outside this queue.
