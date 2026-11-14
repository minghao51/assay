# ADR 0048: The engine selects its DuckDB-WASM bundle by capability, and engine error text is honest

## Status

Proposed

## Date

2026-11-14

## Deciders

- Maintainer (delegated instruction "lets proceed with your recommendation", recorded in the
  [R1 masked-engine-errors record](../process/handoff/20261114-r1-masked-engine-errors.md))

## Context

The shipped browser engine pins the legacy `mvp` DuckDB-WASM bundle
(`packages/engine-duckdb/src/worker.ts` imports `duckdb-browser-mvp.worker.js` +
`duckdb-mvp.wasm`). In `@duckdb/duckdb-wasm@1.32.0` that bundle's published Emscripten glue is an
incomplete JS-exception-handling build: the wasm exports `setThrew`, `__cxa_can_catch`,
`__cxa_increment_exception_refcount`, `__cxa_decrement_exception_refcount` and
`__cxa_get_exception_ptr`, but the glue calls the free identifiers for them without binding any. Every
DuckDB failure therefore throws `ReferenceError: _setThrew is not defined` inside the `invoke_*`
trampolines before DuckDB's message is built. The result is that **all** engine failures — catalog,
conversion, IO, option and arm-count alike — are indistinguishable on both `query()` and `send()`.

The same package already ships a capability selector: `getPlatformFeatures()` probes wasm exception
handling with `WebAssembly.validate`, and `selectBundle()` returns the `eh` assets whenever that probe
passes, preferring `mvp` only as the legacy fallback. The `eh` bundle was measured (2026-11-14 probes,
same DuckDB `v1.4.3`, same extension ABI) to surface the real messages, and the VS Code webview's
Electron version is fixed at Chromium 148, which supports wasm exception handling.

The masked text blocks honest failure classification (EW-03D §6.1/D10) and makes the recorded
arm-class evidence bundle-dependent (EW-04D U4). The alternative — pre-validating every failure in
TypeScript — cannot classify runtime failures such as a corrupt file or a conversion error.

## Decision

1. The engine worker selects its DuckDB-WASM bundle **by capability**: it uses the `eh` pair when
   `WebAssembly.validate` accepts the wasm exception-handling probe (the same check the package's
   `getPlatformFeatures()` uses), and falls back to the `mvp` pair otherwise. The web build ships
   both asset pairs; the VS Code webview, whose Electron runtime is fixed and known-capable, ships
   the `eh` pair only.
2. **Engine error text is honest**: the engine's own first message line reaches user-initiated
   surfaces (SQL run, open, edit), while the overlay/validation/diff paths keep their fixed,
   value-free class messages (q-8). The opaque-glue fallback stays as the non-EH-browser safety net
   and is never treated as file evidence.
3. Extension binaries are paired with the selected platform tag (`wasm_eh` with `eh`, `wasm_mvp`
   with `mvp`); the committed e2e fixture and the VS Code vendored set record which pair they serve.

No engine protocol change is part of this decision: the worker already posts `{name, message, stack}`
on failure and the client already rejects with that message. No new dependency is introduced.

## Consequences

### Positive

- Every engine failure class is distinguishable again on EH-capable browsers, which unblocks
  EW-03D D10 and lets EW-04D U4 re-derive its arm-class evidence against the shipped bundle.
- The corrupt-file open failure becomes truthfully classified ("could not be read") instead of
  falling through to a cause-neutral sentence.
- The desktop package gets smaller: the `eh` wasm is 34,242,586 B versus the `mvp` 39,362,651 B.

### Negative / risks

- The web build carries both wasm pairs (~+34 MB of emitted assets) so non-EH browsers keep working;
  only one pair is fetched/instantiated per session.
- The visible first line can echo a literal the user typed (e.g. a conversion error's value). That is
  user-initiated text on a user-initiated surface, but it is a deliberate policy difference from the
  fully masked build.
- Capability detection is not a boot-failure fallback: a browser that validates the probe but fails
  to instantiate `eh` fails the open. That matches the package's own selector; a retry-with-mvp
  fallback is explicitly out of scope.
- The committed e2e fixture now needs both extension platforms, and the VS Code vendored set changes
  its platform tag, hashes and documentation together.

### Neutral

- Engine version, SQL behaviour and the protocol stay identical; only the JS/wasm exception mechanism
  and therefore the error text change.
- The `mvp` glue defect remains in the dependency; the fix is asset selection, not a vendored patch.

## Alternatives considered

- **Shim the missing glue bindings.** A worker-scope shim converges only after binding five
  Emscripten JS-EH library functions; it re-implements vendored third-party internals, pins a
  minified build's free-identifier set, and breaks on any dependency rebuild. Rejected for the
  default path.
- **Upgrade duckdb-wasm.** 1.32.0 is the latest stable; the 1.33.1 line is a dev tag that
  restructures bundles and changes the engine version, pins and extension platform. A separate
  dependency decision, not this fix.
- **Pre-validation + generic copy only.** Keeps the mask and cannot classify runtime failures;
  retained only as the non-EH fallback behaviour.
- **`eh` only on the web too.** Smallest diff, but raises the browser floor without a maintainer
  support-policy decision; rejected in favour of capability selection.
