import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeM2ExternalSubmitInput, encodeM2ExternalSubmitInput, readM2ExternalRequestFile } from '../src/m2-request.mjs'

test('M2 request file preserves the complete executor task and checks its byte digest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-request-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requestFile = join(root, 'm2-request.json')
  const task = '第一行保留；第二行包含反引号 ` 和美元符号 $()。\n执行时不得截断。'
  const bytes = Buffer.from(JSON.stringify(validRequest({ executorTask: task })), 'utf8')
  await writeFile(requestFile, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const result = await readM2ExternalRequestFile(requestFile, sha256)

  assert.equal(result.sha256, sha256)
  assert.equal(result.request.plan.executorTask, task)
  assert.equal(result.request.source.conversationUrl, 'https://chatgpt.com/c/example')
})

test('M2 request file rejects incomplete, unsafe, invalid-source, oversized, and changed inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-invalid-request-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requestFile = join(root, 'm2-request.json')

  await writeFile(requestFile, JSON.stringify({ schema: 1, requestId: 'missing-plan', source: { type: 'chatgpt-web' } }))
  await assert.rejects(readM2ExternalRequestFile(requestFile), /plan/u)

  await writeFile(requestFile, JSON.stringify(validRequest({ source: { type: 'chatgpt-web', conversationUrl: 'javascript:alert(1)' } })))
  await assert.rejects(readM2ExternalRequestFile(requestFile), /https:\/\/chatgpt.com/u)

  await writeFile(requestFile, JSON.stringify(validRequest({ includedPaths: ['../outside.txt'] })))
  await assert.rejects(readM2ExternalRequestFile(requestFile), /safe repository-relative paths/u)

  await writeFile(requestFile, JSON.stringify(validRequest()))
  await assert.rejects(readM2ExternalRequestFile(requestFile, '0'.repeat(64)), /changed after it was inspected/u)

  await writeFile(requestFile, ' '.repeat(1024 * 1024 + 1))
  await assert.rejects(readM2ExternalRequestFile(requestFile), /exceeds 1048576 bytes/u)

  const target = join(root, 'target.json')
  const alias = join(root, 'alias.json')
  await writeFile(target, JSON.stringify(validRequest()))
  await symlink(target, alias)
  await assert.rejects(readM2ExternalRequestFile(alias), /not a symlink/u)
})

test('M2 command payload round-trips absolute paths without shell interpretation', () => {
  const input = {
    requestFile: '/tmp/path with `quotes`/request.json',
    requestFileSha256: 'a'.repeat(64),
    projectRoot: '/tmp/project with spaces',
  }

  assert.deepEqual(decodeM2ExternalSubmitInput(encodeM2ExternalSubmitInput(input)), input)
  assert.throws(() => encodeM2ExternalSubmitInput({ ...input, requestFile: 'relative.json' }), /absolute/u)
})

function validRequest({ executorTask = 'Implement the approved change.', source = { type: 'chatgpt-web', conversationUrl: 'https://chatgpt.com/c/example' }, includedPaths = ['src/example.mjs'] } = {}) {
  return {
    schema: 1,
    requestId: 'request-2026-10-28-001',
    source,
    plan: {
      schema: 1,
      summary: 'Add the approved M2 change.',
      scope: { includedPaths, excludedPaths: [], nonGoals: [] },
      acceptanceCriteria: ['The targeted behavior is covered.'],
      executionRequirements: ['Use the existing M2 Controller.'],
      contextSources: ['The current local repository state.'],
      observedContext: { branch: 'dev', commit: 'a'.repeat(40) },
      executorTask,
    },
  }
}
