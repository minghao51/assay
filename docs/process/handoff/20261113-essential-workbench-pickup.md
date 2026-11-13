# Essential workbench — first-wave approval and cold pickup

**Date:** 2026-11-13. **Planning baseline:** `5466470`, clean at authoring start.
**Start here:** this record → [implementation specification](../../product/16-essential-workbench-first-wave-spec.md)
→ the row's read list. This is the dispatch/authority index for the new first wave, not a claim of runtime
completion. The prior [proposal](../../product/15-essential-workbench-enhancements.md) and
[comparison](../../reviews/2026-11-12-essential-workbench-comparison.md) explain why these rows matter.

**Visual companion (2026-11-13; design only):** the
[four-board SVG pickup](../../../assests/svg/essential-workbench/README.md) maps illustrated states to
these tasks and the specification. Read the text contract first. Reviewed targets are not shipped UI;
proposed CSV/bulk controls do not resolve technical gates. The drawings are not a prerequisite for WF-06
or permission to widen a reservation.

## 1. Dated scope approval

The maintainer reviewed the proposal and instructed: **“lets proceed with your recommendations … is there
a implementation and specification handoff that another agent can pick up?”** This selects the proposal's
recommended **first investment**, preserving its explicit design-first gates:

- **EW-01 / WF-06:** implement the existing verified session-replacement contract, after fresh preflight,
  independent review and the reservation below. This supplies the previously missing runtime selection.
- **EW-02:** commission the source-backed exact scope/copy specification first (**EW-02D**). Its runtime
  successor (**EW-02I**) waits for the returned exact table's acceptance and a named brief.
- **EW-03D and EW-04D:** commission CSV interpretation and deterministic bulk-repair **designs**, including
  bounded disposable probes using existing installed APIs. These are not import/bulk runtime approvals.

The instruction is not blanket approval of all EW-01…08 implementations or every possible operation. It
does not decide still-open trim/NULL/collision policy, CSV API/lifetime choices, compact atomic undo,
new protocols or new persistent formats. EW-05…08 and all unnamed WF/WFD/engine/persistence/format work stay
unselected. No push, publication, dependency, telemetry-semantic or visibility change is authorized.

**Authority order:** accepted ADRs → this dated selection → specification §2–§3/v5 integration
clarifications → the rest of the inherited WF-05 v5 contract → proposal/research/historical pickups.
The specification's IC-01…05 resolve only named implementation/test shorthand, not product-policy changes.
For any other contradiction, stop and request an amendment; do not choose the easiest interpretation.

## 2. Current task register — one runtime writer, not eight parallel features

Selected is not gated-ready, and delivered design is not implemented code. States:
`SELECTED → CLAIMED → IN REVIEW → INTEGRATING → CLOSED/DELIVERED`; `BLOCKED` names the dependency.
Only one web-runtime row may be CLAIMED. This table owns the current status; older WF manifests link here.

| Task                             | Scope / done-when                                                                                                       | Status / dependency                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **EW-00 baseline/preflight**     | Record current clean SHA, delta from `5466470`, tools/ports, full runtime baseline gates and decision/reservation check | **SELECTED — first executable action; not run by this documentation handoff**              |
| **WF-06 (= EW-01)**              | Implement spec §3 and WF-05 v5, C1–C16/G/T/N/K coverage plus IC-01…05; worker + independent reviewer + merged gates     | **SELECTED — runtime authorized; BLOCKED on green EW-00 and a filled dispatch envelope**   |
| **EW-02D**                       | Deliver exact source-backed per-surface copy/state/placement/test table, retaining already-honest labels                | **SELECTED — design only; current clean source baseline required**                         |
| **EW-03D**                       | Deliver CSV interpretation/browser-exposure/ownership contract and decision/probe/fixture ledger                        | **SELECTED — design/probes only; current clean source baseline required**                  |
| **EW-04D**                       | Deliver scalar-text trim/mapping representation/atomicity/undo contract and decision/probe/fixture ledger               | **SELECTED — design/probes only; current clean source baseline required**                  |
| **EW-02I**                       | Implement only accepted EW-02D copy/scope; preserve underlying semantics                                                | **BLOCKED — exact returned contract/copy acceptance + new runtime brief + fresh baseline** |
| **EW-03I / EW-04I**              | Possible future import/bulk runtime slices, not reserved                                                                | **BLOCKED — returned design, unresolved choices/ADRs and explicit runtime selection**      |
| **EW-10 first-wave integration** | Trace selected runtime and design deliverables, all failures/reviews/merged evidence and residuals                      | **SELECTED — pending WF-06 merged-green + EW-02D/03D/04D delivery**                        |
| **EW-05…08**                     | Quality-feedback extensions, recipes, new export scopes, checkpoints                                                    | **UNSELECTED — proposal only**                                                             |

Recommended execution: verify/claim EW-00 → dispatch WF-06 as the only runtime writer → independent review
→ merge/re-run gates → EW-10 record. Read-only EW-02D/03D/04D can proceed against pinned committed sources
while a writer works in its isolated checkout; they do not edit source/shared docs. Their final reservations
must be rebased/rechecked after WF-06, whose App/editor changes they must not overwrite. Do not hold up
WF-06 for later import/bulk runtime implementation.

## 3. Baseline and role setup — do this before claiming code

The recorded `5466470` is an inspected planning anchor, **not assumed execution HEAD**. The new handoff commit
will be later and docs-only. A successor must record its own exact clean committed SHA, inspect the delta,
and run fresh gates. There is no fresh runtime-green claim in this pack. Historical counts in the WF record
must not be pasted as new observations.

```bash
git status --short
git rev-parse HEAD
git diff --name-status 5466470..HEAD
node --version
pnpm --version
# Verify the configured DuckDB CLI and Playwright/browser installation locally.
# Do not install/upgrade a different version or silently change the lockfile.
```

If the checkout is dirty, identify ownership and stop; never reset/stash/delete another agent's work. If
production changed after the planning anchor, re-read affected modules, update citations and revalidate the
contract before claiming. A semantic mismatch is an amendment, not an excuse to follow old line numbers.

**Orchestrator** owns shared docs/CHANGELOG, task status, baseline ledger, dispatch envelopes and integration.
**Worker** changes only one approved row in its isolated worktree, verifies/commits it and returns evidence.
**Independent reviewer** is another session/model and cannot have authored that candidate. Preferred worker:
`opencode-go/deepseek-v4.1-flash`; reviewer: `openai-codex/gpt-6-luna` with explicit **xhigh**. If unavailable,
request a roster change rather than silently using the implementer to approve itself.

Fill a concrete dispatch envelope outside the repo before the worker starts:

```text
Row / exact authority + spec + unchanged constraints:
Baseline SHA / clean-tree proof / delta reviewed / EW-00 log paths:
Worker agent + model / reviewer agent + model + thinking:
Branch / isolated worktree / free port triples (stock/configured/restored):
Allowed paths + named behavior / forbidden paths / fixture inputs:
Required focused assertions, full gates, telemetry legs and negative controls:
Stop conditions / expected commit+changeset / report location:
```

Use a unique row branch/worktree from the verified baseline; do not copy another dirty checkout. Example
names: branch `feat/wf-06-session-preservation`, sibling worktree `../dataworkbench-wf-06`. Discover existing
names first; never force-remove a worktree. Baseline tests run before claim; **no production editing in EW-00**.

## 4. Copyable row briefs

### 4.1 WF-06 worker — runtime selected, no guard redesign

```text
Implement WF-06 only. Read AGENTS.md, current handoff, operating model,
20261113-essential-workbench-pickup.md, product/16 §1–3 + §7–8,
and ALL of 20261110-wf05-replacement-contract.md. Read v1 §9 only for the
original cases, superseded where v5/spec say so. Read the actual current
App, editor/session, schema and provider modules before editing.

Use the orchestrator-filled baseline/worktree/ports/reservation, not an
assumed HEAD. No code until EW-00 is green. Reservation = product/16 §3.4,
including the named new tests and IC-01/02 reporting seams. No packages,
exporter, session-reset/types, telemetry, config, fixtures or unrelated
assertion changes. A newly needed caller/type/helper/fixture is a stop and
scope amendment, not inherited permission.

Preserve the live ready session until fully prepared adoption. Dirty-only
native guard, clean-path preservation too. Gate synchronously from refs,
including boolean editor and ALL pending cast checks; rendering mirrors
must clear notices without an unrelated rerender. Refuse pending work;
do not await before the FSA picker or auto-resume later. Candidate-local
empty overlay only. Rebind only after reset+republish. Adopt synchronously
once; no model refresh, second worker, reopen or release API. Export-first
ends intent and stays; no autosave or false saved claim. C1–C16 exact.

Cover all applicable G/T/N/K cases and IC-01..05. Preserve legacy idle,
open/export/history/validation suites. New distinct-schema fixtures may be
temporary files generated by the new test, or reuse unmodified generators;
committed goldens need a named reservation before source editing.

Run the full row gates and configured/restored telemetry legs. Return a
Conventional Commit, one @assay/web changeset (include ADR0047 retention),
exact commands/exits/counts and failures, focused evidence, limitations,
and clean-tree proof. Never push or approve your own candidate. If A1,
notice clearing, aggregate gate authority or preservation cannot be proved
within scope, stop; do not ship a confirmation over destructive ordering.
```

### 4.2 EW-02D design worker

Read product/15, product/16 §2/§4 and the comparison's actual-scope inventory; then current Profile/SQL/
Pipeline binding/Validation/Diff/Export components and their tests. Produce the exact table required in
spec §4. Return **retain** where copy is already sufficient. Include data states, DOM placement, literal
assertions, no-extra-engine-call proof, existing approval collisions and a minimal future file reservation.
Do not add run-origin metadata, change tasks/headings or select WF-O1/O2/07 implicitly. No implementation.

### 4.3 EW-03D design worker

Read product/16 §5 and ADRs 0012/0017/0029/0047; inspect `packages/engine-duckdb/src/` reader/client/protocol/
executor/registry/worker-core plus the browser open/source path. Deliver all contract/decision/test sections
specified there. Use installed browser WASM APIs for permitted probes; CLI is a comparison control only.
Explicitly evaluate typed columns; a successful count is not exhaustive conversion proof. No presumed
release primitive, settings-loop registrations or sample-as-full-validation claim. No production/fixture/
protocol edits. Return unresolved options and a recommended design for approval, not a new importer.

### 4.4 EW-04D design worker

Read product/16 §6 and ADRs 0003/0011/0012/0029/0030; inspect current domain EditOp/overlay/history/identity,
engine overlay wire/query, web edit publication/provider. Compare bounded compact representations, joint
host/worker atomic publication, exact undo/refolding, prior edits/inserts/deletes and stale/volatile filter
membership. Return exact trim/mapping/NULL/collision/no-op choices as **recommendations awaiting decision**,
not approved defaults. No per-cell JS batch, invented APIs, partial apply, arbitrary scripts or new op
implementation. Stop if bounded atomicity cannot be established; return the architecture split.

### Design artifact ownership and permitted probes

Design workers write only `/tmp/assay-ew/{row}-contract.md` and associated temporary evidence. Orchestrator
reviews/integrates accepted documents under proposed final paths
`docs/process/handoff/20261113-ew02-scope-contract.md`,
`20261113-ew03-csv-contract.md`, `20261113-ew04-bulk-contract.md` (not created/delivered by this handoff).
Each artifact records its exact baseline, source anchors, commands, recommendations, open decision owner
and explicit **design-only** status. No blanket block is removed by delivering a document.

Permitted probes are disposable, bounded synthetic `/tmp` data/scripts, existing installed APIs and existing
local harness/reader assets. They may query/create disposable scratch relations inside an isolated probe
engine; they never use the user's live session or real files. No repository source/test/config/fixture,
lockfile, dependency or API change; no installs, dataset upload, real collector or dataset-bearing network
request. Telemetry endpoint/token unset. Stop and report if an existing local harness cannot support the
probe without source modifications or unapproved network. Record native-versus-browser versions, projection
limits, resource bounds and incomplete cases. This permission is not runtime implementation or a benchmark.

## 5. Verification runbook

### 5.1 Stock baseline / worker / reviewer / integrated runtime gates

In a clean reserved checkout, with free ports assigned per envelope (examples below are **templates**):

```bash
set -euo pipefail
unset ASSAY_TELEMETRY_ENDPOINT ASSAY_TELEMETRY_TOKEN ASSAY_NO_TELEMETRY
export DUCKDB=/tmp/duckdb
export ASSAY_E2E_PORT_WEB=4273 ASSAY_E2E_PORT_ENGINE=4279 ASSAY_E2E_PORT_DS=4280
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm exec turbo run typecheck --force
pnpm test
pnpm test:coverage
pnpm exec turbo run build --force
pnpm docs:links:check
pnpm adr:index:check
CI=1 pnpm exec playwright test --retries=0
```

`--force` is Turbo cache bypass, never a forced browser interaction. Preserve historical failures; don't
retry to green, widen timeout or add skip/allowlist. Capture every exit/count/coverage/result/log path,
including zero-cache evidence for forced tasks. Focused tests supplement, not replace, the full suite.

### 5.2 Configured telemetry and restored stock — mandatory for WF-06

App/modal/CSS changes require **both** legs in
[product/14 §6.2](../../product/14-web-interface-followup-spec.md#62-configured-and-restored-telemetry-legs).
Use the exact invalid collector endpoint and existing route-aborting harness; install routes **before first
navigation**, no token, zero deliveries. Check both configured theme and Help-disclosure discovery.

```bash
env -u ASSAY_TELEMETRY_TOKEN -u ASSAY_NO_TELEMETRY \
  ASSAY_TELEMETRY_ENDPOINT=https://collector.example.invalid/ingest \
  pnpm --filter @assay/web build
grep -rl 'collector.example.invalid/ingest' apps/web/dist/assets >/dev/null
# Set the envelope's free configured ports; example 4373/4379/4380.
CI=1 pnpm exec playwright test -c tests/visual/playwright.telemetry.config.ts --retries=0

unset ASSAY_TELEMETRY_ENDPOINT ASSAY_TELEMETRY_TOKEN ASSAY_NO_TELEMETRY
# Only generated output in THIS reserved checkout; never source/user work.
rm -rf apps/web/dist
pnpm --filter @assay/web build
if grep -rl 'collector.example.invalid/ingest' apps/web/dist/assets; then
  echo 'Configured endpoint remained in stock output' >&2
  exit 1
fi
# Set the envelope's free restored ports; example 4473/4479/4480.
CI=1 pnpm exec playwright test \
  tests/e2e/telemetry.spec.ts tests/e2e/theme.spec.ts tests/e2e/a11y.spec.ts \
  tests/e2e/workbench-help.spec.ts tests/e2e/workbench-tasks.spec.ts \
  tests/e2e/workbench-visibility.spec.ts tests/e2e/shell.spec.ts \
  tests/e2e/replace-guard.spec.ts --retries=0
```

Do not accept cached stock output as the configured leg. Record endpoint presence then absence, discovered
spec names/pass counts, aborted attempts/zero delivered requests and restored results. Repeat the required
verification at worker, independent review and integration stages, not just the initial baseline.

### 5.3 Reviewer and integration brief

Independent reviewer reads actual changed modules/tests and the filled envelope, v5 plus spec IC-01…05.
Run required gates independently against the exact candidate. Verify capture-before-reset, isolation,
sequence/phase checks, ref-versus-render authority, dirty semantics, notices/focus, modal/export behavior,
C14 leak controls and source bytes. Mutation controls must separately falsify the handler guard, overlay
isolation and a pending-work/notice rule; native modality/disabled attributes/synthetic clicks are different
proofs. Restore byte-identically and rebuild before browser rechecks. Report unrun/unreachable cases; no
false OS cancellation, freed-table or persisted-download proof.

Return `VERDICT: approve` or `VERDICT: request-changes` with precise findings, command exits/counts, failure
and mutation/restoration evidence. Do not implement a fix in the reviewing session. Orchestrator integrates
only the reviewed commit, re-runs merged gates and records the row immediately. Any post-review source/test
fix returns to independent review; no quiet test-pin adjustment.

Prose-only rows: `pnpm format:check`, `pnpm docs:links:check`, `pnpm adr:index:check`, `git diff --check` plus
source/probe/decision review. No fresh runtime claim from documentation gates.

## 6. Stop rules and reporting ledger

Stop on unknown authority/copy/operation semantics, a dirty or changed baseline, failing gates, unavailable
review lane, out-of-reservation caller/type/helper/fixture, new protocol/engine/release requirement, lost
session/overlay isolation, ambiguous identity, or unproven atomicity. Keep the row BLOCKED/in progress with
the exact question; never call a partial implementation completed. Do not weaken the product promise to
avoid a blocker. If scope must split, return the split for approval.

For every row record:

```text
Row + selected requirements / authority + contract version:
Baseline / worker / independently approved / integrated SHAs:
Role/model/thinking / worktree/ports / reservation and prior amendments:
Actual changed paths / fixture provenance / source-byte proof:
Commands + exits/counts/coverage / logs / failed runs and causes:
Focused cases + negative controls / restoration/build proof:
Configured endpoint present + zero deliveries / restored endpoint absent:
Delivered design vs implemented behavior / remaining open decisions:
Limitations (picker/native persistence/retention/RD-T07 etc.):
Status / next row / cleanup / no-push statement:
```

EW-10 closes only this selected denominator. Design delivery does not authorize EW-02I/03I/04I, and the
prior WF-10 selected-subset closure stays historical and closed. No all-EW, all-temporal, offline, AT,
publication or remote-CI success claim.

## 7. Paste this to the next orchestrator

```text
Pick up docs/process/handoff/20261113-essential-workbench-pickup.md.
Read AGENTS.md, docs/process/handoff.md and the operating model, then this
handoff, product/16-essential-workbench-first-wave-spec.md and the full
WF-05 v5 contract before claiming WF-06. Keep
assests/svg/essential-workbench/README.md open as the visual task map;
the text contract wins over any drawing. The maintainer selected first-wave
recommendations on 2026-11-13. Runtime selection = WF-06 only for now;
EW-02D/03D/04D are design-first, not implementations of all EW candidates.

Check the current exact clean baseline and delta from 5466470; run EW-00
fresh gates (do not reuse November counts). Fill the concrete envelope,
then dispatch one isolated WF-06 writer and independent Luna xhigh reviewer.
Use the explicit file reservation, IC-01..05 and full stock/configured/
restored evidence. Read-only design agents may work on pinned sources;
they return exact contracts/choices before any successor runtime is claimed.
If acting as worker rather than orchestrator, execute ONLY the dispatched
row; do not approve yourself or edit shared paperwork.

Preserve prior decisions, immutable source/export bytes, task semantics,
temporal fidelity and ADR0047 retention honesty. No hidden runtime/API/
fixture/dependency/config expansion, forced clicks, weakened gates or
push/publication. Return explicit blockers instead of choosing missing policy.
```

## 8. Pack verification versus execution evidence

This handoff authors specifications and dispatch boundaries only. EW-00 and WF-06 have **not** run in this
session; no new full-runtime baseline or implementation result exists. Pack review/documentation gate
results are recorded at integration, separately from future runtime row evidence. All new design artifacts
and runtime branches named above are future outputs, not files claimed to exist or tasks claimed completed.

**Pack review:** independent `openai-codex/gpt-6-luna`, explicit **xhigh**, returned **APPROVE** after reading
the full new specification/handoff, inherited contract and relevant production seams. No critical finding;
one non-blocking stale WF-06 authorization sentence in the older handoff queue was corrected to point here.
This approves the pickup boundary, **not** a runtime implementation or fresh baseline.

**Documentation verification:** root format check, relative-link check (**150 files / 0 broken links**),
ADR-index check (**47 records**) and diff whitespace check pass. Active LSP inspection found five ambiguous-
link warnings on unchanged older WF map/approval links (same baseline references); the repository link
checker resolves them. New specification/pickup files had no warning/error findings. No code/package/test/
fixture/config/dependency/ADR change, runtime-suite run or push was performed while preparing this pack.
