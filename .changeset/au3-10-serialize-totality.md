---
'@assay/contracts': patch
'@assay/validation': patch
---

fix(au3-10): total contract serializer + code-point-aware RE2 class ranges

**`serializeContract` totality (S8).** The module doc promised "degrades to
deterministic plain output rather than a raw throw", but the `asText` renderer
called `String(value)` on unknown `metadata.name`/`columns[].name` values. Three
hostile shapes made that a raw throw instead of output: `Object.create(null)`
(`TypeError: Cannot convert object to primitive value`), an object with a
throwing `toString` getter, and `{ toString: null }`. `asText` is now total —
primitives keep their short form, but objects are never stringified and render
as the fixed `an object (no safe string form)` text (mirroring
`describeOptionValue` in `@assay/validation`'s compiler). The defensive-read
pins now cover all three shapes for both the metadata name and a column name,
asserting deterministic output that never leaks a throwing getter's message.

**RE2 class ranges are code-point-aware (QoL).** Both mirrored checkers measured
class-range endpoints in UTF-16 code units, so a valid emoji range `[😀-😄]`
(U+1F600–U+1F604) compared 😀's low surrogate (U+DE00) against 😄's high
surrogate (U+D83D) and was refused as `invalid character class range … is
reversed` — fail-closed, but with a factually wrong reason. Range endpoints are
now decoded through a surrogate-pair-aware reader; the genuinely reversed
`[😄-😀]` is still refused, but the reason names the real code points
(`😄-😀 is reversed`). BMP range behavior is unchanged (byte-stable goldens), and
the gated real-DuckDB agreement suite cross-checks the astral range in both
directions (the CLI's own error is `invalid character class range: 😄-😀`).
