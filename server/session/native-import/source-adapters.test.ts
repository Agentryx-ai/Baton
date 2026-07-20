import assert from 'node:assert/strict'
import { mkdtemp, mkdir, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { ClaudeLocalSourceReader } from './claude-source.ts'
import { CodexLocalSourceReader } from './codex-source.ts'
import {
  mapWithConcurrency, MAX_NATIVE_CANDIDATES, MAX_NATIVE_FILE_BYTES, MAX_NATIVE_PHYSICAL_LINES,
  normalizeNativeCwd, sha256, stableJson,
} from './source-utils.ts'

const NAMESPACE_SECRET = Buffer.alloc(32, 7)

test('Codex adapter preserves portable messages, tool/file summaries and loss counts without source mutation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'baton-codex-source-'))
  const sessions = path.join(home, 'sessions')
  await mkdir(sessions)
  const rollout = path.join(sessions, 'rollout.jsonl')
  await writeFile(rollout, [
    JSON.stringify({ timestamp: '2026-07-18T00:00:00Z', type: 'session_meta', payload: { session_id: 'codex-1', id: 'internal-rollout-id' } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:00Z', type: 'world_state', payload: { version: 1 } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Old question' }] } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:00Z', type: 'compacted', payload: { replacement_history: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Compacted context' }] },
      { type: 'compaction', encrypted_content: 'opaque-native-checkpoint' },
    ] } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:00Z', type: 'inter_agent_communication_metadata', payload: { version: 1 } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:02Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'Write', input: JSON.stringify({ file_path: 'C:\\work\\alpha\\a.ts', content: 'secret body', access_token: 'top-secret-token', password: 'hunter2' }) } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'x'.repeat(20_000) } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:04Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked constraints access_token=reasoning-secret' }], encrypted_content: 'never-import' } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:04Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'high', cwd: 'C:\\work\\alpha', secret: 'never-copy' } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } }),
  ].join('\n'))
  const corrupt = path.join(sessions, 'corrupt.jsonl')
  await writeFile(corrupt, '{not-json')
  const db = createCodexDatabase(home)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('codex-1', rollout, 1, 2, 'C:\\work\\alpha', 'Explicit title', 'Question')
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('codex-bad', corrupt, 1, 2, 'C:\\work\\bad', null, 'Do not alias')
  db.close()

  const before = await fileHead(rollout)
  const reader = new CodexLocalSourceReader({ codexHome: home, namespaceSecret: NAMESPACE_SECRET, concurrency: 2 })
  const candidates = await reader.scan()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.sourceAlias, 'Explicit title')
  assert.equal(candidates[0]?.titleSource, 'threads.title')
  assert.deepEqual(candidates[0]?.records.map((record) => record.item.kind), [
    'user_message', 'provider_event', 'user_message', 'tool_call', 'file_change', 'tool_result',
    'reasoning_summary', 'assistant_message',
  ])
  const checkpoint = candidates[0]?.records.find((record) => record.item.kind === 'provider_event')
  assert.ok(checkpoint)
  assert.equal(checkpoint?.item.visibility, 'provider_private')
  assert.equal(
    ((checkpoint.item.payload.nativeContextCheckpoint as Record<string, unknown>).history as unknown[]).length,
    2,
  )
  assert.equal(candidates[0]?.records.find((record) => record.item.kind === 'file_change')?.item.payload.summary, 'Write: a.ts')
  const serializedRecords = JSON.stringify(candidates[0]?.records)
  assert.equal(serializedRecords.includes('never-import'), false)
  assert.equal(serializedRecords.includes('secret body'), false)
  assert.equal(serializedRecords.includes('top-secret-token'), false)
  assert.equal(serializedRecords.includes('hunter2'), false)
  assert.equal(serializedRecords.includes('reasoning-secret'), false)
  const reasoning = candidates[0]?.records.find((record) => record.item.kind === 'reasoning_summary')
  assert.equal(reasoning?.item.visibility, 'provider_private')
  assert.match(String(reasoning?.item.payload.summary), /\[redacted\]/)
  const toolResult = candidates[0]?.records.find((record) => record.item.kind === 'tool_result')
  assert.ok(JSON.stringify(toolResult?.item.payload).length < 1_000)
  const assistant = candidates[0]?.records.find((record) => record.item.kind === 'assistant_message')
  assert.equal(assistant?.item.payload.requestedModel, 'gpt-5.6-sol')
  assert.equal(assistant?.item.payload.effort, 'high')
  assert.equal(assistant?.digest, sha256(stableJson({
    key: assistant?.key,
    kind: 'assistant_message',
    payload: {
      text: 'Answer', nativeSourceClient: 'codex_local', nativeRecordType: 'message',
      nativeTimestamp: '2026-07-18T00:00:05Z',
    },
  })))
  assert.equal(JSON.stringify(assistant?.item.payload).includes('never-copy'), false)
  // 4 metadata + 3 denied tool-input fields + 1 omitted output + 1 summary DLP + 1 encrypted reasoning.
  assert.equal(candidates[0]?.skippedItemCount, 10)
  assert.equal(candidates[0]?.portableItemCount, 6)
  assert.match(String(candidates[0]?.parserVersion), /codex-native-compact-v4$/)
  assert.equal(reader.lastScanWarnings.some((warning) => warning.code === 'codex_json_corrupt'), true)
  assert.deepEqual(await fileHead(rollout), before)

  const [metadataOnly] = await reader.scan({ includeRecords: false })
  assert.equal(metadataOnly?.records.length, 0)
  assert.equal(metadataOnly?.portableItemCount, 0)
  assert.equal(metadataOnly?.materialized, false)
  assert.ok(metadataOnly?.sourceLocator)
  const materialized = await reader.materialize(metadataOnly!)
  assert.equal(materialized.records.length, 8)
  assert.equal(materialized.materialized, true)
})

test('Codex adapter never derives an alias from first_user_message', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'baton-codex-alias-'))
  const sessions = path.join(home, 'sessions')
  await mkdir(sessions)
  const rollout = path.join(sessions, 'rollout.jsonl')
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }))
  const db = createCodexDatabase(home)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('x', rollout, 1, 2, 'C:\\work\\safe-project', null, 'sensitive prompt')
  db.close()
  const [candidate] = await new CodexLocalSourceReader({ codexHome: home, namespaceSecret: NAMESPACE_SECRET }).scan()
  assert.equal(candidate?.sourceAlias, 'safe-project')
  assert.equal(candidate?.aliasSource, 'path_fallback')
})

test('Codex adapter reconstructs the last successful unresolved Goal with source model metadata', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'baton-codex-goal-'))
  const sessions = path.join(home, 'sessions')
  await mkdir(sessions)
  const rollout = path.join(sessions, 'goal.jsonl')
  await writeFile(rollout, [
    JSON.stringify({ timestamp: '2026-07-18T00:00:00Z', type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '/goal finish the native import audit' }],
    } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:01Z', type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'failed-create', name: 'exec',
      input: 'await tools.create_goal({objective: "must not replace"})',
    } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:02Z', type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'failed-create', output: 'Script failed\nScript error:\ncannot create a new goal',
    } }),
    JSON.stringify({ timestamp: '2026-07-18T00:00:03Z', type: 'turn_context', payload: {
      model: 'gpt-5.6-sol', effort: 'high',
    } }),
  ].join('\n'))
  const db = createCodexDatabase(home)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('goal', rollout, 1, 2, null, 'Goal task', null)
  db.close()

  const [candidate] = await new CodexLocalSourceReader({ codexHome: home, namespaceSecret: NAMESPACE_SECRET }).scan()
  assert.deepEqual(candidate?.goal, {
    objective: 'finish the native import audit', model: 'gpt-5.6-sol', effort: 'high',
    detectedAt: '2026-07-18T00:00:00Z', evidence: 'slash_command',
  })
})

test('Claude adapter captures native title provenance, tools, file summaries, hidden loss, and cross-client identity scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'baton-claude-source-'))
  const desktop = path.join(root, 'desktop', 'gateway-profile', 'workspace')
  const projects = path.join(root, 'projects', 'project')
  await mkdir(desktop, { recursive: true })
  await mkdir(projects, { recursive: true })
  await writeFile(path.join(projects, 'cli-1.jsonl'), [
    JSON.stringify({ type: 'agent-name', sessionId: 'cli-1', agentName: 'Agent fallback' }),
    JSON.stringify({ type: 'ai-title', sessionId: 'cli-1', aiTitle: 'AI title' }),
    JSON.stringify({ type: 'custom-title', sessionId: 'cli-1', customTitle: 'User custom title' }),
    JSON.stringify({ type: 'bridge-session', sessionId: 'cli-1', bridgeSessionId: 'opaque' }),
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'resumed-branch', cwd: 'C:\\work\\beta', timestamp: '2026-07-18T00:00:00Z', message: { content: 'Start' } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary', timestamp: '2026-07-18T00:00:00Z', compactMetadata: { preTokens: 100, postTokens: 10 } }),
    JSON.stringify({ type: 'user', uuid: 'compact-summary', timestamp: '2026-07-18T00:00:00Z', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'Native compact summary' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 'resumed-branch', timestamp: '2026-07-18T00:00:01Z', message: { content: [
      { type: 'thinking', thinking: 'never-import', signature: 'signed' },
      { type: 'text', text: 'Working' },
      { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: 'C:\\work\\beta\\b.ts', old_string: 'x', new_string: 'y', auth_token: 'claude-token', password: 'claude-password' } },
    ] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', sessionId: 'cli-1', timestamp: '2026-07-18T00:00:02Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'z'.repeat(20_000) }, { type: 'image', source: 'not-portable' }] },
    ] } }),
    JSON.stringify({ type: 'file-history-delta', messageId: 'f1', timestamp: '2026-07-18T00:00:03Z', trackingPath: 'C:\\work\\beta\\b.ts' }),
  ].join('\n'))
  await writeFile(path.join(projects, 'corrupt.jsonl'), '{not-json')
  await writeFile(path.join(desktop, 'local-1.json'), JSON.stringify({
    sessionId: 'desktop-1', cliSessionId: 'cli-1', cwd: 'C:\\work\\beta',
  }))

  const reader = new ClaudeLocalSourceReader({
    desktopRoot: path.join(root, 'desktop'), projectsRoot: path.join(root, 'projects'),
    namespaceSecret: NAMESPACE_SECRET, profileProvenance: 'opaque-profile',
  })
  const candidates = await reader.scan()
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate?.sourceClient, 'claude_desktop')
  assert.equal(candidate?.sourceAlias, 'User custom title')
  assert.equal(candidate?.titleSource, 'custom-title')
  assert.deepEqual(candidate?.records.map((record) => record.item.kind), [
    'user_message', 'provider_event', 'assistant_message', 'tool_call', 'file_change', 'tool_result', 'file_change',
  ])
  const claudeCheckpoint = candidate?.records.find((record) => record.item.kind === 'provider_event')
  assert.ok(claudeCheckpoint)
  assert.equal(claudeCheckpoint?.item.visibility, 'provider_private')
  assert.equal(
    (claudeCheckpoint.item.payload.nativeContextCheckpoint as Record<string, unknown>).format,
    'claude_compact_summary',
  )
  // bridge metadata + hidden thinking + 4 denied input fields + 2 omitted result blocks.
  assert.equal(candidate?.skippedItemCount, 8)
  const serializedClaude = JSON.stringify(candidate?.records)
  assert.equal(serializedClaude.includes('never-import'), false)
  assert.equal(serializedClaude.includes('claude-token'), false)
  assert.equal(serializedClaude.includes('claude-password'), false)
  assert.equal(serializedClaude.includes('zzzzzzzzzzzz'), false)
  assert.ok(JSON.stringify(candidate?.records.find((record) => record.item.kind === 'tool_result')?.item.payload).length < 1_000)
  const [nativeKey, cliKey] = candidate?.identityKeys ?? []
  assert.equal(nativeKey?.scopeNamespaceKey, candidate?.namespaceKey)
  assert.notEqual(cliKey?.scopeNamespaceKey, candidate?.namespaceKey)
  assert.equal(candidate?.namespaceKey.includes('gateway-profile'), false)
  assert.equal(reader.lastScanWarnings.some((warning) => warning.code === 'claude_json_corrupt'), true)

  const [metadataOnly] = await reader.scan({ includeRecords: false })
  assert.equal(metadataOnly?.records.length, 0)
  assert.equal(metadataOnly?.portableItemCount, 0)
  assert.equal(metadataOnly?.materialized, false)
  assert.ok(metadataOnly?.sourceLocator)
  const materialized = await reader.materialize(metadataOnly!)
  assert.equal(materialized.records.length, 7)
  assert.equal(materialized.materialized, true)

  const otherProfile = await new ClaudeLocalSourceReader({
    desktopRoot: path.join(root, 'desktop'), projectsRoot: path.join(root, 'projects'),
    namespaceSecret: NAMESPACE_SECRET, profileProvenance: 'another-opaque-profile',
  }).scan()
  assert.notEqual(otherProfile[0]?.namespaceKey, candidate?.namespaceKey)
})

test('Claude adapter reconstructs a confirmed Goal and ignores ordinary Stop-hook prose as lifecycle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'baton-claude-goal-'))
  const projects = path.join(root, 'projects', 'project')
  await mkdir(projects, { recursive: true })
  await writeFile(path.join(projects, 'goal-cli.jsonl'), [
    JSON.stringify({ type: 'user', uuid: 'command', timestamp: '2026-07-18T00:00:00Z', message: { content:
      '<command-name>/goal</command-name>\n<command-args>complete the EagleEye evidence path</command-args>' } }),
    JSON.stringify({ type: 'user', uuid: 'confirmation', timestamp: '2026-07-18T00:00:01Z', message: { content:
      '<local-command-stdout>Goal set: complete the EagleEye evidence path</local-command-stdout>' } }),
    JSON.stringify({ type: 'attachment', timestamp: '2026-07-18T00:00:01Z', attachment: {
      type: 'goal_status', met: false, condition: 'complete the EagleEye evidence path',
    } }),
    JSON.stringify({ type: 'user', uuid: 'hook', timestamp: '2026-07-18T00:00:02Z', message: { content:
      'A session-scoped Stop hook is now active. This is informational prose.' } }),
    JSON.stringify({ type: 'assistant', uuid: 'assistant', timestamp: '2026-07-18T00:00:03Z', message: {
      model: 'claude-fable-5', content: [{ type: 'text', text: 'Working' }],
    } }),
  ].join('\n'))

  const [candidate] = await new ClaudeLocalSourceReader({
    desktopRoot: path.join(root, 'missing-desktop'), projectsRoot: path.join(root, 'projects'),
    namespaceSecret: NAMESPACE_SECRET,
  }).scan()
  assert.deepEqual(candidate?.goal, {
    objective: 'complete the EagleEye evidence path', model: 'claude-fable-5', effort: null,
    detectedAt: '2026-07-18T00:00:01Z', evidence: 'claude_goal_status',
  })
})

test('Codex local inventory defaults to active user surfaces and opts into internal or archived tasks', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'baton-codex-filter-'))
  const sessions = path.join(home, 'sessions')
  await mkdir(sessions)
  const db = createCodexDatabase(home)
  db.exec("ALTER TABLE threads ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'; ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
  const insert = db.prepare(`
    INSERT INTO threads(id,rollout_path,created_at,updated_at,cwd,title,first_user_message,source,archived)
    VALUES (?,?,?,?,?,?,?,?,?)
  `)
  for (const [id, source, archived] of [
    ['cli-active', 'cli', 0], ['ide-active', 'vscode', 0], ['exec-active', 'exec', 0],
    ['subagent-active', '{"subagent":{"thread_spawn":{"parent_thread_id":"opaque"}}}', 0],
    ['cli-archived', 'cli', 1],
  ] as const) {
    const rollout = path.join(sessions, `${id}.jsonl`)
    await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id } }))
    insert.run(id, rollout, 1, 2, null, id, null, source, archived)
  }
  db.close()

  const reader = new CodexLocalSourceReader({ codexHome: home, namespaceSecret: NAMESPACE_SECRET })
  const defaults = await reader.scan({ includeRecords: false })
  assert.deepEqual(defaults.map((candidate) => candidate.nativeSessionId).sort(), ['cli-active', 'ide-active'])
  const expanded = await reader.scan({ includeRecords: false, codex: {
    origins: ['cli', 'ide_app', 'exec', 'other'], includeSubagents: true, includeArchived: true,
  } })
  assert.deepEqual(expanded.map((candidate) => candidate.nativeSessionId).sort(), [
    'cli-active', 'cli-archived', 'exec-active', 'ide-active', 'subagent-active',
  ])
})

test('Codex adapter strips Windows verbatim prefixes from recorded cwd values', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'baton-codex-verbatim-'))
  const sessions = path.join(home, 'sessions')
  await mkdir(sessions)
  const rollout = path.join(sessions, 'verbatim.jsonl')
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'verbatim' } }))
  const db = createCodexDatabase(home)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)')
    .run('verbatim', rollout, 1, 2, '\\\\?\\C:\\work\\alpha', null, null)
  db.close()

  const reader = new CodexLocalSourceReader({ codexHome: home, namespaceSecret: NAMESPACE_SECRET })
  const [candidate] = await reader.scan({ includeRecords: false })
  assert.equal(candidate?.cwd, 'C:\\work\\alpha')
  assert.equal(candidate?.projectAlias, 'alpha')

  assert.equal(normalizeNativeCwd('\\\\?\\UNC\\host\\share\\repo'), '\\\\host\\share\\repo')
  assert.equal(normalizeNativeCwd('C:\\plain'), 'C:\\plain')
  assert.equal(normalizeNativeCwd(null), null)
})

test('Codex adapter reports unavailable and unsupported stores instead of a silent empty inventory', async () => {
  const missing = await mkdtemp(path.join(tmpdir(), 'baton-codex-missing-'))
  const unavailableReader = new CodexLocalSourceReader({ codexHome: missing, namespaceSecret: NAMESPACE_SECRET })
  assert.deepEqual(await unavailableReader.scan(), [])
  assert.equal(unavailableReader.lastScanWarnings[0]?.status, 'unavailable')

  const unsupported = await mkdtemp(path.join(tmpdir(), 'baton-codex-unsupported-'))
  new DatabaseSync(path.join(unsupported, 'state_5.sqlite')).close()
  const unsupportedReader = new CodexLocalSourceReader({ codexHome: unsupported, namespaceSecret: NAMESPACE_SECRET })
  assert.deepEqual(await unsupportedReader.scan(), [])
  assert.equal(unsupportedReader.lastScanWarnings[0]?.status, 'unsupported')
  assert.equal(unsupportedReader.lastScanWarnings[0]?.code, 'codex_database_schema_unsupported')
})

test('Codex adapter excludes candidates that exceed file or physical-line caps with structured warnings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'baton-codex-caps-'))
  const sessions = path.join(home, 'sessions')
  await mkdir(sessions)
  const oversized = path.join(sessions, 'oversized.jsonl')
  await writeFile(oversized, '')
  await truncate(oversized, MAX_NATIVE_FILE_BYTES + 1)
  const tooManyLines = path.join(sessions, 'too-many-lines.jsonl')
  await writeFile(tooManyLines, '\n'.repeat(MAX_NATIVE_PHYSICAL_LINES))
  const db = createCodexDatabase(home)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('oversized', oversized, 1, 3, null, null, null)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('too-many-lines', tooManyLines, 1, 2, null, null, null)
  db.close()

  const reader = new CodexLocalSourceReader({ codexHome: home, namespaceSecret: NAMESPACE_SECRET, concurrency: 2 })
  const metadata = await reader.scan({ includeRecords: false })
  assert.equal(metadata.length, 1)
  assert.equal(metadata[0]?.nativeSessionId, 'too-many-lines')
  assert.equal(reader.lastScanWarnings.some((warning) => warning.status === 'unsupported'
    && warning.code === 'native_source_file_size_limit'), true)
  await assert.rejects(() => reader.materialize(metadata[0]!), /native_source_physical_line_limit/)
})

test('Codex adapter exposes a typed incomplete-inventory sentinel instead of silently slicing candidates', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'baton-codex-inventory-cap-'))
  const db = createCodexDatabase(home)
  const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)')
  db.exec('BEGIN')
  for (let index = 0; index <= MAX_NATIVE_CANDIDATES; index += 1) {
    insert.run(`session-${index}`, 'not-read.jsonl', 1, index, null, null, null)
  }
  db.exec('COMMIT')
  db.close()

  const reader = new CodexLocalSourceReader({ codexHome: home, namespaceSecret: NAMESPACE_SECRET })
  assert.deepEqual(await reader.scan({ includeRecords: false }), [])
  assert.equal(reader.inventoryOverflow, true)
  assert.equal(reader.overflowCount, 1)
  assert.equal(reader.lastScanWarnings.some((warning) => warning.code === 'codex_candidate_scan_limit'), true)
})

test('adapters fail closed on unknown framing and a symlink escape', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'baton-codex-link-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'baton-codex-outside-'))
  await mkdir(path.join(home, 'sessions'))
  const externalRollout = path.join(outside, 'rollout.jsonl')
  await writeFile(externalRollout, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'outside' } }))
  const linkedDirectory = path.join(home, 'sessions', 'linked')
  try { await symlink(outside, linkedDirectory, 'junction') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink creation is unavailable on this Windows host'); return }
    throw error
  }
  const linkedRollout = path.join(linkedDirectory, 'rollout.jsonl')
  const unknownRollout = path.join(home, 'sessions', 'unknown.jsonl')
  await writeFile(unknownRollout, JSON.stringify({ type: 'future_unknown_frame', payload: {} }))
  const db = createCodexDatabase(home)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('link', linkedRollout, 1, 2, null, null, null)
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('unknown', unknownRollout, 1, 2, null, null, null)
  db.close()
  const reader = new CodexLocalSourceReader({ codexHome: home, namespaceSecret: NAMESPACE_SECRET })
  assert.deepEqual(await reader.scan(), [])
  assert.equal(reader.lastScanWarnings.some((warning) => warning.code === 'native_source_path_escape'), true)
  assert.equal(reader.lastScanWarnings.some((warning) => warning.code === 'codex_top_level_type_unsupported'), true)
})

test('bounded mapper never exceeds configured concurrency', async () => {
  let active = 0
  let peak = 0
  const result = await mapWithConcurrency([...Array(100).keys()], 4, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
    return value * 2
  })
  assert.equal(peak, 4)
  assert.equal(result.length, 100)
  assert.equal(result[99], 198)
})

function createCodexDatabase(home: string): DatabaseSync {
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, first_user_message TEXT)')
  return db
}

async function fileHead(file: string): Promise<{ size: number, mtimeMs: number }> {
  const value = await stat(file)
  return { size: value.size, mtimeMs: value.mtimeMs }
}
