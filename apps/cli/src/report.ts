// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Compatibility barrel for the CLI's report modules (AU-2 f-5 split).
 *
 * The three independent renderers now live in `report-validate.ts`,
 * `report-profile.ts`, and `report-diff.ts`; the contract-visible helpers
 * they share live in `report-shared.ts`. This module preserves the
 * historical `./report.js` import surface so the command modules and the
 * report tests need no churn. New code should import from the specific
 * module it needs.
 */
export { datasetDisplayName, displayRowKey, exportRowKey } from './report-shared.js'
export * from './report-validate.js'
export * from './report-profile.js'
export * from './report-diff.js'
