# Vendored engine assets (ptv1-2; `eh`-only since R1-B)

The webview boots DuckDB-WASM and opens datasets with **ZERO network fetches**.
The DuckDB runtime and both extension binaries in this directory are committed
verbatim and pinned; the build (`scripts/build.mjs`) verifies their SHA-256
checksums and byte-equality with the lockfile-pinned npm package for runtime
files before copying them to `dist/webview/`
(under their canonical names — the mapping lives in `scripts/build.mjs`).

**Since R1-B (ADR 0048 decision 3) the desktop package ships the `eh`
(wasm exception-handling) pair ONLY.** Electron's Chromium is fixed at 148 and
validates the wasm-EH probe, so there is no non-EH runtime here to fall back to;
the vendored extensions therefore carry the matching **`wasm_eh`** platform tag
(an `eh` engine autoloads `/v1.4.3/wasm_eh/…`, a `mvp` engine
`/v1.4.3/wasm_mvp/…`). The engine version is unchanged (`v1.4.3`, same
extension ABI); what changes is the JS/wasm exception mechanism — and therefore
that DuckDB's real failure text survives instead of being masked by the `mvp`
glue's missing `_setThrew` bindings. The package also got smaller: the `eh`
wasm is 34,242,586 B versus the `mvp` 39,362,651 B.

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
| Extension platform      | **`wasm_eh`** (paired with the `eh` bundle — the only bundle the desktop ships since R1-B)             |

| File                            | Bytes      | SHA-256                                                            | Source                                                                                                        |
| ------------------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `duckdb-eh.wasm`                | 34,242,586 | `4c221bfa59c11f24dbd750e70c90b9252eca6eec5633936e6a2ec766e55fd879` | `@duckdb/duckdb-wasm@1.32.0` (byte-identical to the lockfile package)                                         |
| `duckdb-browser-eh.worker.js`   | 772,759    | `f8ab72b6b90b3ad83077d47426d4a99d5d9a4c7e07cba1a2be37d655adc7c1ab` | `@duckdb/duckdb-wasm@1.32.0` (byte-identical to the lockfile package)                                         |
| `parquet.duckdb_extension.wasm` | 3,045,039  | `22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55` | fetched ONCE at vendor time from `https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm` |
| `json.duckdb_extension.wasm`    | 820,646    | `b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9` | fetched ONCE at vendor time from `https://extensions.duckdb.org/v1.4.3/wasm_eh/json.duckdb_extension.wasm`    |

The extension binaries are committed as
`parquet.duckdb_extension.wasm.eh.pinned` / `json.duckdb_extension.wasm.eh.pinned`
(the `.eh` suffix keeps them distinct from the `wasm_mvp` binaries of the same
name; R1-A committed them for the shared fixture route) and copied to their
canonical names at build time.

The machine-readable pin (checksums + versions + source URLs) is the
`VENDORED_ASSETS` constant in `scripts/build.mjs`; both Parquet and JSON
extensions are locally served at their exact DuckDB 1.4.3 **`wasm_eh`**
autoload paths; the build FAILS on any drift between this directory, those
checksums, and the lockfile package.
The runtime pin is asserted by the harness: the report's `bundles.eh.version`
must be `v1.4.3`, matching the vendored extension's version.

### Retained `mvp` files (not part of this package's pin)

`duckdb-mvp.wasm.pinned`, `duckdb-browser-mvp.worker.js.pinned`,
`parquet.duckdb_extension.wasm.pinned` and `json.duckdb_extension.wasm.pinned`
stay committed but are **no longer served or verified by this package**: the
desktop build copies the `eh` pair only. They are retained deliberately — the
web build still ships both bundle pairs and the browser e2e's `wasm_mvp` route
answers `/v1.4.3/wasm_mvp/…` from the `.pinned` extension binaries with their
exact committed names and byte counts (see `tests/e2e/support/fixture.ts`).
Deleting or renaming them would break that platform mapping; a future cleanup
row must move both together.

## Why the Parquet extension is vendored

`read_parquet` is not statically linked in the DuckDB-WASM bundle: in stock
DuckDB-WASM 1.32.0 it **autoloads the extension over the network** from the
platform-matching CDN path — for this package
`https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`
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

1. **CSP** — the webview's `connect-src` does not contain
   `https://extensions.duckdb.org` (removed in ptv1-2; the browser refuses
   any such request before it reaches the network).
2. **In-worker interceptor** — the vendored-asset shim appended (unmodified
   glue text + appended shim; the pinned bytes are not altered) to the
   DuckDB glue worker serves the autoload URL from the vendored bytes and
   answers any OTHER `fetch`/`XMLHttpRequest` to `extensions.duckdb.org`
   with a local **403** response whose body carries the stable
   `assay-netblock-refusal: …` marker.

   The response (rather than a thrown JS error) is load-bearing since R1-B:
   the shipped `eh`/JS-EH build turns an exception raised across the
   wasm→JS boundary into `RuntimeError: function signature mismatch`, which
   replaced the refusal text in the open error and silently destroyed the
   `missing-extension` drill's evidence channel. With the 403 the engine
   reports its own autoload failure, which names the refused URL.

The vendored run PASSES under the block (positive proof: the shim reports the
vendored bytes in hand, the fixture opens, and the extension reports
`loaded: true` with no network). The drill run —
`ASSAY_SPIKE_DRILL=missing-extension corepack pnpm --filter @assay/vscode run:spike`
— ships no vendored bytes so the stock autoload path is exercised: the open
FAILS with DuckDB's own autoload error, recorded value-free as

```text
Extension Autoloading Error: An error occurred while trying to automatically install the required extension 'parquet':
Extension https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm is not available
```

That is the Q5b failure mode reproduced under the block (structural proof
that a non-vendored asset WOULD fetch and be caught), and the drill's
`drill.refusal.evidence` check accepts exactly this refused `wasm_eh` URL
(literal, not derived from the report) or the `assay-netblock-refusal` body
marker. Pointing the autoload path at the wrong platform tag is the same
failure in the other direction: the engine would request (and the shim would
serve) `wasm_eh`, so a `wasm_mvp` autoload path matches nothing and the
request is refused — the R1-B mutation control.

## Re-vendoring deliberately (e.g. on a version bump)

1. Bump `@duckdb/duckdb-wasm` in `apps/vscode/package.json` AND update
   `duckdbWasmVersion`/`duckdbVersion`/`extensionPlatform`/`autoloadPath`
   here, in `scripts/build.mjs`, and in `apps/vscode/src/assets.ts` — one
   deliberate change, never a silent copy.
2. Copy the new `duckdb-eh.wasm` + `duckdb-browser-eh.worker.js` from the
   package into this directory with the `.pinned` suffix.
3. Fetch the matching `wasm_eh` extension binaries ONCE from
   `https://extensions.duckdb.org/<new-version>/wasm_eh/parquet.duckdb_extension.wasm`
   (and `…/json.duckdb_extension.wasm`), committing them as
   `<name>.eh.pinned`.
4. Recompute the SHA-256 values and update them in `scripts/build.mjs` and
   the table above. The build fails until everything agrees.

A version bump also moves the browser e2e fixture route
(`tests/e2e/support/fixture.ts`), whose platform mapping is shared with this
directory's `.pinned` / `.eh.pinned` names.

## License note

DuckDB-WASM (and its prebuilt `duckdb-eh.wasm` /
`duckdb-browser-eh.worker.js` / extension binaries as distributed on
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
