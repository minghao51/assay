// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fixed-grammar token helpers (design §3.1, ADR 0007/0045).
 *
 * Tokens are the only string-shaped telemetry values, and both have exact
 * grammars (lowercase hex of a fixed length). They are generated from the
 * platform CSPRNG (`globalThis.crypto.getRandomValues`) — never from hardware,
 * account, dataset, filename, user input, or any hash of them (design
 * §3.1/§4/D9). No hand-rolled cryptographic primitive is used (ADR 0007): the
 * platform provides the CSPRNG. There is no input to `generate*`, so a token
 * cannot be derived from anything.
 *
 * `globalThis.crypto` is a standard global in Node ≥ 22 and all browsers; the
 * module does not import `node:crypto` (banned by the package's
 * `import/no-nodejs-modules`, and it would make the module environment-bound).
 */

import {
  INSTALL_TOKEN_HEX_LENGTH,
  SESSION_TOKEN_HEX_LENGTH,
  type InstallToken,
  type SessionToken,
} from './schema.js'

/** True iff `value` is a string of exactly `length` lowercase hex characters. */
export function isHexOfLength(value: unknown, length: number): boolean {
  if (typeof value !== 'string' || value.length !== length) return false
  for (let index = 0; index < length; index++) {
    const code = value.charCodeAt(index)
    const isDigit = code >= 0x30 && code <= 0x39
    const isLowerHexLetter = code >= 0x61 && code <= 0x66
    if (!isDigit && !isLowerHexLetter) return false
  }
  return true
}

/** True iff `value` has the exact `install_token` grammar (`[0-9a-f]{32}`). */
export function isInstallToken(value: unknown): value is InstallToken {
  return isHexOfLength(value, INSTALL_TOKEN_HEX_LENGTH)
}

/** True iff `value` has the exact `session_token` grammar (`[0-9a-f]{16}`). */
export function isSessionToken(value: unknown): value is SessionToken {
  return isHexOfLength(value, SESSION_TOKEN_HEX_LENGTH)
}

/** Fresh CSPRNG lowercase hex of `hexLength` characters (even `hexLength`). */
function randomHex(hexLength: number): string {
  const bytes = new Uint8Array(hexLength / 2)
  globalThis.crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** A fresh 128-bit CSPRNG install pseudonym (32 lowercase hex chars). */
export function generateInstallToken(): InstallToken {
  return randomHex(INSTALL_TOKEN_HEX_LENGTH) as InstallToken
}

/** A fresh 64-bit CSPRNG session token (16 lowercase hex chars). */
export function generateSessionToken(): SessionToken {
  return randomHex(SESSION_TOKEN_HEX_LENGTH) as SessionToken
}
