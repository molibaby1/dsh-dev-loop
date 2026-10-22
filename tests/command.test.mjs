import assert from 'node:assert/strict'
import test from 'node:test'
import { createDevLoopCommand, parseDevLoopInput } from '../src/command.mjs'

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
