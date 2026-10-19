# Vendored engine assets (ptv1-2)

The webview boots DuckDB-WASM and opens datasets with **ZERO network fetches**.
The DuckDB runtime and both extension binaries in this directory are committed
verbatim and pinned; the build (`scripts/build.mjs`) verifies their SHA-256
checksums and byte-equality with the lockfile-pinned npm package for runtime
files before copying them to `dist/webview/`
(under their canonical names — the mapping lives in `scripts/build.mjs`).

**Why the `.pinned` suffix:** the committed files carry an extra extension so
formatters skip them (prettier ignores unknown extensions). The ptv1-2
checksum gate caught `pnpm format` silently re-writing the vendored glue
worker — with the suffix, the pinned bytes can never be reformatted in place;
any deliberate re-vendor goes through the documented flow below.

## The pin

| What                    | Value                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `@duckdb/duckdb-wasm`   | **1.32.0** (the version pinned in `pnpm-lock.yaml`; do NOT bump — a bump is a format/behavior change) |
| Embedded DuckDB runtime | **v1.4.3** (asserted at runtime by the harness from the booted engine's `getVersion()`)               |
| Extension platform      | `wasm_mvp` (the `mvp` bundle is the one production ships)                                             |

| File                            | Bytes      | SHA-256                                                            | Source                                                                                                         |
| ------------------------------- | ---------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `duckdb-mvp.wasm`               | 39,362,651 | `45d72a81fba8e57693d890da837c7041310e385e75619a8559839b15388dfe97` | `@duckdb/duckdb-wasm@1.32.0` (byte-identical to the lockfile package)                                          |
| `duckdb-browser-mvp.worker.js`  | 844,644    | `b0387027f174e2b60c2d5cfa31cecca9b89d8a9762346b6449a784cd1c4dde3c` | `@duckdb/duckdb-wasm@1.32.0` (byte-identical to the lockfile package)                                          |
| `parquet.duckdb_extension.wasm` | 2,867,304  | `0785c6c95d003eff4faa7b3b4b660f02c9c92f6d68d135ddf330d42e3a650600` | fetched ONCE at vendor time from `https://extensions.duckdb.org/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm` |
| `json.duckdb_extension.wasm`    | 722,006    | `5771b6d57335eca8e2ba4fdaacb491a53b49577bd7f1b0c39e2cd7a39b4e9313` | fetched ONCE at vendor time from `https://extensions.duckdb.org/v1.4.3/wasm_mvp/json.duckdb_extension.wasm` |

The machine-readable pin (checksums + versions + source URLs) is the
`VENDORED_ASSETS` constant in `scripts/build.mjs`; both Parquet and JSON
extensions are locally served at their exact DuckDB 1.4.3 autoload paths; the build FAILS on any
drift between this directory, those checksums, and the lockfile package.
The runtime pin is asserted by the harness: the report's `bundles.mvp.version`
must be `v1.4.3`, matching the vendored extension's version.

## Why the Parquet extension is vendored

`read_parquet` is not statically linked in the `mvp` build: in stock
DuckDB-WASM 1.32.0 it **autoloads the extension over the network** from
`https://extensions.duckdb.org/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm`
(R4 feasibility report §Q5b: `loaded: true, installed: false`). Vendoring
turns that autoload into a local serve: the shim appended to the vendored
glue worker answers the autoload URL from the vendored bytes in memory, so
the engine loads the official binary and NO request ever reaches the
network. The post-open probe reads `loaded: true` with the network block
armed — the Q5b signature, earned locally.

Recorded finding (2026-10-12, ptv1-2): registering the vendored binary into
the engine's virtual filesystem (`REGISTER_FILE_BUFFER`) and running
`INSTALL`/`LOAD` locally works for direct file reads (`read_csv` resolves
registered buffers), but the extension loader's own existence check does not
see registered buffers in DuckDB-WASM 1.32.0 and falls through to its HTTP
filesystem. The local serve answers at the network boundary instead —
independent of the engine's FS semantics, byte-identical outcome.

## Network-block pin (Q5b fixed)

The harness runs **network-blocked for the CDN** by two in-harness layers
(no proxy/hosts changes needed to reproduce):

1. **CSP** — the webview's `connect-src` no longer contains
   `https://extensions.duckdb.org` (removed in ptv1-2; the browser refuses
   any such request before it reaches the network).
2. **In-worker interceptor** — the vendored-asset shim appended (unmodified
   glue text + appended shim; the pinned bytes are not altered) to the
   DuckDB glue worker serves the autoload URL from the vendored bytes and
   refuses any OTHER `fetch`/`XMLHttpRequest` to `extensions.duckdb.org`
   with a thrown `assay-netblock-refusal: …` error.

The vendored run PASSES under the block (positive proof: the shim reports the
vendored bytes in hand, the fixture opens, and the extension reports
`loaded: true` with no network). The drill run —
`ASSAY_SPIKE_DRILL=missing-extension corepack pnpm --filter @assay/vscode run:spike`
— ships no vendored bytes so the stock autoload path is exercised: the open
FAILS with the refused CDN fetch, reproducing the Q5b failure mode under the
block (structural proof that a non-vendored asset WOULD fetch and be caught).

## Re-vendoring deliberately (e.g. on a version bump)

1. Bump `@duckdb/duckdb-wasm` in `apps/vscode/package.json` AND update
   `duckdbWasmVersion`/`duckdbVersion`/`autoloadPath` here, in
   `scripts/build.mjs`, and in `apps/vscode/src/extension.ts` — one deliberate
   change, never a silent copy.
2. Copy the new `duckdb-mvp.wasm` + `duckdb-browser-mvp.worker.js` from the
   package into this directory with the `.pinned` suffix.
3. Fetch the matching extension binary ONCE from
   `https://extensions.duckdb.org/<new-version>/wasm_mvp/parquet.duckdb_extension.wasm`.
4. Recompute the SHA-256 values and update them in `scripts/build.mjs` and
   the table above. The build fails until everything agrees.

## License note

DuckDB-WASM (and its prebuilt `duckdb-mvp.wasm` /
`duckdb-browser-mvp.worker.js` / extension binaries as distributed on
extensions.duckdb.org) is **MIT-licensed — AGPL-compatible** per the license
rule in `AGENTS.md` (the repository is AGPL-3.0-or-later, ADR 0036). The
npm metadata declares `license: "MIT"`, but the 1.32.0 package ships no
LICENSE file — the vendored binaries here are byte-identical to that MIT
package (DuckDB's own MIT distribution). Since ptv1-3 the full MIT text is
committed alongside the binaries as
[`LICENSE.duckdb-wasm.txt`](LICENSE.duckdb-wasm.txt) (verbatim from the
`duckdb/duckdb-wasm` v1.32.0 source tag, © Stichting DuckDB Foundation).
Committing these binaries does not change this repository's license
obligations.
