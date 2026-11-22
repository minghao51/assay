# B1 / ENG-2 — typed `repair-preview` affected-count op (spec)

**Date:** 2026-11-21. **Status:** `SELECTED` for implementation in this batch (spec first, then engine op,
then the web caller switch). **Row:** ENG-2, [pickup](20261118-post-ew03ia-pickup.md) §2; handoff §2.

## 1. Why an op (verified current behaviour)

The repair preview answers three counts and ≤10 examples from one immutable snapshot. The **examples**
already go through a typed op (`engine/overlay-range` with a filter spec). The **affected count** does
not:

- `apps/web/src/edit/repair/preview-sql.ts:175` composes
  `SELECT count(*)::BIGINT AS affected FROM (<engine export composer>) WHERE (<plan predicate>)` from
  engine-exported composers (`composeOverlayExportSelectSql`, `cellLiteralRawSql`,
  `quotedIdentifier`, `whereClauseSql`);
- `apps/web/src/edit/repair/reader.ts:106` executes it through the **generic** `engine/query` op;
- the engine's typed `engine/overlay-row-count` deliberately ignores values ("values don't affect
  counts", D16/D17 probe §4.2), so it is the wrong op for a value-defined set — the reason the
  composition lives in web today.

Consequence: the _definition of "affected"_ (which rows the repair changes) is a web-layer string, and
its exactness rests on web tests (`preview-sql.test.ts`, `preview-sql.engine.test.ts`,
`useRepairPreview.test.tsx`). ENG-2 moves that definition engine-side so a conformance test, not a
composed string, owns it.

## 2. Contract

**Op:** `engine/repair-preview-count` (new request type in `ENGINE_REQUEST_TYPES`; additive protocol
change — no existing request/response shape, cap, lane or persisted artifact changes).

**Request** (`EngineRepairPreviewCountRequest`):

| field       | type                                                           | notes                                                           |
| ----------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| `type`      | `'engine/repair-preview-count'`                                |                                                                 |
| `requestId` | `number`                                                       | existing envelope rules                                         |
| `tableId`   | `string`                                                       | registered base table                                           |
| `overlay`   | `EngineOverlayPayload`                                         | existing boundary validation (`parseOverlayPayload`)            |
| `plan`      | `{ column: string; trim?: string; pairs: [string, string][] }` | the repair plan, mapping ordered/duplicated-normalised at parse |

The plan is **data, never SQL**: every key, target and trim value is escaped by the engine's own
`cellLiteralRawSql`, exactly as the composer does. No host-supplied predicate text is accepted.

**Response:** `{ affected: number }` — the complete count of rows the plan changes over the effective
relation. A count that is not a `Number.isSafeInteger` is a typed refusal (`count-out-of-range`), not
an approximation (unreachable for a browser-resident table; stated so the wire cannot silently lose
precision).

**Lane:** the query lane (ADR 0040). It is a user-initiated read scan, exactly like today's generic
query call; the registry/grid lane and its latency expectations are not touched.

**What it does not do:**

- no second scan: one `count(*)` over the engine-composed effective relation, the same relation and
  predicate the web composes today;
- no examples, no `scanned`, no `unaffected`: examples stay `engine/overlay-range`, `scanned` stays the
  pure domain `liveRowCount` fold, `unaffected` stays `scanned - affected` in
  `apps/web/src/edit/repair/preview.ts`;
- no cap, envelope or memory change; no sampling (the count is complete);
- no change to the applied-repair fold, DCR generation, export bytes, or ADR 0051's composition shape.

**Predicate ownership:** the affected-set predicate (the two negated set-membership terms documented in
`preview-sql.ts`) moves to `packages/engine-duckdb` as one exported pure function. The engine op uses
it; `apps/web/src/edit/repair/preview-sql.ts` imports it for the `overlay-range` examples filter (the
same string, so example and count sets cannot diverge). The predicate builders stay pure and are unit
tested in the engine package.

## 3. Refusal categories (pre-execution, typed)

| category             | trigger                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| unknown table        | `tableId` not registered                                                        |
| invalid overlay      | existing `parseOverlayPayload` rejection                                        |
| unknown column       | `plan.column` not in the overlay's effective columns                            |
| non-textual column   | column type is not a textual family (repair only transforms text)               |
| invalid plan         | empty `pairs` **and** no `trim`; duplicate key; non-string key/target; bad trim |
| plan out of envelope | pair count above the domain plan cap (the same cap the UI enforces)             |
| count out of range   | result not a safe integer                                                       |

Every refusal is value-free (ADR 0025): no key, target, trim value or engine text in the message.

## 4. Verification plan

**Engine (`packages/engine-duckdb`):**

- protocol parse: one test per refusal category, plus hostile wire values (SQL fragments, NUL,
  quotes, `--`, `;`, oversized pair list, non-string members) proving they never reach SQL text;
- real-engine conformance at the pinned CLI: for each plan shape the fold accepts — trim-only,
  mapping-only, both, the trim/mapping **cancellation** case, NULL values, empty mapping + trim — the
  op's `affected` equals the number of rows whose composed wrap actually changes the value (the
  existing `preview-sql.engine.test.ts` matrix, ported), and equals the transitional composed-SQL
  count;
- mutation drills: drop the `(t, v) NOT IN (VALUES …)` term → the cancellation case fails; drop the
  `IS NOT NULL` term → the NULL case fails; point the op at the pre-repair relation → the
  re-repaired-column case fails.

**Web (`apps/web`):** `readRepairPreview` calls the typed op for the count (asserted by request type,
not by a generic-query spy); the examples read and `scanned` fold are unchanged; `useRepairPreview`
and `App.repair` tests stay green; `preview-sql.test.ts` keeps the predicate/parity pins while the
transitional composed SQL exists.

**Migration order:** engine op + conformance first; web caller switch second; delete the web-composed
`repairAffectedCountSql` only after the typed path is proven (one commit each, so a reviewer can see
the parity window).

## 5. Changesets and open decisions

Changesets: `@assay/engine-duckdb` **minor** (new op + new exported predicate builder); `@assay/web`
if the caller changes (private package — follow the existing convention).

Open decisions (recorded, not blocking implementation): op naming
(`repair-preview-count` vs `overlay-repair-count`), and whether the exported predicate builder lives in
`overlay-repair-query.ts` or its own module. Nothing here reopens ADR 0051, ADR 0049 item 8, the repair
caps, or the preview's copy.
