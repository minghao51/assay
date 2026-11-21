// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DOM lookup shared by the desktop webview entry and its presentation
 * controllers (D03b). Every element is addressed by its static HTML id; a
 * missing id is a wiring bug, not a runtime condition, so it throws.
 */
export function elementOrThrow(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el === null) {
    throw new Error(`dataset webview DOM is missing #${id}`)
  }
  return el
}
