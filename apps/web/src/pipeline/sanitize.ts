// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Render discipline for pipeline-derived text in the web panel (p-5 ruling 7;
 * shared home p2-1 item (a)).
 *
 * Every pipeline-derived string — node ids, relation names, pipeline names,
 * and `describePipelineError` one-liners (whose parse-error messages embed
 * raw YAML excerpts) — is untrusted *authored content* (ADR 0007 spirit /
 * ADR 0025 discipline). React text nodes escape HTML by default, so script
 * injection is already off the table; what React does NOT make visible is
 * control characters: a raw U+001B or C1 byte in a node id would render
 * invisibly (or act on capable terminals). `sanitizePipelineText` rewrites
 * every C0/C1 control character as a visible `\uXXXX` escape so the rendered
 * text is honest about what the document contains.
 *
 * The implementation is the shared pure home `@assay/pipeline`
 * (`packages/pipeline/src/sanitize.ts`) — the CLI renders through the same
 * function, so the two surfaces cannot drift. Re-exported here so the web
 * panel's call sites keep their local import path.
 */
export { sanitizePipelineText } from '@assay/pipeline'
