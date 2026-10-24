import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEvidenceCollector } from '../src/evidence.mjs'

test('testCommand is handed to DSH test execution instead of the Git runner', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-loop-dsh-test-boundary-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  const projectRoot = await realpath(repo)
  const gitCalls = []
  const testCalls = []
  const store = {
    async writeText(value) { return value },
    async writeJson(value) { return value },
  }
  const gitAdapter = async request => {
    gitCalls.push(request)
    return {
      exitCode: 0,
      stdout: request.operation === 'head' ? 'fixture-head\n' : '',
      stderr: '',
      durationMs: 1,
      ok: true,
    }
  }
  const testExecutor = async request => {
    testCalls.push(request)
    return {
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      exitCode: 0,
      timedOut: false,
      durationMs: 2,
      ok: true,
      source: 'dsh-tool-result',
    }
  }
  const collector = createEvidenceCollector({
    store,
    gitAdapter,
    testExecutor,
    testCommand: ['node', ['-e', 'process.stdout.write("fixture")']],
  })

  await collector.collect({
    runId: 'run-test-boundary',
    round: 2,
    repoRoot: projectRoot,
    executorReport: { output: 'finished', stopReason: { kind: 'completed' } },
  })

  assert.equal(testCalls.length, 1)
  assert.deepEqual(testCalls[0], {
    runId: 'run-test-boundary',
    round: 2,
    cwd: projectRoot,
    command: 'node',
    args: ['-e', 'process.stdout.write("fixture")'],
    signal: undefined,
  })
  assert.ok(gitCalls.every(call => ['head', 'status', 'diff', 'diff-stat', 'files'].includes(call.operation)))
})
