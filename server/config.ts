/** Baton local runtime configuration. */

import { homedir } from 'node:os'
import path from 'node:path'

// Node 20.12+ loads .env natively; ignore if absent (env may be set externally).
if (process.env.BATON_DISABLE_ENV_FILE !== '1') {
  try {
    process.loadEnvFile()
  } catch {
    /* .env not found — rely on process env */
  }
}

export const config = {
  port: Number(process.env.BATON_PORT ?? 4400),
  /** Durable canonical state must live outside the source tree. */
  dataDir: process.env.BATON_DATA_DIR
    ?? path.join(process.env.LOCALAPPDATA ?? homedir(), 'Baton'),
}
