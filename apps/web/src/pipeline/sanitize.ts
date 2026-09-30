// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Render discipline for pipeline-derived text in the web panel (p-5 ruling 7).
 *
 * Every pipeline-derived string — node ids, relation names, pipeline names,
 * and `describePipelineError` one-liners (whose parse-error messages embed
 * raw YAML excerpts) — is untrusted *authored content* (ADR 0007 spirit /
 * ADR 0025 discipline). React text nodes escape HTML by default, so script
 * injection is already off the table; what React does NOT make visible is
 * control characters: a raw U+001B or C1 byte in a node id would render
 * invisibly (or act on capable terminals). This helper rewrites every C0/C1
 * control character as a visible `\uXXXX` escape so the rendered text is
 * honest about what the document contains.
 *
 * Web-local by ruling: the CLI has its own `sanitizePipelineText`
 * (apps/cli/src/report-pipeline.ts) with byte-identical behavior; extracting
 * a shared home would touch `packages/**` and is explicitly out of scope
 * here (recorded as a carry-over). The escape set (0x00–0x1F, 0x7F–0x9F)
 * mirrors the CLI implementation exactly.
 */
export function sanitizePipelineText(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code !== undefined && ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f))) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += char
    }
  }
  return out
}
