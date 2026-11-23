# WF-O2 type propagation — real-engine probe record (R-5, item 3)

**Date:** 2026-11-23. **Status:** evidence for the
[type-propagation contract](20261123-wfo2-type-propagation-contract.md) §5 (item 3: SQL result
metadata). Commissioned by the [WFD selections](20261123-wfd-selections.md) §5: item 3 "is not
writable honestly without measurement". **This record authorises no runtime work.**

## 1. The question

`apps/web/src/sql/SqlPanel.tsx:168` builds the result page's column list with
`resultColumnNames(result.batch)` — **names only** — and renders cells with `formatCell(cell)`
(no type) at `SqlPanel.tsx:400`. `paged-query.ts` declares the batch slice it needs as
`schema: { fields: readonly { name: string }[] }`.

So: **does the Arrow result the pane already holds carry a real, usable type per field for computed
expressions, function results and aliases — or only for plain base-table columns?** If yes, a type
channel for untyped SQL results is technically possible; if no, it is not, and the contract must say
so instead of designing around an absence.

## 2. Setup (reproducible)

- Repository at `fc788f5`; `corepack pnpm install --frozen-lockfile`; no source edit, no committed
  script. The probes below ran from `/tmp` and the scripts were deleted afterwards; their source is
  reproduced verbatim in this record so a reader can re-run them.
- **Delivery engine (the app's real path):** `@duckdb/duckdb-wasm@1.32.0` (node bundles from the
  same package, `duckdb-node-blocking.cjs`) → **DuckDB v1.4.3**, `apache-arrow@17.0.0`. This is
  the engine the web app ships (`packages/engine-duckdb/package.json`); the engine client parses
  `tableFromIPC(response.batchIpc)` (`packages/engine-duckdb/src/client.ts:427`) out of
  `tableToIPC(...)` in the worker (`engine-executor.ts:2124`), so a `Table` in this probe and a
  `Table` in the pane hold the same schema.
- **Pinned engine (cross-check):** `@duckdb/node-api@1.5.5-r.5` → **DuckDB v1.5.5**, matching the
  pinned CLI `/tmp/duckdb` v1.5.5. The CLI was used only to read the committed fixtures'
  declared types.
- No timing was measured: this is a capability/evidence probe, not a performance claim.

Every probe prints, per result field:

| printed                         | what it is                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `name`                          | the Arrow field name (the only thing the pane reads today)                   |
| `type`                          | `String(field.type)` — the Arrow type, in Arrow's vocabulary                 |
| `arrowTypeId`                   | Arrow's `Type` enum value                                                    |
| `nullable`                      | `field.nullable`                                                             |
| `metadata`                      | `field.metadata` — Arrow's **custom key/value** metadata on the field        |
| `children`                      | declared child types: struct/union field names, list element, map key/value  |
| `cell`                          | the payload `getChildAt(i).get(0)` hands the formatter (constructor + value) |
| `after tableToIPC/tableFromIPC` | the same field list after the engine's exact wire round-trip                 |

## 3. Verdict

**Present — and type-informative.** For every probed case the result field carries a real Arrow
type, computed expressions and aliases included, at every nesting depth, and it survives the
`tableToIPC`/`tableFromIPC` wire pair unchanged.

**The most decisive observation:** `SELECT t + INTERVAL 1 DAY AS shifted FROM probe` — an alias over
a computed expression, named nowhere in the base table — returns field `shifted`,
`Timestamp<MICROSECOND>` (arrowTypeId 10), the **same type a plain `t` column returns**, and the type
is still `Timestamp<MICROSECOND>` after the wire round-trip. Computed/aliased columns are
**indistinguishable from base columns at the schema level**: both carry name + type + nullable +
(empty) custom metadata, and nothing in the schema marks which is which.

Three qualifications, all measured, none of which removes the channel:

1. **It is the field _type_, not custom metadata.** `field.metadata` is the empty map `{}` in
   every case, and `table.schema.metadata` is `{}` too. A consumer reads `schema.fields[i].type`;
   there is no side-channel to read instead, and nothing to strip.
2. **The type is Arrow's vocabulary, not DuckDB's.** `Timestamp<MICROSECOND>` must be mapped back to
   `TIMESTAMP` before the app's `parseDuckDbType` (which parses DuckDB labels) can classify it. The
   measured crosswalk in §5 shows that mapping is faithful for display purposes and **lossy for two
   labels**: `TIME WITH TIME ZONE` and `TIME` are both `Time64<MICROSECOND>`, and `UUID` is `Utf8`.
3. **The inferred type of a computed expression is engine-version dependent.** The same expression
   `date_trunc('day', TIMESTAMP '2024-02-29 13:45:12.123456')` is declared `DATE` by the shipped
   wasm engine (v1.4.3, `typeof(...)` = `DATE`, Arrow `Date32<DAY>`) and `TIMESTAMP` by the pinned
   1.5.5 engine (CLI and node-api alike). Nothing here is wrong — the type is present in both — but
   no contract may promise that a computed expression's _displayed_ text is stable across engine
   upgrades. See §6.

## 4. Probe A — case matrix (delivery engine)

Setup executed first:

```sql
CREATE TABLE probe(t TIMESTAMP, d DATE, x INTEGER, tm TIME);
INSERT INTO probe VALUES (TIMESTAMP '2024-02-29 13:45:12.123456', DATE '2024-02-29', 7, TIME '13:45:12.123456');
```

Script (`/tmp/wfo2-probe/probe.mjs`, deleted after use):

```js
// SPDX-License-Identifier: AGPL-3.0-or-later
// SCRATCH (never committed): R-5 / WF-O2 type-propagation probe.
// Question: do SQL result columns carry real per-field types for computed
// expressions, function results and aliases — not just base-table columns?
//
// Phase A — the real delivery path: @duckdb/duckdb-wasm 1.32.0 (DuckDB v1.4.3)
//   conn.query(sql) -> apache-arrow Table (same Arrow 17 the app parses out of
//   the worker's Arrow IPC payload), then the exact wire round-trip the engine
//   client performs: tableToIPC -> tableFromIPC.
// Phase B — cross-check on the PINNED engine: @duckdb/node-api 1.5.5-r.5
//   (matches the pinned CLI v1.5.5), including nested logical types.

import { createRequire } from 'node:module'
const require = createRequire('/tmp/wfo2-probe/')
const REPO = '/tmp/pi-agent-ef3638fa-e104-41e-iI2nIJ/pi-agent-ef3638fa-e104-41e'
const DIST = `${REPO}/node_modules/.pnpm/@duckdb+duckdb-wasm@1.32.0/node_modules/@duckdb/duckdb-wasm/dist`
const ARROW = `${REPO}/node_modules/.pnpm/apache-arrow@17.0.0/node_modules/apache-arrow`
const arrow = require(ARROW)

const SETUP = `
CREATE TABLE probe(t TIMESTAMP, d DATE, x INTEGER, tm TIME);
INSERT INTO probe VALUES (TIMESTAMP '2024-02-29 13:45:12.123456', DATE '2024-02-29', 7, TIME '13:45:12.123456');
`

const CASES = [
  ['01 base column', `SELECT t FROM probe`],
  ['02 base column renamed', `SELECT t AS renamed FROM probe`],
  ['03 cast', `SELECT CAST(t AS TIMESTAMP) AS t_cast FROM probe`],
  ['04 expression + alias', `SELECT t + INTERVAL 1 DAY AS shifted FROM probe`],
  ['05 function result (unnamed)', `SELECT date_trunc('day', t) FROM probe`],
  [
    '06 struct w/ computed temporals',
    `SELECT {'inner': t + INTERVAL 1 DAY, 'lit': DATE '2024-02-29'} AS s FROM probe`,
  ],
  ['07 list of temporals', `SELECT [t, t + INTERVAL 1 DAY] AS l FROM probe`],
  ['08 map of temporals', `SELECT MAP {'a': t + INTERVAL 1 DAY} AS m FROM probe`],
  ['09 struct w/ decimal', `SELECT {'v': CAST(1.25 AS DECIMAL(10,2))} AS ds FROM probe`],
  ['10 timestamp_ns literal', `SELECT TIMESTAMP_NS '2024-02-29 13:45:12.123456789' AS ns`],
  [
    '11 paged wrap (as the SQL pane composes)',
    `SELECT * FROM (SELECT t + INTERVAL 1 DAY AS shifted, CAST(d AS TIMESTAMP) AS dts FROM probe) AS _assay_page LIMIT 50 OFFSET 0`,
  ],
  ['12 union w/ temporal member', `SELECT union_value(a := DATE '2024-02-29') AS u`],
  ['13 untyped NULL column', `SELECT NULL AS maybe`],
  ['14 time column', `SELECT tm FROM probe`],
  ['15 timestamptz expression', `SELECT t AT TIME ZONE 'UTC' AS tz FROM probe`],
  ['16 date arithmetic expression', `SELECT d + 1 AS next_day FROM probe`],
  [
    '17 struct through the paged wrap',
    `SELECT * FROM (SELECT {'inner': t + INTERVAL 1 DAY, 'dec': CAST(1.25 AS DECIMAL(10,2))} AS s FROM probe) AS _assay_page LIMIT 50 OFFSET 0`,
  ],
]

function typeChildren(type, depth = 0) {
  const children = type.children ?? []
  if (children.length === 0) return null
  const out = {}
  for (const child of children) {
    out[child.name === '' ? `#${Object.keys(out).length}` : child.name] = {
      type: String(child.type),
      children: depth < 3 ? typeChildren(child.type, depth + 1) : null,
    }
  }
  return out
}

function arrowFieldLine(field) {
  return {
    name: field.name,
    type: String(field.type),
    arrowTypeId: field.typeId,
    nullable: field.nullable,
    // Arrow custom key-value metadata on the field (NOT where the type lives).
    metadata: field.metadata ? Object.fromEntries(field.metadata) : null,
    // Declared child types carried by the same field type (struct/list/map/union).
    children: typeChildren(field.type),
  }
}

function describeCell(value) {
  if (value === null || value === undefined) return `null (${String(value)})`
  if (typeof value === 'bigint') return `bigint ${value.toString()}`
  if (typeof value === 'object') {
    let text
    try {
      text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v))
    } catch {
      text = '<unserializable>'
    }
    return `${value.constructor?.name ?? typeof value} ${text ?? String(value)}`
  }
  return `${typeof value} ${String(value)}`
}

// ---------------------------------------------------------------- Phase A ---
const { createDuckDB, NODE_RUNTIME, SilentLogger } = require(`${DIST}/duckdb-node-blocking.cjs`)
const bundles = {
  mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
  eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
}
const Logger = SilentLogger ?? require(`${DIST}/duckdb-node-blocking.cjs`).VoidLogger
const db = await createDuckDB(bundles, new Logger(), NODE_RUNTIME)
await db.instantiate(() => {})
const conn = db.connect()
console.log(`=== PHASE A — @duckdb/duckdb-wasm 1.32.0, engine ${db.getVersion()} ===`)
console.log(
  `(this is the browser delivery engine the app ships; Arrow ${arrow.__version ?? '17'} on the client)`,
)
for (const statement of SETUP.split(';')
  .map((s) => s.trim())
  .filter(Boolean))
  conn.query(statement)

for (const [label, sql] of CASES) {
  console.log(`\n--- ${label}`)
  console.log(`SQL: ${sql}`)
  const table = conn.query(sql)
  const fields = []
  for (let i = 0; i < table.numCols; i += 1) {
    const field = table.schema.fields[i]
    fields.push({ ...arrowFieldLine(field), cell: describeCell(table.getChildAt(i)?.get(0)) })
  }
  console.log('table.schema.fields:', JSON.stringify(fields, null, 1))
  console.log('table.schema.metadata:', JSON.stringify(table.schema.metadata ?? null))
  // The engine client's exact wire path: worker tableToIPC -> client tableFromIPC.
  const wire = arrow.tableFromIPC(arrow.tableToIPC(table))
  const wireFields = []
  for (let i = 0; i < wire.numCols; i += 1) wireFields.push(arrowFieldLine(wire.schema.fields[i]))
  console.log('after tableToIPC/tableFromIPC:', JSON.stringify(wireFields))
}

// ---------------------------------------------------------------- Phase B ---
const { DuckDBInstance } = require(
  `${REPO}/node_modules/.pnpm/@duckdb+node-api@1.5.5-r.5/node_modules/@duckdb/node-api/lib/duckdb.js`,
)
const instance = await DuckDBInstance.create(':memory:')
const nconn = await instance.connect()
const version = await nconn.runAndReadAll('SELECT version() AS v')
console.log(`\n=== PHASE B — @duckdb/node-api 1.5.5-r.5, engine ${version.getRows()[0][0]} ===`)
await nconn.run(SETUP)

for (const [label, sql] of CASES) {
  console.log(`\n--- ${label}`)
  const result = await nconn.runAndReadAll(sql)
  const types = []
  for (let i = 0; i < result.columnCount; i += 1) {
    types.push({
      name: result.columnName(i),
      duckdbType: String(result.columnType(i)),
      duckdbTypeJson: result.columnTypeJson(i),
      typeId: result.columnTypeId(i),
    })
  }
  console.log('columnName + columnType:', JSON.stringify(types, null, 1))
}
await nconn.close?.()
await instance.close?.()
```

Raw output (`/tmp/wfo2-probe/probe-output.txt`, verbatim):

```text
=== PHASE A — @duckdb/duckdb-wasm 1.32.0, engine v1.4.3 ===
(this is the browser delivery engine the app ships; Arrow 17 on the client)

--- 01 base column
SQL: SELECT t FROM probe
table.schema.fields: [
 {
  "name": "t",
  "type": "Timestamp<MICROSECOND>",
  "arrowTypeId": 10,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709214312123.456"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"t","type":"Timestamp<MICROSECOND>","arrowTypeId":10,"nullable":true,"metadata":{},"children":null}]

--- 02 base column renamed
SQL: SELECT t AS renamed FROM probe
table.schema.fields: [
 {
  "name": "renamed",
  "type": "Timestamp<MICROSECOND>",
  "arrowTypeId": 10,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709214312123.456"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"renamed","type":"Timestamp<MICROSECOND>","arrowTypeId":10,"nullable":true,"metadata":{},"children":null}]

--- 03 cast
SQL: SELECT CAST(t AS TIMESTAMP) AS t_cast FROM probe
table.schema.fields: [
 {
  "name": "t_cast",
  "type": "Timestamp<MICROSECOND>",
  "arrowTypeId": 10,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709214312123.456"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"t_cast","type":"Timestamp<MICROSECOND>","arrowTypeId":10,"nullable":true,"metadata":{},"children":null}]

--- 04 expression + alias
SQL: SELECT t + INTERVAL 1 DAY AS shifted FROM probe
table.schema.fields: [
 {
  "name": "shifted",
  "type": "Timestamp<MICROSECOND>",
  "arrowTypeId": 10,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709300712123.456"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"shifted","type":"Timestamp<MICROSECOND>","arrowTypeId":10,"nullable":true,"metadata":{},"children":null}]

--- 05 function result (unnamed)
SQL: SELECT date_trunc('day', t) FROM probe
table.schema.fields: [
 {
  "name": "date_trunc('day', t)",
  "type": "Date32<DAY>",
  "arrowTypeId": 8,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709164800000"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"date_trunc('day', t)","type":"Date32<DAY>","arrowTypeId":8,"nullable":true,"metadata":{},"children":null}]

--- 06 struct w/ computed temporals
SQL: SELECT {'inner': t + INTERVAL 1 DAY, 'lit': DATE '2024-02-29'} AS s FROM probe
table.schema.fields: [
 {
  "name": "s",
  "type": "Struct<{inner:Timestamp<MICROSECOND>, lit:Date32<DAY>}>",
  "arrowTypeId": 13,
  "nullable": true,
  "metadata": {},
  "children": {
   "inner": {
    "type": "Timestamp<MICROSECOND>",
    "children": null
   },
   "lit": {
    "type": "Date32<DAY>",
    "children": null
   }
  },
  "cell": "StructRow {\"inner\":1709300712123.456,\"lit\":1709164800000}"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"s","type":"Struct<{inner:Timestamp<MICROSECOND>, lit:Date32<DAY>}>","arrowTypeId":13,"nullable":true,"metadata":{},"children":{"inner":{"type":"Timestamp<MICROSECOND>","children":null},"lit":{"type":"Date32<DAY>","children":null}}}]

--- 07 list of temporals
SQL: SELECT [t, t + INTERVAL 1 DAY] AS l FROM probe
table.schema.fields: [
 {
  "name": "l",
  "type": "List<Timestamp<MICROSECOND>>",
  "arrowTypeId": 12,
  "nullable": true,
  "metadata": {},
  "children": {
   "l": {
    "type": "Timestamp<MICROSECOND>",
    "children": null
   }
  },
  "cell": "Vector [1709214312123.456,1709300712123.456]"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"l","type":"List<Timestamp<MICROSECOND>>","arrowTypeId":12,"nullable":true,"metadata":{},"children":{"l":{"type":"Timestamp<MICROSECOND>","children":null}}}]

--- 08 map of temporals
SQL: SELECT MAP {'a': t + INTERVAL 1 DAY} AS m FROM probe
table.schema.fields: [
 {
  "name": "m",
  "type": "Map<{key:Utf8, value:Timestamp<MICROSECOND>}>",
  "arrowTypeId": 17,
  "nullable": true,
  "metadata": {},
  "children": {
   "entries": {
    "type": "Struct<{key:Utf8, value:Timestamp<MICROSECOND>}>",
    "children": {
     "key": {
      "type": "Utf8",
      "children": null
     },
     "value": {
      "type": "Timestamp<MICROSECOND>",
      "children": null
     }
    }
   }
  },
  "cell": "MapRow {\"a\":1709300712123.456}"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"m","type":"Map<{key:Utf8, value:Timestamp<MICROSECOND>}>","arrowTypeId":17,"nullable":true,"metadata":{},"children":{"entries":{"type":"Struct<{key:Utf8, value:Timestamp<MICROSECOND>}>","children":{"key":{"type":"Utf8","children":null},"value":{"type":"Timestamp<MICROSECOND>","children":null}}}}}]

--- 09 struct w/ decimal
SQL: SELECT {'v': CAST(1.25 AS DECIMAL(10,2))} AS ds FROM probe
table.schema.fields: [
 {
  "name": "ds",
  "type": "Struct<{v:Decimal[10e+2]}>",
  "arrowTypeId": 13,
  "nullable": true,
  "metadata": {},
  "children": {
   "v": {
    "type": "Decimal[10e+2]",
    "children": null
   }
  },
  "cell": "StructRow {\"v\":\"\\\"125\\\"\"}"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"ds","type":"Struct<{v:Decimal[10e+2]}>","arrowTypeId":13,"nullable":true,"metadata":{},"children":{"v":{"type":"Decimal[10e+2]","children":null}}}]

--- 10 timestamp_ns literal
SQL: SELECT TIMESTAMP_NS '2024-02-29 13:45:12.123456789' AS ns
table.schema.fields: [
 {
  "name": "ns",
  "type": "Timestamp<NANOSECOND>",
  "arrowTypeId": 10,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709214312123.4568"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"ns","type":"Timestamp<NANOSECOND>","arrowTypeId":10,"nullable":true,"metadata":{},"children":null}]

--- 11 paged wrap (as the SQL pane composes)
SQL: SELECT * FROM (SELECT t + INTERVAL 1 DAY AS shifted, CAST(d AS TIMESTAMP) AS dts FROM probe) AS _assay_page LIMIT 50 OFFSET 0
table.schema.fields: [
 {
  "name": "shifted",
  "type": "Timestamp<MICROSECOND>",
  "arrowTypeId": 10,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709300712123.456"
 },
 {
  "name": "dts",
  "type": "Timestamp<MICROSECOND>",
  "arrowTypeId": 10,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709164800000"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"shifted","type":"Timestamp<MICROSECOND>","arrowTypeId":10,"nullable":true,"metadata":{},"children":null},{"name":"dts","type":"Timestamp<MICROSECOND>","arrowTypeId":10,"nullable":true,"metadata":{},"children":null}]

--- 12 union w/ temporal member
SQL: SELECT union_value(a := DATE '2024-02-29') AS u
table.schema.fields: [
 {
  "name": "u",
  "type": "Union<Date32<DAY>>",
  "arrowTypeId": 14,
  "nullable": true,
  "metadata": {},
  "children": {
   "a": {
    "type": "Date32<DAY>",
    "children": null
   }
  },
  "cell": "number 1709164800000"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"u","type":"Union<Date32<DAY>>","arrowTypeId":14,"nullable":true,"metadata":{},"children":{"a":{"type":"Date32<DAY>","children":null}}}]

--- 13 untyped NULL column
SQL: SELECT NULL AS maybe
table.schema.fields: [
 {
  "name": "maybe",
  "type": "Int32",
  "arrowTypeId": 2,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "null (null)"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"maybe","type":"Int32","arrowTypeId":2,"nullable":true,"metadata":{},"children":null}]

--- 14 time column
SQL: SELECT tm FROM probe
table.schema.fields: [
 {
  "name": "tm",
  "type": "Time64<MICROSECOND>",
  "arrowTypeId": 9,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "bigint 49512123456"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"tm","type":"Time64<MICROSECOND>","arrowTypeId":9,"nullable":true,"metadata":{},"children":null}]

--- 15 timestamptz expression
SQL: SELECT t AT TIME ZONE 'UTC' AS tz FROM probe
table.schema.fields: [
 {
  "name": "tz",
  "type": "Timestamp<MICROSECOND, UTC>",
  "arrowTypeId": 10,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709214312123.456"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"tz","type":"Timestamp<MICROSECOND, UTC>","arrowTypeId":10,"nullable":true,"metadata":{},"children":null}]

--- 16 date arithmetic expression
SQL: SELECT d + 1 AS next_day FROM probe
table.schema.fields: [
 {
  "name": "next_day",
  "type": "Date32<DAY>",
  "arrowTypeId": 8,
  "nullable": true,
  "metadata": {},
  "children": null,
  "cell": "number 1709251200000"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"next_day","type":"Date32<DAY>","arrowTypeId":8,"nullable":true,"metadata":{},"children":null}]

--- 17 struct through the paged wrap
SQL: SELECT * FROM (SELECT {'inner': t + INTERVAL 1 DAY, 'dec': CAST(1.25 AS DECIMAL(10,2))} AS s FROM probe) AS _assay_page LIMIT 50 OFFSET 0
table.schema.fields: [
 {
  "name": "s",
  "type": "Struct<{inner:Timestamp<MICROSECOND>, dec:Decimal[10e+2]}>",
  "arrowTypeId": 13,
  "nullable": true,
  "metadata": {},
  "children": {
   "inner": {
    "type": "Timestamp<MICROSECOND>",
    "children": null
   },
   "dec": {
    "type": "Decimal[10e+2]",
    "children": null
   }
  },
  "cell": "StructRow {\"inner\":1709300712123.456,\"dec\":\"\\\"125\\\"\"}"
 }
]
table.schema.metadata: {}
after tableToIPC/tableFromIPC: [{"name":"s","type":"Struct<{inner:Timestamp<MICROSECOND>, dec:Decimal[10e+2]}>","arrowTypeId":13,"nullable":true,"metadata":{},"children":{"inner":{"type":"Timestamp<MICROSECOND>","children":null},"dec":{"type":"Decimal[10e+2]","children":null}}}]

=== PHASE B — @duckdb/node-api 1.5.5-r.5, engine v1.5.5 ===

--- 01 base column
columnName + columnType: [
 {
  "name": "t",
  "duckdbType": "TIMESTAMP",
  "duckdbTypeJson": {
   "typeId": 12
  },
  "typeId": 12
 }
]

--- 02 base column renamed
columnName + columnType: [
 {
  "name": "renamed",
  "duckdbType": "TIMESTAMP",
  "duckdbTypeJson": {
   "typeId": 12
  },
  "typeId": 12
 }
]

--- 03 cast
columnName + columnType: [
 {
  "name": "t_cast",
  "duckdbType": "TIMESTAMP",
  "duckdbTypeJson": {
   "typeId": 12
  },
  "typeId": 12
 }
]

--- 04 expression + alias
columnName + columnType: [
 {
  "name": "shifted",
  "duckdbType": "TIMESTAMP",
  "duckdbTypeJson": {
   "typeId": 12
  },
  "typeId": 12
 }
]

--- 05 function result (unnamed)
columnName + columnType: [
 {
  "name": "date_trunc('day', t)",
  "duckdbType": "TIMESTAMP",
  "duckdbTypeJson": {
   "typeId": 12
  },
  "typeId": 12
 }
]

--- 06 struct w/ computed temporals
columnName + columnType: [
 {
  "name": "s",
  "duckdbType": "STRUCT(\"inner\" TIMESTAMP, \"lit\" DATE)",
  "duckdbTypeJson": {
   "typeId": 25,
   "entryNames": [
    "inner",
    "lit"
   ],
   "entryTypes": [
    {
     "typeId": 12
    },
    {
     "typeId": 13
    }
   ]
  },
  "typeId": 25
 }
]

--- 07 list of temporals
columnName + columnType: [
 {
  "name": "l",
  "duckdbType": "TIMESTAMP[]",
  "duckdbTypeJson": {
   "typeId": 24,
   "valueType": {
    "typeId": 12
   }
  },
  "typeId": 24
 }
]

--- 08 map of temporals
columnName + columnType: [
 {
  "name": "m",
  "duckdbType": "MAP(VARCHAR, TIMESTAMP)",
  "duckdbTypeJson": {
   "typeId": 26,
   "keyType": {
    "typeId": 17
   },
   "valueType": {
    "typeId": 12
   }
  },
  "typeId": 26
 }
]

--- 09 struct w/ decimal
columnName + columnType: [
 {
  "name": "ds",
  "duckdbType": "STRUCT(\"v\" DECIMAL(10,2))",
  "duckdbTypeJson": {
   "typeId": 25,
   "entryNames": [
    "v"
   ],
   "entryTypes": [
    {
     "typeId": 19,
     "width": 10,
     "scale": 2
    }
   ]
  },
  "typeId": 25
 }
]

--- 10 timestamp_ns literal
columnName + columnType: [
 {
  "name": "ns",
  "duckdbType": "TIMESTAMP_NS",
  "duckdbTypeJson": {
   "typeId": 22
  },
  "typeId": 22
 }
]

--- 11 paged wrap (as the SQL pane composes)
columnName + columnType: [
 {
  "name": "shifted",
  "duckdbType": "TIMESTAMP",
  "duckdbTypeJson": {
   "typeId": 12
  },
  "typeId": 12
 },
 {
  "name": "dts",
  "duckdbType": "TIMESTAMP",
  "duckdbTypeJson": {
   "typeId": 12
  },
  "typeId": 12
 }
]

--- 12 union w/ temporal member
columnName + columnType: [
 {
  "name": "u",
  "duckdbType": "UNION(\"a\" DATE)",
  "duckdbTypeJson": {
   "typeId": 28,
   "memberTags": [
    "a"
   ],
   "memberTypes": [
    {
     "typeId": 13
    }
   ]
  },
  "typeId": 28
 }
]

--- 13 untyped NULL column
columnName + columnType: [
 {
  "name": "maybe",
  "duckdbType": "INTEGER",
  "duckdbTypeJson": {
   "typeId": 4
  },
  "typeId": 4
 }
]

--- 14 time column
columnName + columnType: [
 {
  "name": "tm",
  "duckdbType": "TIME",
  "duckdbTypeJson": {
   "typeId": 14
  },
  "typeId": 14
 }
]

--- 15 timestamptz expression
columnName + columnType: [
 {
  "name": "tz",
  "duckdbType": "TIMESTAMP WITH TIME ZONE",
  "duckdbTypeJson": {
   "typeId": 31
  },
  "typeId": 31
 }
]

--- 16 date arithmetic expression
columnName + columnType: [
 {
  "name": "next_day",
  "duckdbType": "DATE",
  "duckdbTypeJson": {
   "typeId": 13
  },
  "typeId": 13
 }
]

--- 17 struct through the paged wrap
columnName + columnType: [
 {
  "name": "s",
  "duckdbType": "STRUCT(\"inner\" TIMESTAMP, \"dec\" DECIMAL(10,2))",
  "duckdbTypeJson": {
   "typeId": 25,
   "entryNames": [
    "inner",
    "dec"
   ],
   "entryTypes": [
    {
     "typeId": 12
    },
    {
     "typeId": 19,
     "width": 10,
     "scale": 2
    }
   ]
  },
  "typeId": 25
 }
]
```

### Payload shapes (probe B, `/tmp/wfo2-probe/leaf.mjs`, deleted after use)

The same run also records what the _value_ side looks like, because the contract's fail-soft rule is
about payload/type mismatches. Script:

```js
import { createRequire } from 'node:module'
const require = createRequire('/tmp/wfo2-probe/')
const REPO = '/tmp/pi-agent-ef3638fa-e104-41e-iI2nIJ/pi-agent-ef3638fa-e104-41e'
const DIST = `${REPO}/node_modules/.pnpm/@duckdb+duckdb-wasm@1.32.0/node_modules/@duckdb/duckdb-wasm/dist`
const { createDuckDB, NODE_RUNTIME, VoidLogger } = require(`${DIST}/duckdb-node-blocking.cjs`)
const db = await createDuckDB(
  {
    mvp: {
      mainModule: `${DIST}/duckdb-mvp.wasm`,
      mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs`,
    },
    eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
  },
  new VoidLogger(),
  NODE_RUNTIME,
)
await db.instantiate(() => {})
const conn = db.connect()
conn.query(`CREATE TABLE probe(t TIMESTAMP, d DATE, x INTEGER, tm TIME)`)
conn.query(
  `INSERT INTO probe VALUES (TIMESTAMP '2024-02-29 13:45:12.123456', DATE '2024-02-29', 7, TIME '13:45:12.123456')`,
)
const describe = (v, depth = 0) => {
  if (v === null) return 'null'
  const tag = typeof v
  if (tag !== 'object') return `${tag}:${String(v)}`
  const ctor = v.constructor?.name ?? 'object'
  const keys = Object.keys(v).slice(0, 6)
  return `${ctor} keys=[${keys.join(',')}]${depth < 2 ? ' ' + JSON.stringify(keys.map((k) => describe(v[k], depth + 1))) : ''}`
}
const cases = [
  [
    'struct computed temporal+decimal',
    `SELECT {'inner': t + INTERVAL 1 DAY, 'dec': CAST(1.25 AS DECIMAL(10,2)), 'raw': t} AS s FROM probe`,
  ],
  ['list temporal', `SELECT [t, t + INTERVAL 1 DAY] AS l FROM probe`],
  ['list decimal', `SELECT [CAST(1.25 AS DECIMAL(10,2))] AS ld FROM probe`],
  ['map temporal', `SELECT MAP {'a': t + INTERVAL 1 DAY} AS m FROM probe`],
  ['scalar decimal', `SELECT CAST(1.25 AS DECIMAL(10,2)) AS dec`],
  ['scalar date/timestamp/time', `SELECT d, t, tm FROM probe`],
]
for (const [label, sql] of cases) {
  const table = conn.query(sql)
  const out = []
  for (let i = 0; i < table.numCols; i += 1) {
    out.push({
      field: table.schema.fields[i].name,
      type: String(table.schema.fields[i].type),
      cell: describe(table.getChildAt(i).get(0)),
    })
  }
  console.log(`--- ${label}\n${JSON.stringify(out, null, 1)}`)
}
```

Raw output:

```text
--- struct computed temporal+decimal
[
 {
  "field": "s",
  "type": "Struct<{inner:Timestamp<MICROSECOND>, dec:Decimal[10e+2], raw:Timestamp<MICROSECOND>}>",
  "cell": "StructRow keys=[inner,dec,raw] [\"number:1709300712123.456\",\"DecimalBigNum keys=[0,1,2,3] [\\\"number:125\\\",\\\"number:0\\\",\\\"number:0\\\",\\\"number:0\\\"]\",\"number:1709214312123.456\"]"
 }
]
--- list temporal
[
 {
  "field": "l",
  "type": "List<Timestamp<MICROSECOND>>",
  "cell": "Vector keys=[isValid,get,set,indexOf,_offsets,data] [\"function:(index) => (0, chunk_js_1.isChunkedValid)(unchunkedData, index)\",\"function:(index) => get(unchunkedData, index)\",\"function:(index, value) => set(unchunkedData, index, value)\",\"function:(index) => indexOf(unchunkedData, index)\",\"Array keys=[0,1] [\\\"number:0\\\",\\\"number:2\\\"]\",\"Array keys=[0] [\\\"Data keys=[type,children,dictionary,offset,length,_nullCount]\\\"]\"]"
 }
]
--- list decimal
[
 {
  "field": "ld",
  "type": "List<Decimal[10e+2]>",
  "cell": "Vector keys=[isValid,get,set,indexOf,_offsets,data] [\"function:(index) => (0, chunk_js_1.isChunkedValid)(unchunkedData, index)\",\"function:(index) => get(unchunkedData, index)\",\"function:(index, value) => set(unchunkedData, index, value)\",\"function:(index) => indexOf(unchunkedData, index)\",\"Array keys=[0,1] [\\\"number:0\\\",\\\"number:1\\\"]\",\"Array keys=[0] [\\\"Data keys=[type,children,dictionary,offset,length,_nullCount]\\\"]\"]"
 }
]
--- map temporal
[
 {
  "field": "m",
  "type": "Map<{key:Utf8, value:Timestamp<MICROSECOND>}>",
  "cell": "MapRow keys=[a] [\"number:1709300712123.456\"]"
 }
]
--- scalar decimal
[
 {
  "field": "dec",
  "type": "Decimal[10e+2]",
  "cell": "DecimalBigNum keys=[0,1,2,3] [\"number:125\",\"number:0\",\"number:0\",\"number:0\"]"
 }
]
--- scalar date/timestamp/time
[
 {
  "field": "d",
  "type": "Date32<DAY>",
  "cell": "number:1709164800000"
 },
 {
  "field": "t",
  "type": "Timestamp<MICROSECOND>",
  "cell": "number:1709214312123.456"
 },
 {
  "field": "tm",
  "type": "Time64<MICROSECOND>",
  "cell": "bigint:49512123456"
 }
]
```

## 5. Probe C — declared DuckDB type ⇄ Arrow field type crosswalk (delivery engine)

So that §5's mapping discussion is measured rather than assumed; every row is a real result field.

Script (`/tmp/wfo2-probe/crosswalk.mjs`, deleted after use):

```js
// SCRATCH (never committed): R-5 / WF-O2 — DuckDB declared type -> Arrow field
// type crosswalk on the delivery engine, so the contract's mapping table is
// measured rather than assumed.
import { createRequire } from 'node:module'
const require = createRequire('/tmp/wfo2-probe/')
const REPO = '/tmp/pi-agent-ef3638fa-e104-41e-iI2nIJ/pi-agent-ef3638fa-e104-41e'
const DIST = `${REPO}/node_modules/.pnpm/@duckdb+duckdb-wasm@1.32.0/node_modules/@duckdb/duckdb-wasm/dist`
const { createDuckDB, NODE_RUNTIME, VoidLogger } = require(`${DIST}/duckdb-node-blocking.cjs`)
const db = await createDuckDB(
  {
    mvp: {
      mainModule: `${DIST}/duckdb-mvp.wasm`,
      mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs`,
    },
    eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
  },
  new VoidLogger(),
  NODE_RUNTIME,
)
await db.instantiate(() => {})
const conn = db.connect()
console.log('engine', conn.query('SELECT version() AS v').getChildAt(0).get(0))

const CASTS = [
  ['DATE', `CAST(DATE '2024-02-29' AS DATE)`],
  ['TIMESTAMP', `CAST(TIMESTAMP '2024-02-29 13:45:12.123456' AS TIMESTAMP)`],
  ['TIMESTAMP_S', `CAST(TIMESTAMP '2024-02-29 13:45:12' AS TIMESTAMP_S)`],
  ['TIMESTAMP_MS', `CAST(TIMESTAMP '2024-02-29 13:45:12.123' AS TIMESTAMP_MS)`],
  ['TIMESTAMP_NS', `CAST(TIMESTAMP '2024-02-29 13:45:12.123456789' AS TIMESTAMP_NS)`],
  [
    'TIMESTAMP WITH TIME ZONE',
    `CAST(TIMESTAMP '2024-02-29 13:45:12.123456' AS TIMESTAMP WITH TIME ZONE)`,
  ],
  ['TIME', `CAST(TIME '13:45:12.123456' AS TIME)`],
  ['TIME WITH TIME ZONE', `CAST(TIME '13:45:12.123456' AS TIME WITH TIME ZONE)`],
  ['DECIMAL(10,2)', `CAST(1.25 AS DECIMAL(10,2))`],
  ['HUGEINT', `CAST(1 AS HUGEINT)`],
  ['UHUGEINT', `CAST(1 AS UHUGEINT)`],
  ['BIGINT', `CAST(1 AS BIGINT)`],
  ['INTEGER', `CAST(1 AS INTEGER)`],
  ['BOOLEAN', `CAST(1 AS BOOLEAN)`],
  ['VARCHAR', `CAST(1 AS VARCHAR)`],
  ['BLOB', `CAST('a' AS BLOB)`],
  ['INTERVAL', `INTERVAL 1 DAY`],
  ['UUID', `CAST('00000000-0000-0000-0000-000000000000' AS UUID)`],
  [
    'STRUCT(v DECIMAL(10,2), t TIMESTAMP)',
    `{'v': CAST(1.25 AS DECIMAL(10,2)), 't': TIMESTAMP '2024-02-29 13:45:12.123456'}`,
  ],
  ['DECIMAL(10,2)[]', `[CAST(1.25 AS DECIMAL(10,2))]`],
  ['MAP(VARCHAR, TIMESTAMP)', `MAP {'a': TIMESTAMP '2024-02-29 13:45:12.123456'}`],
  ['UNION(a DATE, b TIMESTAMP)', `union_value(a := DATE '2024-02-29')`],
]

for (const [duckdbLabel, expression] of CASTS) {
  const sql = `SELECT typeof(${expression}) AS declared, ${expression} AS value`
  const table = conn.query(sql)
  const declared = table.getChildAt(0).get(0)
  const field = table.schema.fields[1]
  const value = table.getChildAt(1).get(0)
  const shape =
    value === null
      ? 'null'
      : typeof value === 'object'
        ? (value.constructor?.name ?? 'object')
        : typeof value
  console.log(
    `${duckdbLabel.padEnd(42)} | declared: ${String(declared).padEnd(34)} | arrow: ${String(field.type).padEnd(46)} | payload: ${shape}`,
  )
}
```

Raw output (engine v1.4.3):

```text
engine v1.4.3
DATE                                       | declared: DATE                               | arrow: Date32<DAY>                                    | payload: number
TIMESTAMP                                  | declared: TIMESTAMP                          | arrow: Timestamp<MICROSECOND>                         | payload: number
TIMESTAMP_S                                | declared: TIMESTAMP_S                        | arrow: Timestamp<SECOND>                              | payload: number
TIMESTAMP_MS                               | declared: TIMESTAMP_MS                       | arrow: Timestamp<MILLISECOND>                         | payload: number
TIMESTAMP_NS                               | declared: TIMESTAMP_NS                       | arrow: Timestamp<NANOSECOND>                          | payload: number
TIMESTAMP WITH TIME ZONE                   | declared: TIMESTAMP WITH TIME ZONE           | arrow: Timestamp<MICROSECOND, UTC>                    | payload: number
TIME                                       | declared: TIME                               | arrow: Time64<MICROSECOND>                            | payload: bigint
TIME WITH TIME ZONE                        | declared: TIME WITH TIME ZONE                | arrow: Time64<MICROSECOND>                            | payload: bigint
DECIMAL(10,2)                              | declared: DECIMAL(10,2)                      | arrow: Decimal[10e+2]                                 | payload: DecimalBigNum
HUGEINT                                    | declared: HUGEINT                            | arrow: Decimal[38e0]                                  | payload: DecimalBigNum
UHUGEINT                                   | declared: UHUGEINT                           | arrow: FixedSizeBinary[16]                            | payload: Uint8Array
BIGINT                                     | declared: BIGINT                             | arrow: Int64                                          | payload: bigint
INTEGER                                    | declared: INTEGER                            | arrow: Int32                                          | payload: number
BOOLEAN                                    | declared: BOOLEAN                            | arrow: Bool                                           | payload: boolean
VARCHAR                                    | declared: VARCHAR                            | arrow: Utf8                                           | payload: string
BLOB                                       | declared: BLOB                               | arrow: Binary                                         | payload: Uint8Array
INTERVAL                                   | declared: INTERVAL                           | arrow: Interval<MONTH_DAY_NANO>                       | payload: Int32Array
UUID                                       | declared: UUID                               | arrow: Utf8                                           | payload: string
STRUCT(v DECIMAL(10,2), t TIMESTAMP)       | declared: STRUCT(v DECIMAL(10,2), t TIMESTAMP) | arrow: Struct<{v:Decimal[10e+2], t:Timestamp<MICROSECOND>}> | payload: StructRow
DECIMAL(10,2)[]                            | declared: DECIMAL(10,2)[]                    | arrow: List<Decimal[10e+2]>                           | payload: Vector
MAP(VARCHAR, TIMESTAMP)                    | declared: MAP(VARCHAR, TIMESTAMP)            | arrow: Map<{key:Utf8, value:Timestamp<MICROSECOND>}>  | payload: MapRow
UNION(a DATE, b TIMESTAMP)                 | declared: UNION(a DATE)                      | arrow: Union<Date32<DAY>>                             | payload: number
```

Two rows deserve emphasis because they are Arrow-side losses, not DuckDB-side ones:

- `TIME WITH TIME ZONE` and `TIME` both arrive as `Time64<MICROSECOND>` with a **bigint µs**
  payload, so the Arrow schema cannot tell them apart. Both belong to the scalar contract's `time`
  display family (`apps/web/src/grid/temporal-display.ts`), so the _display_ is unaffected; only a
  claim about reconstructing the exact DuckDB label is barred.
- `UUID` arrives as `Utf8` and `UHUGEINT` as `FixedSizeBinary[16]`. Neither is temporal. A mapping
  that needs `UHUGEINT` must treat `FixedSizeBinary[16]` as _possibly_ UHUGEINT and fall back to
  `null` (raw) if that ever becomes ambiguous — the fail-soft rule, not a guess.

## 6. Probe D — engine-version skew on a computed expression

`/tmp/wfo2-probe/typeof.mjs` (deleted after use) asked the delivery engine to declare its own types:

```js
import { createRequire } from 'node:module'
const require = createRequire('/tmp/wfo2-probe/')
const REPO = '/tmp/pi-agent-ef3638fa-e104-41e-iI2nIJ/pi-agent-ef3638fa-e104-41e'
const DIST = `${REPO}/node_modules/.pnpm/@duckdb+duckdb-wasm@1.32.0/node_modules/@duckdb/duckdb-wasm/dist`
const { createDuckDB, NODE_RUNTIME, VoidLogger } = require(`${DIST}/duckdb-node-blocking.cjs`)
const db = await createDuckDB(
  {
    mvp: {
      mainModule: `${DIST}/duckdb-mvp.wasm`,
      mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs`,
    },
    eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
  },
  new VoidLogger(),
  NODE_RUNTIME,
)
await db.instantiate(() => {})
const conn = db.connect()
const t =
  conn.query(`SELECT typeof(date_trunc('day', TIMESTAMP '2024-02-29 13:45:12.123456')) AS dt,
  typeof(TIMESTAMP '2024-02-29 13:45:12.123456' + INTERVAL 1 DAY) AS shifted,
  typeof(TIMESTAMP '2024-02-29 13:45:12.123456' AT TIME ZONE 'UTC') AS tz,
  version() AS v`)
console.log('wasm version:', t.getChildAt(3).get(0))
for (const [i, name] of [
  [0, 'date_trunc'],
  [1, '+INTERVAL'],
  [2, 'AT TIME ZONE'],
]) {
  console.log(
    name,
    '->',
    t.getChildAt(i).get(0),
    '| arrow field type:',
    String(t.schema.fields[i].type),
  )
}
```

Output:

```text
wasm version: v1.4.3
date_trunc -> DATE | arrow field type: Utf8
+INTERVAL -> TIMESTAMP | arrow field type: Utf8
AT TIME ZONE -> TIMESTAMP WITH TIME ZONE | arrow field type: Utf8
```

The pinned CLI v1.5.5 disagrees on the same expression:

```text
$ export DUCKDB=/tmp/duckdb PATH=/tmp:$PATH
$ duckdb -c "SELECT typeof(date_trunc('day', TIMESTAMP '2024-02-29 13:45:12.123456')) AS dt, \
    typeof(TIMESTAMP '2024-02-29 13:45:12.123456' + INTERVAL 1 DAY) AS shifted, \
    typeof(CAST(TIMESTAMP '2024-02-29' AS TIMESTAMP)) AS cast_t;"
┌───────────┬───────────┬───────────┐
│    dt     │  shifted  │  cast_t   │
│  varchar  │  varchar  │  varchar  │
├───────────┼───────────┼───────────┤
│ TIMESTAMP │ TIMESTAMP │ TIMESTAMP │
└───────────┴───────────┴───────────┘
```

Recorded consequence: the type channel is real in both engines, but a **computed expression's
declared type is the delivering engine's inference**. Any parity claim is therefore
"identical to the scalar cell rendered from the same declared type", never "this expression always
renders `YYYY-MM-DD`".

## 7. What this probe does not establish

- No index of _how many_ SQL shapes exist: the matrix covers a plain column, an alias over a base
  column, a cast, an expression alias, an unnamed function result, a struct, a list, a map, a union,
  a decimal-in-struct, an `ns` literal, an untyped `NULL` column, `TIME`, `TIMESTAMPTZ`, date
  arithmetic, and the pane's own paged wrap. Exotic shapes (lambda results, `ANY`/`JSON`, lateral
  unnest, aggregates over nested types) were not probed.
- Nothing about rendering: no display text, no parity, no cost was measured here.
- Nothing about the _other_ nesting consumers (`nested-preview.ts`, `record-tree.ts`) — their inputs
  are the payloads in probe B and the declared types from the engine schema, both unchanged.
- Nothing about `TIMESTAMP_NS` payload recovery: probe A's `ns` case reproduces the known float-ms
  loss (`1709214312123.4568`), which is exactly why the scalar contract keeps it raw.
