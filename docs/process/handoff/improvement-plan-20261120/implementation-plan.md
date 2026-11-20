# Assay — concrete fixes, maintainability and quality-of-life plan

**Baseline:** `e68bde91d32b38a854c9fa573819a34ee418135f`.
**Status:** planning deliverable; no repository implementation, tests, builds or deployment performed.
**Primary evidence:** `/tmp/assay-audit-phase1/discovery-report.md`, the 15 accepted reviews under its `semantic/` directory, and this bundle's `evidence-notes.md`.
**Audience:** a new orchestrator plus one scoped implementer and an independent reviewer per runtime task.

## 1. Outcome and limits

Make Assay easier to understand and safer to maintain without rebuilding it: accurate pickup documentation; predictable failure/retry and export lifetimes; unambiguous CSV configuration; small ownership-focused modules; reproducible local development; and clearer distinctions between queued work, UI cancellation and completed delivery.

This plan distinguishes:

- **CORRECTION:** directly observed disagreement, ambiguity or incomplete failure boundary; still add a reproducing regression before altering runtime behavior.
- **HARDENING:** proposed stronger contract for a source-observed edge; not a reproduced user incident or vulnerability.
- **REFACTOR:** preserve behavior, bytes, lifetimes, import direction and UI; no new feature implied.
- **DESIGN:** return a decision/specification first. No implementation until its named decision is selected.
- **VERIFICATION:** produce fresh executable evidence; audit source reads and historical coverage were not gate runs.

Scheduling bands `W0…W4` below are recommended order, **not severity**. Requesting this plan does not select every proposed behavior, authorize gated work, approve publication, or change accepted ADRs. The next agent may perform read-only reconciliation; it must obtain a bounded execution selection before implementing any task. A selected small task does not authorize the rest of the wave.

### What good looks like

1. A cold agent can identify the current queue, supported development runtime, expected commands and owner of each state transition without following an obsolete prompt.
2. CSV type declarations cannot silently discard an earlier declaration; dialect disclosure agrees with the actual engine payload without breaking the rename-list reconstruction.
3. Export errors do not become success messages, acquisition failures close owned handles, and cleanup never makes an unsupported filesystem atomicity claim.
4. Repeated disposal callers observe one completion boundary; filter list replacement has an explicit whole-list contract rather than inferred transactionality.
5. Large modules have cohesive local owners, not an invented generic framework or app code pushed into scaffold packages.
6. Critical assurance tests can detect the specific regression they claim to guard; fakes, real engine/browser tests and historical records are clearly labelled.

## 2. Non-negotiable architecture and existing ownership

Read `AGENTS.md`, current handoff, roadmap §7 and applicable ADRs before each claim. Current authority at the baseline is the header and queue in `docs/process/handoff/20261118-post-ew03ia-pickup.md:3-8,48-63`, not its obsolete embedded prompts.

| Preserve | Consequence for this plan |
| --- | --- |
| ADR 0001/0012, immutable source + overlay | Never mutate an opened dataset in place. Preserve same-source refusal and browser-download fallback. No auto-adopt or history clearing after export. |
| ADR 0011 logical row identity | A viewport index is not a mutation key. Preserve row-ID anchors, ordinal semantics and undo/redo. |
| ADR 0025/0037/0045 privacy | No dataset values, sensitive filenames, SQL, raw engine payloads or paths in new telemetry/logging. No new telemetry event required by this plan. |
| ADR 0040 two worker lanes | UI invalidation is not worker interruption; do not add a hard-cancel promise or serialize away the registry lane. |
| ADR 0044 grid-centric shell | Keep persistent grid, task navigation, existing keyboard/focus/modal behavior and lazy boundaries. No central-grid replacement. |
| ADR 0047 retired tables | Retention is accepted, without a finite bound. No table-release API under a cleanup/refactor task. |
| ADR 0049 **amended option C** | Abandoned CSV preview keeps one slot until next preview, open or dispose; Stop invalidates delivery. ENG-1 is CLOSED, not a release implementation backlog. |
| ADR 0050/0051 repair | Exact undo-by-refold, stacked projection layers, linear emitted size and set-membership predicates stay. No re-nested CASE chains, lifted caps or unsupported heap guarantees. |
| Package direction | `domain` is external-dependency-free; `core` is not an engine/browser/UI dumping ground; packages never import apps. Do not populate scaffold `ui/core/security/ai/transforms` merely to shorten app files. |
| Closed WF-06, R1/R2, EW-02I/03I/04I, D3-1 | Session preservation, error honesty, scalar temporal display, CSV preview and bulk repair already exist. Strengthen bounded seams, do not reimplement the workflows. |
| TB-1/TB-2 closed | Eight-spawn pin exists. Do not redispatch it or tighten 45 s from a quiet-machine run; separate ceiling work requires fresh load ≥30 evidence. |
| ENG-2/ENG-3 unselected | Reuse these IDs if selected. ENG-2 count-op extraction is not implicit in an engine refactor; B02 coordinates ENG-3. |
| WF-O1/O2 and WF-03/04/07/08/09 | Optional UX changes require their existing design/selection steps. E04 is a design brief, not a back door to runtime. |
| Publication/human gates | Changesets, private workspace dependencies and successful local pack tests do not establish registry distribution or G0 approval. No publish, remote collector probe or push. |

Accepted ADRs are not rewritten to make the audit disappear. Editorial discrepancies in accepted ADRs are explained in a linked current clarification/errata record; a durable changed decision uses the repository's ADR process. Existing dated amendments remain authoritative.

## 3. Decisions to record before their dependent task

All entries below are **recommendations**, not already accepted project policy. A maintainer/orchestrator records the chosen option in the queue before dispatch; architectural changes follow ADR process.

| Decision | Recommended default | Alternatives / bound | Gates |
| --- | --- | --- | --- |
| Q1 development Node support | Align contributor/tooling support with selected Node 24 (`^24.0.0` only if the locked package engines confirm that range). Keep runtime product constraints distinct. | Retain Node 22 only after choosing a compatible intersection, at least 22.13 on the 22 line, and testing the actual lower bound. Do not advertise arbitrary odd/future majors from `>=22`. | A03/A04 |
| Q2 duplicate CSV types | Refuse repeated exact parsed names, including identical type repeats, with a value-free line-level diagnostic. | Explicit last-wins is possible but must be disclosed, not silently retained. This plan recommends refusal. Names remain case-sensitive; do not invent case folding. | B01 |
| Q3 failed File acquisition | Prefer retry-on-rejection on the same BrowserFileSource, never refresh a fulfilled snapshot. | Preserve exactly-once attempted acquisition and make UI retry construct a new source. Source snapshot identity must be documented either way. | B06 |
| Q4 whole-list filters | Add an **optional atomic replaceFilters(list)** provider capability; retain a documented non-atomic legacy path. | Breaking mandatory migration is larger; automatic compensation cannot promise atomicity if restoration fails. | C01/C02 |
| Q5 callback faults | After C03a probes, keep session reset callbacks synchronous, explicitly nonthrowing by contract; on an unexpected fault invalidate/reset all dependents and fail closed rather than publishing ready. Commit activation exceptions get an explicit unknown/restoration-failed outcome. | Full rollback of arbitrary React callbacks is not feasible. Returning success after swallowing the fault is rejected. Final API/copy comes from C03a; approval gates C03b, not the read-only design itself. | C03b |
| Q6 telemetry opt-out | If selected, abort the active send and prevent retries after off/dispose; never claim already-sent bytes can be recalled. | Current policy can instead remain with an accurate in-flight limitation. No observed privacy incident justifies silently changing the contract. | E01 |
| Q7 larger UX work | Select **one** existing design row, recommended WF-O1 filter-draft clarity first. | WF-O2 requires nested/Record/SQL type propagation; no generic formatter sweep. | E04 |

## 4. Queue, dependencies and scope sizing

Every row is **PROPOSED**, not CLAIMED or READY. `S` = typically one bounded PR, `M` = multiple focused commits/PRs, `L` = split into the named children before dispatch; not a time or staffing promise. All runtime rows depend on A00 and an approved envelope. Root configuration/docs are orchestrator-owned even when listed as task targets.

| ID | Wave | Kind | Size | Deliverable | Additional prerequisites | Owner / primary boundary |
| --- | --- | --- | --- | --- | --- | --- |
| A00 | W0 | VERIFICATION | S | Fresh baseline and execution envelope | Scope selection for execution | Orchestrator, no product implementation |
| A01 | W0 | CORRECTION | M | Reconciled current docs and pickup index | A00 | Orchestrator, docs/root instructions |
| A02 | W1 | HARDENING | S | Narrow current-state drift checks | A01 | Orchestrator, scripts/docs tests |
| A03 | W0 | CORRECTION | M | Explicit dev/runtime support contract | A00, Q1 | Orchestrator, root configs/manifests/docs |
| A04 | W1 | HARDENING | S | Offline development preflight/doctor | A03 | Orchestrator, scripts |
| B01 | W1 | CORRECTION | S | Non-lossy CSV type declarations | Q2 | Worker, apps/web CSV |
| B02 | W1 | CORRECTION | M | ENG-3 dialect disclosure repair | ENG-3 selected + engine/web owners | Existing ENG-3, coordinated engine/web children |
| B03 | W1 | HARDENING | S | Browser writable failure lifecycle | A00 | Worker, apps/web export |
| B04 | W1 | HARDENING | M | Desktop create-only acquisition cleanup | A00 | Worker, apps/vscode pure writer |
| B05 | W2 | HARDENING | M | DCR partial-write policy | B04 design reviewed, CLI owner selection | Worker, apps/cli DCR writer |
| B06 | W2 | HARDENING | S | Recoverable file acquisition semantics | Q3 | Worker, packages/data-sources |
| C01 | W2 | DESIGN | S | Atomic filter-list contract/caller map | A00 | Grid owner design; app consumers read-only |
| C02 | W2 | HARDENING | L | Atomic capability and consumers | C01 accepted, Q4 | Grid → web → VS Code serial children |
| C03 | W2 | DESIGN | M | Reset/activation failure contract and probes | A00; Q5 gates C03b only | Web owner, two independently selected children |
| C04 | W1 | HARDENING | S | Shared engine disposal completion | A00 | Worker, packages/engine-duckdb client |
| C05 | W1 | VERIFICATION | S | Exact-value conformance integrity pin | A00 | Worker, packages/testing + harness spec reservation |
| D01 | W2 | REFACTOR | S | Honest contract text-read naming | A00 | Worker, apps/web contract import + callers |
| D02 | W3 | REFACTOR | L | Web ownership extraction | Relevant B/C fixes stable | apps/web, D02a/b/c serial |
| D03 | W3 | REFACTOR | L | Desktop bridge/controller extraction | B04 stable; C02 if selected | apps/vscode, D03a/b serial |
| D04 | W3 | REFACTOR | L | Engine handler/composer module seams | B02/C04 stable if selected | packages/engine-duckdb, D04a/b serial |
| E01 | W4 | DESIGN | M | Opt-out cancellation enhancement | Q6, explicit privacy-policy selection | Web, then separate CLI parity review |
| E02 | W4 | VERIFICATION | M | Dependency compatibility and bundle attribution | A03 | Tooling owner; targeted package reservations |
| E03 | W2 | VERIFICATION | M | Truthful test/coverage map | A00 | Orchestrator + test owners, config decision separated |
| E04 | W4 | DESIGN | M | Bounded intuitive-UX successor contract | Q7, existing UX queue selected | Design-only, no runtime reservation |

**Suggested first selected slice:** A00 → A01 → A03, then B01 → B03 → B04 → C04 → C05, serially with independent review per task. A02/A04 follow to keep it maintainable. B02 is valuable but must be dispatched as ENG-3 with explicit payload compatibility ownership, not mixed into B01.

Never have two web writers, two writers in one package, or a web writer racing a consumed grid/engine API change. Shared config is one lane. Independent analysis may use readers, but execution follows the operating model's serial reviewer/worker discipline.

## 5. Detailed task specifications

### A00 — Establish an actual baseline, then reserve one task

**Evidence:** audit completion explicitly excludes execution; `docs/process/handoff/operating-model.md:104-129` requires fresh gates and independent review.

**Spec:** record current SHA, dirty-tree state without deleting others' work, Node/pnpm/DuckDB versions, pinned VS Code availability, OS and test ports. Compare current source against the audit SHA; revalidate every selected evidence location by symbol if lines moved. Create one queue row with allowed/forbidden files, decision IDs, worker/reviewer assignments, exact tests and copy/behavior approvals. Inventory environmental prerequisites without printing secrets or environment values.

**Acceptance:** baseline command results include exit code, log path and timestamp/SHA; an unavailable dependency is BLOCKED, not green. If failures predate the task, record a separate blocker before altering product code. No fresh count is copied from historical notes. Do not clean a dirty tree with reset/checkout. Close A00 only for the recorded baseline; re-run merged gates after each implementation.

### A01 — Reconcile current documentation without rewriting history

**Evidence:** `SECURITY.md:136-137`; `docs/engineering/07-telemetry-collector.md:39-50`; `packages/engine-duckdb/README.md:39-45`; `docs/engineering/03-repository-structure.md:250-255`; current pickup `:3-8,48-63`; accepted docs review observations.

**Targets:** living handoff header/§6, open-asks checklist, active pickup header/status versus superseded prompts, repository structure, security scope rationale, telemetry collector timing and package README. Prepare an explicit file reservation; do not bulk edit 406 Markdown files.

**Spec:**
1. Put one short current-state/next-action block at the top of the living handoff; link authoritative dated closures, unselected ENG-2/ENG-3 and human asks. Label obsolete pasted prompts as historical/do-not-dispatch rather than leaving them executable-looking. Keep dates, gate evidence and closure narrative intact.
2. Security text must acknowledge implemented desktop functionality. **Do not silently extend supported security versions/surfaces**: maintainer chooses whether exclusion remains policy; if so explain it honestly. Contributor documentation is not a support commitment.
3. Split transport defaults into actual web and CLI rows; preserve retry/drop policy and collector/operator responsibility. Document recursive pipeline-runner package allowlist; do not imply a tarball was freshly audited.
4. Move desktop parity out of 'remaining' in current prose. Keep older milestone records explicitly historical.
5. Explain drifted ADR line anchors/status-marker text in a current clarification record, linking stable headings/symbols. Preserve accepted decision text and append-only amendment discipline.
6. Flag two changeset frontmatter/body package-map discrepancies from `semantic/docs-records-tooling/parent-verification.md`. Compare each original change/intent before changing a bump map; use a separate reviewed intake correction if warranted. Do not run `changeset version`, change package versions, publish, or treat records as proof of publication.
7. Add the package-changing `pnpm changeset` requirement to the subordinate gates skill; preserve provenance/notices.

**Acceptance:** a mapping table lists each corrected present-tense statement and its code/closure evidence; no closed row becomes pending. Docs links, ADR index and formatting pass. No runtime/support-policy change hidden in an editorial diff. Test no obsolete prompt remains presented as the current starting instruction within the selected living entry points.

### A02 — Prevent narrow, machine-checkable documentation drift

**Evidence:** A01 discrepancies; `scripts/check-doc-links.mjs` checks link existence, not source truth; ADR index already derives title/status.

**Spec:** add a small offline checker for a **deliberately finite** set of current facts: selected development runtime (after A03 if checking it), workspace names, declared supported-format list at its source of truth, package allowlist description, active queue markers and closed-row IDs referenced as next. Prefer deriving generated blocks from existing manifests/status fields, not a second hand-maintained database. If queue prose cannot be parsed unambiguously, validate a tiny explicit current-state block and keep history out of it. Do not claim semantic freshness coverage of all Markdown.

**Acceptance:** tests mutate each registered source fact or stale current-state marker and make the checker fail; historical CLOSED narratives do not trigger. JSON/Markdown inputs are data, never executed. Clear location + expected/actual output; deterministic no-network operation; normal check mode writes nothing. New script/CI wiring is orchestrator-reserved; documentation explains the bounded assertions.

### A03 — Align the development support contract, not arbitrary dependency majors

**Evidence:** root `package.json:9-11` allows >=22, `.node-version:1` selects 24; accepted dependency review records stricter locked Node 22 floors. `@eslint/js` 9 versus ESLint 10 and Node typings 26 versus selected 24 are observations, not proven incompatibilities.

**Spec:** first deliver a table of root/tooling versus shipped CLI versus extension-host runtime constraints, including complete locked `engines` strings. Record Q1. Recommended root development policy follows the selected Node 24 line; runtime manifests retain independently justified constraints. Update README/AGENTS/root engines and CI matrix together only after lower-bound validation. Do not blindly align every manifest, downgrade types, or upgrade DuckDB/Arrow. Assess @eslint/js compatibility in a separate isolated dependency commit only if a concrete unsupported-peer/API problem is found; otherwise document the intentional major difference.

**Acceptance:** clean frozen-lockfile install and full relevant gates on the chosen minimum and selected runtime; packed CLI smoke on each advertised product major's chosen minimum/current validation points; VS Code pinned host tested separately. Record the exact engine policy range **and separately the precise tested versions** (minimum and selected current version). A major-line policy may permit future patches/minors; those are not claimed as individually tested. Capture peer warnings and package-manager runtime requirements. If minimum cannot be exercised, narrow the claimed support or block the choice, not invent a pass. Package engines changes get package-specific changesets; lockfile changes are minimal and explained.

### A04 — Add a safe offline contributor preflight

**Evidence:** root script wiring `package.json:12-28`; pinned CLI/VS Code and browser prerequisites are spread across handoff/runbook.

**Proposed interface:** `pnpm doctor` → `node scripts/doctor.mjs` (new, orchestrator-owned).

**Spec:** check runtime against A03 policy, pnpm version against packageManager, workspace/install/build prerequisites, existence of expected pinned DuckDB and Playwright/VS Code caches, and occupied configured test ports. Use trusted version probes only; never launch the application or inspect user datasets. Missing optional e2e prerequisites are warnings unless `--strict` selects them. `--json` returns stable fields `{check,status,expected,actual,help}`; statuses are pass/warn/fail. Exit 0 for pass/warn; 1 for mandatory failure; usage error 2. No auto-install, download, format, deletion, environment dump or config modification.

**Acceptance:** injected environment/fs/command seams cover missing executable, wrong version, command timeout, spaces in paths and unavailable port. JSON/stdout has no tokens, user file names or arbitrary env values; human output identifies exact documented setup command. Doctor does not replace tests or say the product is healthy.

### B01 — Refuse duplicate CSV declared-type names before information is lost

**Evidence:** `apps/web/src/csv/options.ts:105-121` assigns `columns[name] = type` without checking an existing name. Q2 is a proposed policy improvement, not a claim that the existing UI promised rejection.

**Targets:** CSV option parser/copy + its tests; dialog tests and one bounded CSV browser case if needed; minimal synthetic fixture if a dataset-shape regression is exercised.

**Spec:** parse each nonblank line exactly as today (same trim, colon grammar and case sensitivity); track parsed names in `Set<string>` before map assignment. A repeat returns a typed internal refusal such as `{code:'duplicate-column', line:<1-based>}`. Adapt exported result shape only if needed; the user sentence must not echo name/type/input. Use own-key-safe construction (`Object.create(null)` with correct type or equivalent own-property definition) and validate structured-clone/engine-boundary handling of `__proto__`, `constructor`, `toString` as **literal column names**, never an exploit claim. Preserve blank=unset and preview/open option separation.

**Acceptance:** same-name/same-type and same-name/different-type refuse, with whitespace-normalized duplicates; `a` and `A` remain distinct; blank lines do not lose line numbering; special names either survive as own keys or receive an existing vocabulary refusal without silent loss. Failure dispatches no preview/adoption engine call and preserves prior ready session. Ordinary valid option wire bytes remain unchanged. No unapproved empty-string control, locale inference or quoting grammar expansion.

### B02 — Execute ENG-3 only as a coordinated dialect-contract repair

**Evidence:** `docs/process/handoff/20261118-post-ew03ia-pickup.md:55`; `docs/process/handoff.md:98-102`; sniffer returns literal `(empty)` and escaped newline text, not the comment's empty raw strings. D3-1 rename derivation depends on current representation.

**Spec/design gate:** record a payload matrix for delimiter/quote/escape/comment/newline/dateformat, user-supplied versus sniffed values. Recommended smallest fix: retain wire representation, correct engine comment and interpret display sentinels at an explicit web display adapter. The same display adapter must not be reused as raw parser input. If engine normalization is selected instead, reserve separate engine and web compatibility children, update response guards/types/conformance and D3-1 decoder as one integrated contract migration.

**Acceptance:** real-engine cases cover quoting disabled, comments disabled, LF/CRLF and quoted newlines; display says None only for actual disabled semantics, not an unset/inferred field. Per-file rename-list equality gate still works or honestly bails; no partial list. Preview/adoption option bytes, sample bounds, quick-open and source immutability unchanged. Include a mutation that converts escaped newline to raw at the wrong boundary and demonstrate the rename test fails. No ENG-2 or preview-release work bundled here.

### B03 — Explicit browser writable failure cleanup

**Evidence:** `apps/web/src/export/save-destination.ts:49-57,205-223`: structural writable exposes write/close only; sequential write/close lacks failure cleanup. No browser corruption incident was established.

**Proposed contract sketch:** `SaveWritable` may additionally expose `abort?(reason?: unknown): Promise<void>`; existing fakes remain valid. The public helper still resolves SaveStrategy only after successful close for FSA, or download initiation for fallback.

**Spec:** after createWritable succeeds, wrap write and close in one failure boundary. On failure attempt abort once if supported, ignore abort failure **without replacing the primary rejection**, and never close after failed write as a success path. On success close exactly once; do not abort. Creation/read failure must not call methods on a nonexistent writable. Do not retry delivery automatically (duplicate exports). Use value-free internal abort reason, not dataset/error content. Keep source identity checks/picker timing/download fallback intact.

**Acceptance matrix:** read failure; create failure; write failure + abort success/failure/absent; close failure + abort best effort; full success; download failure. Assert method order, original error identity in the helper, UI error/no success, no engine work on picker cancel/same-source refusal and unchanged opened source. Unit tests inject the writable; an FSA-capable browser run checks real platform behavior separately. Do not claim abort restores a destination under every browser or claim download persistence. This task does not add export Cancel UI.

### B04 — Close desktop handles even when writer acquisition fails

**Evidence:** `apps/vscode/src/pure/create-only-writer.ts:13-90`; stat and invalid-metadata close occur before cleanup facade exists. Header's universal owned-inode cleanup wording overstates non-atomic check/unlink.

**Spec:** model phases `not-open → opened-unverified → owned → writing → closed/cleanup-attempted`. Wrap all post-open acquisition in cleanup protection. A handle.stat failure must still attempt close; without a reliable identity, **do not unlink the path**. Once dev/ino/nlink identity is established, reuse a narrowly scoped best-effort cleanup routine; failed close does not skip the cleanup decision. Preserve positive short-write loop and reject nonpositive progress. Concurrent close/cleanup must not double-close or report successful sync after failure; define one in-flight promise or equivalent per operation. Keep source canonicalization, wx, 0600 and refusal categories.

**No false guarantee:** identity-check then unlink remains a race; don't rename it atomic or promise no replacement can ever be deleted. If stronger adversarial-directory safety is a requirement, stop for a platform-specific design; no invented check loop can prove atomic compare-and-unlink.

**Acceptance:** controlled fs seam tests inject stat, sync, first/final lstat, close, unlink failures and short/zero writes; a real temp-directory suite covers existing destination/source alias, completed close, cleanup repeated, replacement visible **before identity check**, and source unchanged. The injected seam must be internal/test-only, not broad public fs plumbing. An unverified file may remain with honest failure; prioritize not deleting an unowned path. Document best-effort residue behavior, no atomic completed-file delivery claim. Extension export tests still pass.

### B05 — Make DCR failed-write residue explicit and owned

**Evidence:** `apps/cli/src/dcr.ts:233-248`: wx prevents overwrite but writeFile failure can leave a partial new artifact. B04's design can inform this task; CLI **must not import VS Code app code**.

**Spec:** choose and document best-effort partial-file cleanup as the bounded contract (not all-or-nothing publication). Acquire an exclusive file handle, write UTF-8 fully, close, then return exact byte count; preserve public `{ok:false,reason:'path-exists'}` and CLI exit/report conventions. On failure close acquired handle, then attempt cleanup only with verified ownership, preserving the primary authored failure. If identity cannot be verified, leave residue and communicate that the requested new artifact may be incomplete; do not say nothing was written. Existing stdout/no-output mode is unchanged. Here 'verified ownership' means a best-effort identity match; **check-then-unlink has the same non-atomic replacement race as B04** and must not be advertised as universal replacement safety. If that adversarial race must be eliminated, stop for a platform-specific atomic design rather than adding another check. Temporary-file/rename atomic publishing is **not** in scope because replacement/no-replace semantics differ across platforms.

**Acceptance:** pre-existing and concurrently created output unchanged, non-ASCII byte length correct, write/close/cleanup failures, partial write, replacement-before-check and real temp-filesystem CLI integration. Success bytes remain canonical/golden. A private fs seam tests faults; no sensitive data in new logs; no cross-app utility package introduced for two helpers without a separately approved packaging decision.

### B06 — Deliberate retry semantics for File acquisition

**Evidence:** `packages/data-sources/src/browser-file-source.ts:80-86`; module documentation currently promises one lazily acquired snapshot. Q3 must be selected first.

**Recommended implementation sketch:** cache one in-flight attempt; on rejection clear it **only if it is still the cached attempt**, then rethrow. On fulfillment retain that File for the entire instance. Capture synchronous getFile throws into the same error path if needed. Do not fetch new bytes after a fulfilled snapshot just because the external file changed.

**Acceptance:** concurrent open/metadata/getFile calls share one attempt; all see its failure; next call after failure retries once; fulfilled calls return the same File and frozen DataHandle/id; old rejection cannot clear a newer attempt; fallback File never invokes a handle; source/file name is not logged. Update package contract/conformance and a real browser adapter case where feasible. If Q3 instead preserves permanent failure, implement caller retry with a fresh source and explicitly test that route, not the sketch above.

### C01 — Design the whole-list filter transaction before fixing callers

**Evidence:** `packages/grid/src/viewport-model.ts:395-428`; provider filter contract `packages/grid/src/contracts.ts:139-153`; `FilterBar.tsx:299-341` and `App.tsx:1685-1750` already compensate. Repeated rollback in callers is not proof of atomicity.

**Deliverable:** one short contract and caller table for all providers (web, desktop and test subjects), including query sequencing, sort interaction, refresh failure and double failure. Recommended optional `replaceFilters(specs): Promise<void>` means validation is all-before-commit; rejection leaves previous provider list in effect. Caller-visible distinction: (a) rejected before change, (b) accepted provider state but refresh failed, (c) legacy partial apply/restore failed. No new status union chosen silently.

**Acceptance:** exact transition table and tests required for C02 are specified; legacy behavior explicitly remains non-atomic. Resolve where retry/clear is exposed and whether errors carry value-free phase metadata. Avoid an automatic rollback in multiple layers. Grid's optional capability remains engine-neutral; no SQL parsing in grid/domain. Stop after design until Q4 and the cross-package reservations are approved.

### C02 — Implement atomic filter capability in serial children

**C02a grid:** add optional atomic capability, use it when available, otherwise retain existing documented clear/add sequence. Snapshot/validate list before dispatch; serialize via the existing query queue. The published effective query state must converge on the last successfully provider-accepted request, not blindly on the last requested one. If request A changes the provider but is superseded while awaiting, then newer B refuses before changing it, reconcile to accepted A (or restore a documented earlier snapshot); do not leave the provider at A while model/UI claim an unrelated old list. Suppress stale page delivery while this settles. After provider accept, refresh failure retains the accepted query state with an explicit reload error — never call it rejected-and-unchanged. C01 must specify the equivalent shared sort/filter sequence interaction before implementation.

**C02b web:** implement whole-list replacement in the local provider by validating every spec before one state assignment. Migrate FilterBar/profile/validation callers to single ownership of restoration; keep legacy-provider fallback where tests still exercise it. Keep filter-draft inputs and accepted filter state distinct; this is not WF-O1 UI work.

**C02c desktop:** implement the capability and align consumers with the same contract, without changing host bridge protocol just for convenience. Each child is a separate reservation/changeset/review, with old callers compiling between merges.

**Acceptance:** [p1,p2] with p2 refusal leaves old list and cache valid under atomic path; accepted state + refresh failure reports reload rather than a false rollback; rapid requests and sort/filter interleaving obey the reviewed last-request/last-accepted semantics, explicitly including superseded accepted A followed by rejected B; rejected queue entry doesn't poison successors; late old pages never publish; legacy partial/double-failure cases remain honest. Real-engine window/count tests plus web/desktop focused journeys. No mandatory API breaking change, unconditional double restoration, stale overwrite from a superseded call, extra scans per keypress or engine interrupt promise.

### C03 — Clarify and probe reset/commit callback failure boundaries

**Evidence:** `apps/web/src/sessions/session-reset.ts:58-79` increments token then invokes resets; `apps/web/src/edit/session.ts:495-537` calls activation outside protection while its comment says never throws. This is a bounded contract/fault-injection candidate, not proven ordinary data loss.

**C03a design/probes:** identify every registered reset and CommitEffects.setActive implementation; classify synchronous nonthrowing guarantees versus external callbacks. Inject throw in first/middle reset, next activation, previous activation and second refresh. Choose whether to narrow never-throws documentation or implement a stronger structured failure result. This step can legitimately conclude documentation-only for impossible-in-contract faults, with justification.

**C03b optional implementation, separately selected:** attempt every reset after invalidating generation; aggregate only value-free fault codes; abort adoption before ready if any callback fails and surface a defined recovery state. Do not promise restoration of arbitrary previous callback effects. For commits, track whether activation may have occurred; if restore activation or restore refresh fails, return an honest restoration-failed/unknown-view result and provide retry. Prevalidation refusal still leaves history untouched; success remains one history entry/undo step. The final API and recovery copy come from reviewed C03a, not this sketch.

**Acceptance:** no ready state after partial reset; later reset callbacks invoked under the chosen policy; stale results remain fenced; original + restoration failure are distinguishable without raw payload leakage; no swallowed failure marketed as success; existing R1 validation-before-commit and WF-06 preservation assertions unchanged. If a new structured result affects App/session consumers, explicitly reserve them before editing. Do not use this task to release retained tables or add persistence.

### C04 — Make every disposal caller await the same teardown

**Evidence:** `packages/engine-duckdb/src/client.ts:1163-1198`: terminal flag short-circuits later calls before awaiting stored disposal promise. This is a strengthened await contract, not evidence that the worker never terminates.

**Spec sketch:** check for an existing disposal promise **before** returning for terminal status; return/await it on every re-entry. Keep immediate terminal status and pending rejection, one graceful request, existing bounded timeout and one worker termination. Handle disposal-before-boot and boot/dispose race. Do not change timeout or swallow previously surfaced terminate failures to make tests pass. Public async callers need equivalent settlement, not promise-object identity.

**Acceptance:** deferred worker reply holds both first and second disposal promises unsettled; completing reply/timeout settles both; one terminate; new/in-flight ops reject with EngineDisposedError; failed boot cannot resurrect ready. No graceful reply, send rejection, worker crash and repeated post-completion dispose are covered. Unit worker fake is followed by real-engine disposal regression. No automatic retry or hard-interrupt feature.

### C05 — Make conformance's exact-values claim actually falsifiable

**Evidence:** `packages/testing/src/engine-conformance.ts:2090-2193` predicate-error-reuse anchor asserts row count/readiness/registry but not cell values; `normalizeArrowCell:1551-1580` enumerates generic objects.

**Spec:** use the existing window-semantics expected data to compare a bounded anchor window's declared values and order after containment probes (and before if required to show a meaningful unchanged baseline). Request only the bounded expected span; do not equate total expected rows with returned batch when the cap is smaller. Prefer the existing comparator/normalizer when its supported shape is established. If it cannot represent the anchor, choose a typed scalar anchor rather than silently rewriting the normalizer.

**Acceptance:** a deliberately faulty fake that preserves counts/readiness/registry but alters one anchor value fails this scenario; a correct fake passes; real browser DuckDb conformance passes; sample bound and existing result fact names remain stable unless an additive change is explicitly approved. Normalizer Date/Map/array semantics are **not** changed in this task. A broader normalizer contract would require a separate shape matrix + real Arrow tests. No claim of universal SQL sandboxing.

### D01 — Name contract text reading honestly

**Evidence:** `apps/web/src/validation/contract-import.ts:36-58` calls decoded text 'parsed'; actual parsing is in validation and pipeline callers.

**Spec:** rename success discriminant `'parsed'` → `'read'` (or reviewed equivalent) and type documentation to say text-read, not contract/parse result. Update all consumers/tests with type-aware rename; preserve 1 MiB File.size check **before** text(), too-large/read-failed outcomes and downstream parseContract invocation. Keep function name readContractFile; no additional adapter or parsing pass.

**Acceptance:** invalid YAML is still a successful text read followed by typed downstream parse refusal; boundary sizes, read failure, session-token race and separate pipeline/validation callers are pinned. Same user-visible behavior and no persisted/wire format migration. No new JSON Schema import control or broad error-copy rewrite.

### D02 — Decompose App by ownership, not by an arbitrary line count

**Evidence:** audit `complexity.csv` records App.tsx 3,569 physical lines; existing session hooks and replace state machine already exist. Actual preparation/adoption ordering at `App.tsx:2048-2117,2266-2322` is load-bearing.

**D02a shell presentation:** move pure section summaries, WorkbenchSection and PanelBoundary into app-local workbench modules. Keep existing exported test seams/re-exports while tests migrate; no hook or engine lifecycle movement. Assert semantic headings/accessible names, focus restoration, persistent grid and lazy panel loading.

**D02b replacement controller:** extract acquisition/preparation/currency checks to an app-local replacement controller/hook that consumes explicit small ports and returns commands + renderable state. Reuse existing machine/gate modules; avoid a second reducer or generic session store. Candidate-local overlay remains separate until successful adoption. Preserve synchronous picker invocation/user activation, guards after every await and exactly-once adoption/telemetry.

**D02c composition cleanup:** move the approved adoption/reset wiring behind one explicit session-owner boundary after C03 decision if selected. App remains composition root. Do not expose mutable history/model refs widely or create a callback registry to hide dependencies. State ownership table must have exactly one owner per history, overlay, phase, replacement token, report revision and export-in-flight snapshot.

**Acceptance per child:** no changed DOM/focus/modal navigation; no extra engine open/preview/query/fetch/disclosure/event count; no engine re-creation per render; old session preserved on picker cancel/preparation failure; stale candidates cannot adopt; CSV non-adopting preview and ADR0049 retention unchanged; dirty draft/cast/commit/export guards intact; exact snapshots/canonical output unchanged. Run existing render-count/no-extra-fetch pins and real replacement/CSV/export journeys. No LOC quota, framework dependency, package promotion, UX redesign or mass test snapshot acceptance.

### D03 — Split desktop bridge ownership and webview composition

**Evidence:** host `apps/vscode/src/dataset.ts` (~965 lines) handles incoming bridge/export/Git; webview `dataset.ts` (~2,329) combines UI/controller/test proof. Existing `src/pure/bridge-contracts.ts` and export-transfer guards already exist.

**D03a host:** extract export request/chunk/writer lifecycle into a desktop-local controller with explicit dependencies (messaging, destination acquisition and writer factory). Keep production message validation at ingress, payload/sequence/offset/generation bounds and source alias checks before any write. Existing pure contracts stay source of truth; no parallel handwritten schema.

**D03b webview:** split validation/diff/dirty-history presentation controllers from top-level wiring. Isolate test proof orchestration behind its existing testHarness/ExtensionMode.Test gates. Removing proof code from production bundling is a **separate** measured design choice, not implicit in moving functions. Preserve previous reports on current-generation failure and their stale-revision computation.

**Acceptance:** malformed/stale/duplicate/out-of-order chunks refuse; host doesn't write before validation; disposal/session change cancels owned transfer safely; validation/diff stale reports and create-only export unchanged; production open never runs exercise* proof suite; installed CLI agreement/pinned offline engine and real extension-host acceptance pass. Do not rewrite the protocol, change format support, add extension telemetry or move browser-dependent controller code into domain/core. Each child has a separate changeset and clean intermediate build.

### D04 — Create engine seams without rewriting compiler or execution semantics

**Evidence:** engine-executor.ts (~2,605), overlay-query.ts (~1,936) centralize distinct operations. Accepted engine review and ADR0051 constrain cleanup, SQL and composition.

**D04a handlers:** move coherent CSV preview/open dispatch handlers to engine-local modules first; pass an explicit executor context containing existing DB/registries/op-channel interfaces. Retain one registry owner and the two existing lanes, request validation before SQL, successful-response cleanup gating and error categories. Do not introduce a global service locator or change ENG-3 payload in a refactor.

**D04b composition:** extract pure SQL emission groups behind existing exports/re-exports, starting with COPY/export or identifier/type helpers whose inputs/outputs are already explicit. Shared constants must have one canonical owner. Keep literal SQL, alias hygiene, row ordinals, repair masking and set-membership shape byte-identical; API/semantic improvements are separate tasks.

**Acceptance:** existing compiler/golden SQL snapshots and native/WASM agreement tests remain unchanged except import paths; hostile-wire/pre-execution refusal and cleanup failure tests pass; exports and package tarball allowlist include new emitted JS/declarations/maps but exclude harness assets; fresh pack-consumer smoke passes. Do not add wildcard publication globs to 'fix' missing files. No ENG-2 count-op implementation, memory/cap change, retained-table release, normalizer rewrite, query-result all-batches promise or dependency upgrade.

### E01 — Optional opt-out cancellation strengthening

**Evidence:** accepted web telemetry review: equal 32-event/256 KiB buffer/batch caps mean **one default batch**; off clears queued events but has no handle for active send; transport retry can continue. No egress incident was observed.

**Design first:** preserve injected transport compatibility via an optional send options/signal parameter. Runtime owns an active-send AbortController; transport combines per-attempt timeout with caller cancellation and removes all listeners/timers. Differentiate caller abort (drop, never retry) from attempt timeout (current bounded retry). Check cancellation before each attempt and after backoff; make backoff cancellable or at least guarantee no next fetch starts. Off/dispose aborts current send and clears queue. Re-enable creates a fresh generation; no drained old events replay. Decide separately whether CLI parity is selected.

**Acceptance if selected:** deterministic tests cover off-before-send, off-in-fetch, off-in-backoff, off→on, disposal during send, repeated flush and timer cleanup; strict no-reject production transport policy remains. Configured browser collector uses local test interception and privacy canaries, never a real endpoint. Stock endpoint-free build still delivers nothing. Disclosure says 'stops further attempts and attempts to abort in-flight delivery', not 'recalls data'. No invented later-batch regression test under unreachable defaults, no new events or collector deployment.

### E02 — Measure before streamlining dependencies

**Evidence:** accepted 31-name dependency review proves no behavior-equivalent built-in or <20-line replacement. Installed own-package bytes are not bundle weights; DuckDB/Arrow pins have vendored/ABI rationale.

**Spec:** produce a versioned offline dependency-use manifest: runtime/test/type-only/config/bin, actual use sites, locked engine/peer ranges and rationale. Measure browser entry/chunk compressed and uncompressed bytes, separately from lazy WASM/workers/native binaries, desktop package and CLI tarballs; avoid double-counting shared chunks and dynamic assets. Build tools record versions and exact command/SHA. Establish baseline before setting budgets. Do not introduce an analyzer dependency if build metadata suffices; if needed, license/security review and separate approval.

**Acceptance:** reproducible report explains static versus lazy assets and no claim of tree-shaking without measurement. A dependency-removal candidate requires actual API behavior parity and all consumer tests, plus saved bundle/install/startup evidence; otherwise retain it. Peer mismatch is reported with actual ranges, not major-number suspicion. DuckDB/Arrow upgrades require byte-pin regeneration, offline extension and cross-surface agreement, not simply latest tags. No registry probe or automatic upgrades in normal CI; a separately selected update job may use network with explicit disclosure. Add budgets only after representative stable baselines; no threshold chosen to mask a regression.

### E03 — Make assurance coverage boundaries easy to see

**Evidence:** `vitest.config.ts:6-24,30-77` covers package/app src but not desktop webview; separate Node, browser, conformance and installed-host tests have different subjects. Historical audit coverage is not a fresh pass.

**Spec:** create a concise map of critical contracts to assertion bodies, subject type, runner, required environment and command. Include filter accepted-versus-refused/refresh, export acquire/write/close, replacement token, wire refusal, repair undo, diff confirmation and canonical DCR. Use existing suites, don't duplicate the entire test census. Record current coverage denominator and excluded webview explicitly. For desktop code, first extract testable pure controllers (D03) or design an appropriate browser coverage collector; **do not merely add webview globs** and treat 0% Node instrumentation as meaningful execution.

**Acceptance:** fresh coverage artifact records SHA/config hash/runtime/command; generated reports aren't committed unless policy explicitly selects them; missing prerequisites marked unavailable. Unit fakes, real temporary FS, SQL-string-only compilers, original-Worker instrumentation, real WASM/browser and installed host are labelled correctly. Any selected new coverage scope has its own floor decision without lowering existing floors. Regression/mutation proof is required for newly claimed assurance, but does not require adding arbitrary non-critical tests or changing test timeouts.

### E04 — Design intuitive UX improvements through existing rows

**Evidence:** `docs/process/handoff/20261110-web-followup-map.md:93-115` explicitly reserves WF-O1/O2 and other shell/layout proposals; existing UX queue is closed for its original scope.

**Recommended first child WF-O1:** document draft filter inputs versus accepted effective filters, exact equality rules (not SQL equivalence), invalid/cleared/no-op/programmatic change cases, busy/apply/reset/failure copy and keyboard announcements. One modest input-dirty indication is preferable to a new workflow. Preserve clear-all/manual recovery after unknown state from C01/C02; no claim that dirty means 'unsaved dataset'.

**Separate WF-O2 design:** propagate declared child types into nested/Record rendering and actual SQL result metadata into SQL formatting; define null/hostile/deep-container bounds, timezone/precision/raw fallback and copy parity. Scalar temporal WF-01 is not authorization for this. Export/edit/filter raw fidelity remains unchanged.

**Other optional child:** consistent recovery copy map using existing local alerts/status components: operation/action, whether previous result remains, whether stale, and precise Retry/Clear/Open-new recovery. SQL 'Cancel' must say stop showing this result if execution continues; downloads say initiated, not durably saved. Audit current copy first; no blanket assertion it is missing or permission for a global ErrorBus.

**Acceptance of design:** exact before/after copy, state truth tables, keyboard/focus/live-region behavior, untrusted text handling and specific source/test owners; screenshots/prototypes are proposals, not usability evidence. Narrow-screen/zoom constraints and participant/AT evidence gaps are explicit. Stop for maintainer selection before implementation; no WF-03/04/07/08/09 redesign sneaked into CSS cleanup.

## 6. Verification and integration contract

These commands are **instructions for future execution**, not results of this planning session. Discover exact test filenames and current package scripts in A00; don't run the entire recipe blindly on a dirty checkout or unavailable host.

### Common gates

```bash
pnpm format:check
pnpm lint
pnpm exec turbo run typecheck --force
pnpm test
pnpm test:coverage
pnpm exec turbo run build --force
pnpm docs:links:check
pnpm adr:index:check
# Browser-visible/runtime-engine changes, after build:
pnpm test:e2e
# Packaging/runtime closure changes:
node apps/cli/scripts/pack-consumer-smoke.mjs
```

Run gates once with stock environment. For telemetry/runtime tasks, follow the repository's current configured-test and restored-stock recipes in CI/handoff; never print tokens, send to production or leave the configured endpoint in a shipped bundle. Desktop changes also require pinned offline VS Code host/installed CLI agreement checks; inspect its package scripts for exact commands. `DUCKDB=/tmp/duckdb` (pinned v1.5.5 at the audit baseline) is needed for native-agreement/fixture suites; verify rather than assuming. Read the browser skill before browser interaction.

Targeted examples after prerequisite CLI compilation where needed:

```bash
pnpm exec vitest run apps/web/src/csv/options.test.ts --project web
pnpm exec vitest run apps/web/src/export/save-destination.test.ts --project web
pnpm exec vitest run apps/vscode/src/pure/create-only-writer.test.ts --project node
pnpm exec vitest run packages/data-sources/src/browser-file-source.test.ts --project node
# Only after build, with assigned free ports:
pnpm exec playwright test tests/e2e/diff-panel.spec.ts
```

A named file may move or have a different existing test name; confirm before use and record the final command. Changed TS files get active LSP diagnostics where available plus package typecheck; empty cached diagnostics are not evidence. Tests should first fail for the chosen regression, pass for the fix, and fail again under a bounded load-bearing mutation in a temporary worktree. Reviewer restores the mutant exactly and rebuilds before e2e (built dist is served). Never use mutation drills on user data.

### Required per-task handoff

- Task ID, selected decision(s), baseline SHA, branch, worker/reviewer, paths and port reservation.
- Actual diagnosis/repro and any refutation of the audit candidate; no invented incident or prior test run.
- Changed behavior/state diagram and explicit unchanged contracts.
- Exact changed files, Conventional Commit(s), package changeset(s); choose bump per actual impact.
- Golden fixture/generator/manifest checksums for every dataset-shape fix, or precise reason no dataset-shape change is involved.
- Commands, exit codes, concise tails and durable log locations; full gate counts measured now, not inherited.
- Independent reviewer `VERDICT: approve` or numbered `request-changes`; mutation sensitivity evidence; no self-approval.
- Merged gate results, remaining limits and current queue update by orchestrator. Stop means BLOCKED, not CLOSED.

### Rollback

One behavior change per commit/PR where practical; refactor and behavior fixes separate. Keep intermediate builds/callers compatible. Revert code plus matching docs/changeset for a rejected task; do not roll back unrelated concurrent work or rewrite historical closure records. There is no persisted-data migration in the first wave. A need for format/version/history migration is a stop-and-rescope signal.

## 7. Completion criteria and stop rules

**Program completion is selected-scope completion, not all 24 rows.** Mark each row with proposed/selected/claimed/in-review/integrating/closed/blocked/not-selected and link actual review/merged evidence. New limitations are carried, not erased.

Success for the recommended first slice: current docs agree with shipped boundaries; approved dev minimum is actually exercised; CSV duplicate refusal preserves every valid existing path; export lifecycle tests detect failures without claiming atomic delivery; all dispose awaiters share teardown; exact-value containment assertion catches count-preserving corruption. No privacy/export/history regressions or new runtime dependencies.

Stop for: accepted ADR conflict; unselected UX/runtime policy; new wire/persisted format; package-boundary crossing; impossible current test prerequisite; failing pre-existing gate; real sensitive fixture; deletion without ownership proof; raw error/log/telemetry content; needed release/publish/collector operation. Return a decision request with evidence and minimum alternative, not an opportunistic rewrite.

### Explicitly outside this plan's implementation authority

Hosted/AI/enterprise features; Arrow/Feather input support; persistent edits; table-release/worker interruption; changing repair caps or mask memory representation; increasing test timeout or reducing coverage; adopting a new state framework; removing 'unused' type/config/bin dependencies; promoting scaffold packages; big-bang App/engine rewrite; published-package claims; a full public API documentation census. These require their own demand/design/gate evidence.

## 8. New-agent pickup

Start with `START-HERE.md` and `tasks.json` in this bundle; the paste-ready orchestrator prompt is in START-HERE. The enclosed `assay-audit-phase1.tar.gz` freezes the Phase 1 evidence, so pickup does not depend on the original temporary directory. Choose A00 and one bounded task, **not the entire backlog**. Preserve the outer `/tmp/assay-improvement-plan.tar.gz` in durable storage before a host/session reset—`/tmp` itself is not a permanent handoff location. A separately selected documentation task can copy the approved plan/evidence into the repository; no such copy is performed automatically.
