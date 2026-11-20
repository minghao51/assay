// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * B02 — the exact WIRE representation of `sniff_csv`'s dialect evidence.
 *
 * This one constant is the shared fact between the two web consumers that must
 * agree about the payload but must not share code:
 *
 * - `dialect-display.ts` interprets it for the DISPLAY text only (a sentinel
 *   must never reach a screen as `(empty)`);
 * - `header-renames.ts` decodes it before the single-record header scan (the
 *   seven characters are not a quote character).
 *
 * It lives here rather than in either module so neither has to import the
 * other: the display adapter is never parser input, and the scan never depends
 * on display copy. The value is measured, not assumed — against the installed
 * DuckDB v1.5.5 (`/tmp/duckdb`) `hex(Quote)` / `hex(Escape)` / `hex(Comment)`
 * is `28656D70747929` for an unset field, i.e. the literal ASCII text, while a
 * real character arrives as itself (`22` for `"`, `2C` for `,`). The engine
 * transports that payload verbatim (see `readSniffPayload` in
 * `packages/engine-duckdb/src/engine-executor.ts`), and B02 deliberately keeps
 * it that way.
 */
export const SNIFF_UNSET_TEXT = '(empty)'
