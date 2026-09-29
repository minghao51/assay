import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Telemetry is injected at build time (design §8.1/OQ6). The stock source
 * build leaves every input unset, so the endpoint is empty and the app is
 * inert (R6). `ASSAY_NO_TELEMETRY` set to any non-empty value is a build-time
 * hard off with no runtime override; `ASSAY_TELEMETRY_ENDPOINT` / `_TOKEN`
 * configure the self-hosted collector. These are inlined with `define` so the
 * browser bundle carries no `process.env` reference.
 */
function readAppVersion(): string {
  try {
    const raw = readFileSync(new URL('./package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const noTelemetry = process.env['ASSAY_NO_TELEMETRY']

export default defineConfig({
  plugins: [react()],
  define: {
    __ASSAY_TELEMETRY_ENDPOINT__: JSON.stringify(process.env['ASSAY_TELEMETRY_ENDPOINT'] ?? ''),
    __ASSAY_TELEMETRY_TOKEN__: JSON.stringify(process.env['ASSAY_TELEMETRY_TOKEN'] ?? ''),
    __ASSAY_TELEMETRY_HARD_OFF__: JSON.stringify(noTelemetry !== undefined && noTelemetry !== ''),
    __ASSAY_APP_VERSION__: JSON.stringify(readAppVersion()),
  },
})
