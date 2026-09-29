// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Identifier rendering for pipeline ports (p-1).
 *
 * A node's id is its output port and the relation name downstream surfaces
 * (p-2's compiler, p-3's runner) will address. Node ids are arbitrary user
 * text — quotes, spaces, unicode, SQL comment/quote syntax included — so any
 * rendering into SQL must go through the shared `@assay/validation` helper.
 * This module is the single sanctioned seam; never hand-roll quoting (the
 * m4-2 injection lesson).
 *
 * Purity: one pure re-export wrapper — no React, no browser APIs, no engine.
 */
import { quoteIdentifier } from '@assay/validation'

/**
 * Render a pipeline relation reference (a node id / port name) as a quoted
 * SQL identifier. Total over all strings: quoting itself is injection-safe.
 */
export function quotePortIdentifier(name: string): string {
  return quoteIdentifier(name)
}
