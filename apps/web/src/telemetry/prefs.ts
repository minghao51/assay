// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Web telemetry preference + install/disclosure persistence (design §6.2/§6.3).
 *
 * Everything lives in `localStorage` and nothing here ever throws: storage can
 * be unavailable (private mode, disabled storage) and telemetry must never
 * break the app (R9). A missing/failed read degrades to the default-on
 * preference, and a failed write is ignored.
 *
 * Keys (design §6.2 + the disclosure "once per install" rule):
 * - `assay.telemetry`            — `'on'` (or absent) / `'off'`;
 * - `assay.telemetry.disclosure` — `'1'` once the first-run disclosure shown;
 * - `assay.telemetry.install`    — the 128-bit install pseudonym.
 */

/** Preference key (design §6.2). */
export const TELEMETRY_PREF_KEY = 'assay.telemetry'
export const TELEMETRY_DISCLOSURE_KEY = 'assay.telemetry.disclosure'
export const TELEMETRY_INSTALL_KEY = 'assay.telemetry.install'

/** The in-product telemetry preference (default on). */
export type TelemetryPreference = 'on' | 'off'

/** The slice of the Storage API the telemetry glue uses (injectable). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Read the preference: absent or anything but `'off'` means on (default on). */
export function readPreference(storage: StorageLike | null): TelemetryPreference {
  try {
    return storage?.getItem(TELEMETRY_PREF_KEY) === 'off' ? 'off' : 'on'
  } catch {
    return 'on'
  }
}

/** Persist the preference; a failed write is ignored (R9). */
export function writePreference(
  storage: StorageLike | null,
  preference: TelemetryPreference,
): void {
  try {
    storage?.setItem(TELEMETRY_PREF_KEY, preference)
  } catch {
    // storage unavailable — the runtime keeps the in-memory preference for
    // this session (`createWebTelemetry`), so a failed write cannot keep
    // telemetry on after `setPreference('off')` (§6.5)
  }
}

/** Whether the first-run disclosure has already been shown. */
export function readDisclosureShown(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(TELEMETRY_DISCLOSURE_KEY) === '1'
  } catch {
    return false
  }
}

/** Record that the first-run disclosure was shown. */
export function writeDisclosureShown(storage: StorageLike | null): void {
  try {
    storage?.setItem(TELEMETRY_DISCLOSURE_KEY, '1')
  } catch {
    // storage unavailable — the install token path will still gate later sends
  }
}

/** The persisted install pseudonym, or `null` when absent/unreadable. */
export function readInstallToken(storage: StorageLike | null): string | null {
  try {
    return storage?.getItem(TELEMETRY_INSTALL_KEY) ?? null
  } catch {
    return null
  }
}

/** Persist the install pseudonym; a failed write is ignored. */
export function writeInstallToken(storage: StorageLike | null, token: string): void {
  try {
    storage?.setItem(TELEMETRY_INSTALL_KEY, token)
  } catch {
    // storage unavailable — use the ephemeral token for this session
  }
}
