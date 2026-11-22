---
'@assay/engine-duckdb': patch
---

fix(b2): two type-expression boundary defects in the strict validator.

- **Inexpressible type modifiers now fail at validation.** DuckDB 1.5.5 reads a
  type modifier as a signed 32-bit literal, so `SELECT 1::VARCHAR(999999999999)`
  is a `Parser Error` — but the optional-integer-modifier path accepted the
  spelling, composed it into a SQL type position and let the failure arrive late
  from the engine. The modifier is now bounded to `0..2147483647` (both ends
  CLI-pinned: `VARCHAR(0)` and `VARCHAR(2147483647)` are accepted), so an
  inexpressible modifier is refused before any SQL. Negative modifiers were
  already unreachable through the grammar (the lexer rejects `-`), and the
  closed-arity rules (`VARCHAR()`, `VARCHAR(1,2)`) are unchanged. Tighter
  type-specific bounds the validator still does not model (e.g. `TIMESTAMP(n)`
  precision `0..9`) are recorded as a carried limitation in the module doc.
- **`VARBIT` / `BIT VARYING` are refused as unsupported materializations.**
  The pinned engine has no `VARBIT` at all (`SELECT 1::VARBIT` and
  `SELECT 1::BIT VARYING(10)` are `Catalog Error: Type with name … does not
exist`), yet the validator accepted both spellings as valid type expressions.
  They now throw the module's typed refusal ("outside the supported
  materialization", naming `BIT`/`BIT(n)` as the supported spelling), while
  `BIT`/`BIT(n)` and `CHARACTER VARYING[(n)]` stay accepted.

Both fixes ship a pinned-CLI agreement test (real engine, skipped only when the
binary is absent) alongside the validator unit pins.
