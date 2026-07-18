import { CodexCanonicalAdapter } from '../server/session/codex-adapter.ts'

const adapter = new CodexCanonicalAdapter()
try {
  const handshake = await adapter.initialize()
  console.log(JSON.stringify({
    adapterVersion: handshake.adapterVersion,
    nativeChildExecution: handshake.capabilities.nativeChildExecution,
    exposedNativeAgentTools: handshake.exposedNativeAgentTools,
    enforcementEvidence: handshake.enforcementEvidence,
  }, null, 2))
} finally {
  await adapter.shutdown()
}
