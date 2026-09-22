# ADR 0042: Library Builds Use tsc Project References

## Status

Accepted (2026-09-23, resolves checkpoint C-ar-5)

## Context

The audit-remediation queue's ar-5 (publishability foundation) needs every publishable
`@assay/*` package to produce installable npm artifacts, and the CLI needs a runtime entry
that does not depend on the devDependency `tsx` (AR-C4, D10 npm-only distribution). Today all
packages are `private` with `exports` pointing at raw `src/*.ts`; the web app bundles source
via vite, tests import source, and nothing is compiled.

Checkpoint C-ar-5 (post-MVP §9) required picking one library build tool before any packaging
work: tsup, tsc project references, or per-package vite lib mode. Constraints that shaped the
pick: packages are small, ESM-only (`"type": "module"`), strict TypeScript with intricate
public types (branded IDs, wire-codec template-literal types); consumers are Node ≥ 22 and
modern browsers; the repo already runs `tsc --noEmit` per package under turbo; the web app and
two e2e harness builds already use vite; publishing must be reviewer-provable via
`pnpm pack` → clean-consumer install (ar-5 done-when); the npm org claim (M1) remains a human
item — this ADR publishes nothing.

## Decision

We build libraries with the TypeScript compiler using project references: each publishable
package gets a `composite: true` build emitting per-file ESM JavaScript, `.d.ts`, and
declaration maps to `dist/`, driven by `tsc --build` as a turbo task. Typecheck and library
build are the same operation — there is no separate bundler in the library path. Workspace
`exports` keep resolving to `src/` for internal consumers; each package's `publishConfig`
carries the `dist`-pointing `exports`/`files`/`types` applied at publish time, so internal
DX (tests, vite, dev) is unchanged and what ships is exactly what `tsc` emitted.

The CLI ships a properly-declared compiled runtime entry (tsc output with a shebang, real
dependency declarations — no `tsx` at runtime, no bundler). A bundler remains admissible only
where a package's _shipped_ surface genuinely requires worker/asset bundling (e.g. a future
published engine-duckdb browser surface); any such exception must be recorded as an addendum
to this ADR. This ADR does not decide which packages publish (ar-5 scope) and does not publish
anything.

## Consequences

### Positive

- Zero new build dependencies; `.d.ts` fidelity is the compiler's own emit; `declarationMap`
  gives published consumers jump-to-source debugging.
- Per-file ESM output tree-shakes optimally; predictable, reviewable configs (declarative
  compiler options — friendly to the agent review protocol).
- Typecheck ≡ build eliminates the "types vs runtime drift" bug class; turbo caches the
  reference graph; incremental rebuilds are native.
- The `pnpm pack` → clean-consumer check (ar-5 done-when) becomes the enforcement mechanism
  for "test what you ship".

### Negative / risks

- No bundling: the CLI carries its dependency graph as declared installs (more files at
  runtime than a single-file bundle; acceptable for Node ≥ 22).
- Project-reference ceremony (`composite`, `references`, `rootDir`/`outDir` discipline) and a
  source-vs-dist duality managed entirely through `publishConfig` — misconfigured
  `publishConfig` would ship broken exports, which the pack-and-install check must catch.
- Slower cold emit than esbuild (marginal at this repo's package sizes).

### Neutral

- The web app and e2e harness builds stay on vite (apps/harnesses, not libraries).
- Scaffold packages (`engine-parquet`, `transforms`, `security`, `ai`, `pipeline`, vscode app)
  are unaffected until they grow real published surfaces.

## Alternatives considered

- **tsup (esbuild):** fastest builds and the best single-tool CLI-bundling story; rejected as
  the backbone because bundled `.d.ts` generation is the weak link exactly where Assay is most
  type-heavy, and consumer debuggability of bundled output is worse.
- **Per-package vite lib mode:** one bundler family with the web app and native wasm/worker
  handling; rejected as the backbone because lib mode is vite's second-class citizen, adds the
  largest config surface, and the pure-node majority of packages gains nothing over `tsc`.
- **Hybrid (tsc backbone + bundler exceptions):** retained in substance — this ADR keeps
  `tsc` as the backbone and names the narrow conditions under which a bundler may appear.
