---
'@assay/cli': minor
---

CLI surface completion (AR-C3/AR-C4). New command: `assay profile <path>`
reports per-column null/distinct counts, numeric stats and quantiles, and
categorical top-k over the existing `./node` profile op, in a human report and
a byte-stable `--format json` envelope (value-free stderr, exit 0/2 house
style). The CLI now ships a properly-declared **compiled** runtime entry per
ADR 0042: `tsc --build` emits `dist/index.js` (shebang preserved), `bin`
points at it, and `tsx` is a dev-only `dev` convenience — no `tsx` at runtime.
Also fixes AR-C2: the diff truncation notice now renders the real
`ROW_DIFF_SAMPLE_HARD_MAX` clamp instead of the validation constant (pinned by
a divergent-constant test). The private `@assay/engine-duckdb` closure gains a
`publishConfig` whose `exports` point `./node` (and `.`) at the emitted `dist/`
graph, so the installed CLI actually runs instead of dying on a src-pointing
subpath. The new `profile` command is the minor.
