import { loadNativeClaudeProxyConnection } from '../server/claude-native-runtime.ts'

const connection = await loadNativeClaudeProxyConnection(false)
const response = await fetch(`${connection.baseUrl}/v1/messages`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${connection.token}`,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'user-agent': 'claude-cli/2.1.0',
  },
  body: JSON.stringify({
    model: process.argv[2] ?? 'claude-opus-4-8',
    max_tokens: 32,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [{ role: 'user', content: 'Reply NATIVE_OK' }],
  }),
})
process.stdout.write(`${JSON.stringify({ status: response.status, body: await response.text() })}\n`)
