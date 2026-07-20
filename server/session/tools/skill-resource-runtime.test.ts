import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import type { AgentToolInvocation } from '../domain.ts'
import type { ToolRuntime } from '../tool-coordinator.ts'
import { CompositeToolRuntime, discoverSkillResources, SkillResourceToolRuntime } from './skill-resource-runtime.ts'

function invocation(input: Record<string, unknown>, name = 'read_skill_resource'): AgentToolInvocation {
  return { callId: 'baton-skill', providerCallId: 'provider-skill', name, input }
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('discovers direct global skill roots with deterministic precedence', async (t) => {
  const first = await temporaryDirectory(t, 'baton-skills-first-')
  const second = await temporaryDirectory(t, 'baton-skills-second-')
  await mkdir(path.join(first, 'shared'))
  await mkdir(path.join(second, 'shared'))
  await mkdir(path.join(second, 'claude-only'))
  await mkdir(path.join(second, 'not-a-skill'))
  await writeFile(path.join(first, 'shared', 'SKILL.md'), 'first')
  await writeFile(path.join(second, 'shared', 'SKILL.md'), 'second')
  await writeFile(path.join(second, 'claude-only', 'SKILL.md'), 'claude')

  assert.deepEqual(discoverSkillResources([first, second]), [
    { id: 'shared', root: path.join(first, 'shared') },
    { id: 'claude-only', root: path.join(second, 'claude-only') },
  ])
})

test('reads only provider-approved skill-relative resources', async (t) => {
  const root = await temporaryDirectory(t, 'baton-skill-')
  await mkdir(path.join(root, 'references'))
  await writeFile(path.join(root, 'SKILL.md'), '# Approved')
  await writeFile(path.join(root, 'references', 'guide.md'), 'guide')
  const runtime = new SkillResourceToolRuntime([{ id: 'openai-docs', root }])

  assert.deepEqual(runtime.definitions.map(({ name }) => name), ['read_skill_resource'])
  const result = await runtime.execute(invocation({ skill: 'openai-docs', path: 'SKILL.md' }))
  assert.equal(result.success, true)
  assert.equal(result.content?.text, '# Approved')
  assert.equal(result.content?.path, 'SKILL.md')

  const nested = await runtime.execute(invocation({ skill: 'openai-docs', path: 'references/guide.md' }))
  assert.equal(nested.success, true)
  assert.equal(nested.content?.text, 'guide')
})

test('rejects unavailable skills, absolute paths, traversal, and symlink escapes', async (t) => {
  const root = await temporaryDirectory(t, 'baton-skill-')
  const outside = await temporaryDirectory(t, 'baton-skill-outside-')
  await writeFile(path.join(root, 'SKILL.md'), 'safe')
  await writeFile(path.join(outside, 'secret.md'), 'secret')
  try {
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
  const runtime = new SkillResourceToolRuntime([{ id: 'approved', root }])

  assert.equal((await runtime.execute(invocation({ skill: 'missing', path: 'SKILL.md' }))).error?.code, 'skill_not_available')
  assert.equal((await runtime.execute(invocation({ skill: 'approved', path: path.resolve(root, 'SKILL.md') }))).success, false)
  assert.equal((await runtime.execute(invocation({ skill: 'approved', path: '../secret.md' }))).error?.code, 'path_escape')
  if (await import('node:fs').then(({ existsSync }) => existsSync(path.join(root, 'linked')))) {
    assert.equal((await runtime.execute(invocation({ skill: 'approved', path: 'linked/secret.md' }))).error?.code, 'path_escape')
  }
})

test('composite runtime routes by registered tool without widening either runtime', async (t) => {
  const root = await temporaryDirectory(t, 'baton-skill-')
  await writeFile(path.join(root, 'SKILL.md'), 'safe')
  const skill = new SkillResourceToolRuntime([{ id: 'approved', root }])
  const unavailable: ToolRuntime = {
    definitions: Object.freeze([]),
    async execute() { return { success: false, content: null, error: { code: 'unexpected', message: 'unexpected', retryable: false } } },
  }
  const runtime = new CompositeToolRuntime([unavailable, skill])
  assert.equal(runtime.abortWaitsForTermination, true)
  assert.equal((await runtime.execute(invocation({ skill: 'approved', path: 'SKILL.md' }))).success, true)
  assert.equal((await runtime.execute(invocation({}, 'read_file'))).error?.code, 'tool_not_found')
})
