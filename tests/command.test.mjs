import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDevLoopInput } from '../src/command.mjs'

test('dev-loop command requires explicit approval and absolute roots', () => {
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    approve: true,
    executorTask: 'bounded task',
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts' })
  assert.equal(parsed.projectRoot, '/tmp/project')
  assert.equal(parsed.artifactRoot, '/tmp/dsh-artifacts')
  assert.equal(parsed.approval, true)
})

test('dev-loop command rejects missing approval and artifact roots inside project', () => {
  assert.throws(() => parseDevLoopInput(JSON.stringify({ problemPackage: { id: 'x' } }), {
    projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts',
  }), /explicit approval/)
  assert.throws(() => parseDevLoopInput(JSON.stringify({ problemPackage: { id: 'x' }, approve: true }), {
    projectRoot: '/tmp/project', artifactRoot: '/tmp/project/artifacts',
  }), /outside projectRoot/)
})
