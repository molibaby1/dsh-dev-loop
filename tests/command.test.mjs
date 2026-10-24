import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { executeDevLoopCommand, createDevLoopCommand, parseDevLoopInput } from '../src/command.mjs'

test('dev-loop command defaults to waiting for human approval', () => {
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    executorTask: 'bounded task',
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts' })
  assert.equal(parsed.projectRoot, '/tmp/project')
  assert.equal(parsed.artifactRoot, '/tmp/dsh-artifacts')
  assert.equal(parsed.approval, false)
  assert.equal(parsed.approvalSource, 'waiting-for-human')
})

test('dev-loop command can explicitly opt into automatic approval', () => {
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts', autoApprove: true })
  assert.equal(parsed.approval, true)
  assert.equal(parsed.approvalSource, 'dev-loop-auto')
})

test('dev-loop command can restore approval gate and rejects artifact roots inside project', () => {
  const gated = parseDevLoopInput(JSON.stringify({ problemPackage: { id: 'x' } }), {
    projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts', autoApprove: false,
  })
  assert.equal(gated.approval, false)
  assert.throws(() => parseDevLoopInput(JSON.stringify({ problemPackage: { id: 'x' }, approve: true }), {
    projectRoot: '/tmp/project', artifactRoot: '/tmp/project/artifacts',
  }), /outside projectRoot/)
})

test('dev-loop command accepts a natural-language task with configured roots', () => {
  const parsed = parseDevLoopInput('修复登录页提交后没有反应的问题', {
    projectRoot: '/tmp/project',
    artifactRoot: '/tmp/dsh-artifacts',
  })
  assert.equal(parsed.problemPackage.summary, '修复登录页提交后没有反应的问题')
  assert.equal(parsed.problemPackage.source, 'human')
  assert.equal(parsed.approval, false)
})

test('task JSON cannot select a DSH permission preset', () => {
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    permissionPreset: 'danger-full-access',
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts' })
  assert.equal(Object.hasOwn(parsed, 'permissionPreset'), false)
})

test('dev-loop command parses approval and cancellation controls', async () => {
  const { parseDevLoopControl } = await import('../src/command.mjs')
  assert.deepEqual(parseDevLoopControl('approve run-123'), { kind: 'approve', runId: 'run-123' })
  assert.deepEqual(parseDevLoopControl('取消 run-123'), { kind: 'cancel', runId: 'run-123' })
  assert.equal(parseDevLoopControl('approve ../escape'), undefined)
})

test('dev-loop command rejects unsafe run identifiers before storage', () => {
  assert.throws(() => parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'x' },
    runId: '../escape',
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts' }), /runId/)
})

test('request cannot replace the host project root with another path or symlink alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-root-boundary-'))
  const configuredRoot = join(root, 'configured')
  const alternateRoot = join(root, 'alternate')
  const alias = join(root, 'alias')
  await mkdir(configuredRoot)
  await mkdir(alternateRoot)
  await symlink(alternateRoot, alias)
  const defaults = { projectRoot: configuredRoot, artifactRoot: join(root, 'artifacts') }

  for (const projectRoot of [alternateRoot, alias]) {
    assert.throws(() => parseDevLoopInput(JSON.stringify({
      problemPackage: { id: 'problem-1' },
      projectRoot,
    }), defaults), /configured projectRoot/)
  }
})

test('request canonical aliases that resolve to the configured project root remain compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-root-canonical-'))
  const configuredRoot = join(root, 'configured')
  const alias = join(root, 'configured-alias')
  await mkdir(configuredRoot)
  await symlink(configuredRoot, alias)
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    projectRoot: alias,
  }), { projectRoot: configuredRoot, artifactRoot: join(root, 'artifacts') })

  assert.equal(parsed.projectRoot, await realpath(configuredRoot))
})

test('request cannot choose an artifact root other than the Host-configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-artifact-root-boundary-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  const alternateRoot = join(root, 'alternate-artifacts')
  const alias = join(root, 'alternate-alias')
  await mkdir(projectRoot)
  await mkdir(artifactRoot)
  await mkdir(alternateRoot)
  await symlink(alternateRoot, alias)

  for (const requestedRoot of [alternateRoot, alias]) {
    assert.throws(() => parseDevLoopInput(JSON.stringify({
      problemPackage: { id: 'problem-1' },
      artifactRoot: requestedRoot,
    }), { projectRoot, artifactRoot }), /configured artifactRoot/)
  }
  assert.throws(() => parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    artifactRoot: 'relative-artifacts',
  }), { projectRoot, artifactRoot }), /absolute/)
})

test('request canonical aliases of the Host artifact root remain compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-artifact-root-canonical-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  const alias = join(root, 'artifact-alias')
  await mkdir(projectRoot)
  await mkdir(artifactRoot)
  await symlink(artifactRoot, alias)

  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    artifactRoot: alias,
  }), { projectRoot, artifactRoot })

  assert.equal(parsed.artifactRoot, artifactRoot)
})

test('artifact root must come from Host configuration', () => {
  assert.throws(() => parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
  }), { projectRoot: '/tmp/project' }), /configured artifactRoot/)
})

test('command rejects an artifact-root override before Host configuration is merged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-command-artifact-root-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  const requestedRoot = join(root, 'request-artifacts')
  await mkdir(projectRoot)

  const result = await executeDevLoopCommand({
    ctx: { agents: {} },
    config: { projectRoot, artifactRoot },
    invocation: {
      rawInput: JSON.stringify({ problemPackage: { id: 'problem-1' }, artifactRoot: requestedRoot }),
    },
  })

  assert.equal(result.kind, 'error')
  await assert.rejects(import('node:fs/promises').then(module => module.access(requestedRoot)), { code: 'ENOENT' })
})

test('dev-loop command records the entered prompt for display', () => {
  const command = createDevLoopCommand({ ctx: {} })
  assert.equal(command.recordInput, true)
  assert.equal(command.description, '输入一句需求，先生成方案，确认后再修改和验证')
  assert.equal(command.input.hint, '例如：修复登录页提交后没有反应的问题')
})

test('dev-loop command gives a plain-language empty-input hint', () => {
  assert.throws(() => parseDevLoopInput('', {
    projectRoot: '/tmp/project',
    artifactRoot: '/tmp/dsh-artifacts',
  }), /请输入一句要完成的需求/)
})
