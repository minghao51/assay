// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Generate the golden CSV fixtures deterministically (EW-03I engine slice;
 * the ADR 0038 policy shape: committed small synthetic fixtures + manifest.json
 * with SHA-256 checksums, regeneration is deliberate).
 *
 * These are plain-text CSVs, so no DuckDB CLI is needed — the generator is a
 * pure Node script with fixed byte content (LF newlines, no BOM, no trailing
 * blank lines beyond the final newline). Regeneration changes checksums only
 * if the content below changes; the manifest is rewritten byte-identically on
 * an unchanged run, which the engine package's test suite pins bidirectionally
 * (every manifest entry matches disk; every golden file is listed).
 *
 * Run: `node fixtures/csv/generate.mjs`
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The golden set. Every fixture is synthetic and minimal; each exists to pin
 * one CSV-interpretation behaviour the EW-03D contract measured:
 *
 * - `leading-zeros.csv`  — lexeme preservation (`0017` survives all_varchar /
 *   sniffed-VARCHAR reads; cast-back cannot restore it — probes C1/C2).
 * - `quoted-empty.csv`   — quoted `""` vs unquoted empty (D6: both NULL by
 *   default; no setting separates them).
 * - `late-bad-row.csv`   — a bad token BEYOND a small sniffer sample
 *   (sample_size = 5): the sniff says BIGINT, the full read fails at the last
 *   line (M2/E-series: a failure beyond the sniff sample is expected and
 *   normal — a green sniff/sample is never a validation verdict).
 * - `semicolon.csv`      — the `delim`/`sep` override (B4).
 * - `unsafe-int.csv`     — integers beyond 2^53 that DOUBLE sniffing corrupts
 *   (H1/H4: `9007199254740993` → `…992`; disclosure is the remedy, D14).
 * - `dup-header.csv`     — duplicate + empty header names and DuckDB's
 *   auto-renames (G1–G3: `id`, `column1`, `id_1` — disclosure before adoption).
 * - `quoted-newline.csv` — a header record whose fields carry a QUOTED
 *   DELIMITER and a QUOTED NEWLINE, plus a duplicate and an empty name (D3's
 *   per-file rename list: the shape a naive `split(delim)` on the head gets
 *   wrong, so the single-record header scan is proved on it).
 */
const FIXTURES = {
  'leading-zeros.csv': ['id,amount,label', '0017,10.5,alpha', '00042,2.25,beta', '007,9.0,gamma', '0017,10.5,alpha'],
  'quoted-empty.csv': ['id,note,value', '1,"",3', '2,,4', '3,"text",5'],
  'late-bad-row.csv': [
    'n',
    ...Array.from({ length: 30 }, (_, i) => String(i + 1)),
    'abc',
  ],
  'semicolon.csv': ['id;name;score', '1;anna;10', '2;braedon;22'],
  'unsafe-int.csv': ['big,exact,max64', '9007199254740993,9007199254740992,9223372036854775807'],
  'dup-header.csv': ['id,,id', '1,x,2', '3,y,4'],
  'quoted-newline.csv': [
    '"a,b",id,"line\none",id,',
    '1,alpha,3,4,5',
    '2,beta,6,7,8',
  ],
}

const DESCRIPTIONS = {
  'leading-zeros.csv': 'Leading-zero id lexemes (0017) — all_varchar/sniffed-VARCHAR preservation pin',
  'quoted-empty.csv': 'Quoted empty vs unquoted empty fields — D6 NULL policy pin',
  'late-bad-row.csv': '30 numeric rows then a bad token — sniffer-sample miss vs full-read failure (D13/D7)',
  'semicolon.csv': 'Semicolon dialect — delim/sep override pin',
  'unsafe-int.csv': 'Integers beyond 2^53 — DOUBLE sniff corruption disclosure pin (D14)',
  'dup-header.csv': 'Duplicate and empty header names — auto-rename disclosure pin (D3)',
  'quoted-newline.csv':
    'Quoted delimiter and quoted newline in the header record — single-record header scan pin (D3)',
}

for (const [name, lines] of Object.entries(FIXTURES)) {
  writeFileSync(join(here, name), lines.join('\n') + '\n', 'utf8')
}

const files = Object.keys(FIXTURES)
  .sort()
  .map((name) => ({
    name,
    sha256: createHash('sha256').update(readFileSync(join(here, name))).digest('hex'),
    description: DESCRIPTIONS[name],
  }))

const manifest = {
  generator: 'fixtures/csv/generate.mjs (EW-03I; ADR 0038 policy shape)',
  policy: 'Small canonical synthetic fixtures are committed with checksums. Regeneration is deliberate: an unchanged run rewrites the manifest byte-identically; any content change updates checksums in the same commit. Verified bidirectionally by packages/engine-duckdb csv-options tests.',
  files,
}
writeFileSync(join(here, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(`manifest.json written for ${files.length} csv fixtures\n`)
