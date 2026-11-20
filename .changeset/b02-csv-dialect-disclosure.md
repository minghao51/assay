---
'@assay/web': patch
---

fix(b02): disclose the CSV dialect honestly — interpret the sniffer's sentinels in a display adapter

The CSV review rendered the `sniff_csv` payload's raw TEXT evidence, so a
reader saw the literal `(empty)` for an unset `Quote`/`Escape`/`Comment`, and
the `None` copy was unreachable on a real engine. Worse, the old helper said
`None` for fields the sniffer merely **did not infer** — a claim that the
setting was disabled when the reader's default still applies.

**The wire stays as it is.** The engine comment assuming empty dialect strings
was wrong (`hex(Quote)` = `28656D70747929`, i.e. the seven characters
`(empty)`, and `NewLineDelimiter` is escape text such as `\n` / `\r\n`). B02
keeps that representation: normalising it engine-side would make D3-1's
per-file header scan see the sentinel shape as `ambiguous-shape` and silently
disable the rename list. The engine change is comment-only (no behaviour, type
or guard change), so `@assay/engine-duckdb` has no release entry.

**One display adapter.** `apps/web/src/csv/dialect-display.ts` is a pure,
value-free, total projection with three states: `value` (escaped for display),
`disabled` (`None` — comments with no prefix, or an explicit empty-string
option), and `not-inferred` (`Not inferred` — an absent inference, never a
disabled setting; this now includes a null date/timestamp format). The adapter
takes the effective option set so "quoting was disabled" and "no quote
character was inferred" cannot be confused: the payload is identical. It is
display-only and is never parser input — a module-boundary test pins that it
does not import the header scan and the scan does not import it, and the
sniffer's sentinel has one shared source (`sniff-wire.ts`).

**D3-1 is unchanged.** The per-file rename list still decodes the escape text
in its own scan and still requires exact equality with `sniff.columns[].name`;
the equality gate, its bounds and its bail-outs keep passing on the real
engine, so no partial list is ever shown.

**Tests.** Real-engine cases cover quoting disabled (DuckDB CLI control: the
`quote = ''` payload is identical to the unset one, so the display must use the
effective set), comments disabled, LF/CRLF terminators and quoted newlines
(CLI control, plus the browser e2e on the DuckDB-WASM build for every case the
shipped form can reach); a display-only case proves unset/inferred fields do
not say `None`; and the new CRLF e2e leg uploads bytes so no fixture is added. A
mutation drill that stops decoding the escaped terminator makes the rename-list
tests fail — the boundary is pinned, not assumed. Preview/adoption option
bytes, sample bounds, quick-open and source immutability are unchanged, and no
dependency or wire/persisted format changed.
