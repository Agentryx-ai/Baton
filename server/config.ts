/** Baton BFF configuration, loaded from .env (see DESIGN.md §3.1 / §7). */

// Node 20.12+ loads .env natively; ignore if absent (env may be set externally).
try {
  process.loadEnvFile()
} catch {
  /* .env not found — rely on process env */
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[baton] Missing required env var: ${name} (set it in .env)`)
    process.exit(1)
  }
  return value
}

export const config = {
  /** Gateway backend base URL. Only this changes when migrating Docker → native. */
  gatewayUrl: (process.env.GATEWAY_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  gatewayUser: required('GATEWAY_USER'),
  gatewayPass: required('GATEWAY_PASS'),
  port: Number(process.env.BATON_PORT ?? 4400),
}
