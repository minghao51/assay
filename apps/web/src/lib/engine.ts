// SPDX-License-Identifier: AGPL-3.0-or-later

import { DuckDbEngineClient } from '@assay/engine-duckdb'

/**
 * The app's one engine client (composition root). Construction is free —
 * the DuckDB-WASM worker boots lazily on first use (ADR 0021).
 */
export const engineClient = new DuckDbEngineClient()
