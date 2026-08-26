import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore, finalizeArtifact } from '../src/artifacts.mjs'
import { createFakeBridge } from '../src/bridge-client.mjs'
import { DevLoopController } from '../src/controller.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-controller-'))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'fixture.txt'), 'PLANNER_UNIQUE_MARKER')
  const store = await new ArtifactStore({ root: join(root, 'runs'), maxArtifactBytes: 1024 * 1024, maxZipBytes: 1024 * 1024 }).init()
  const evidenceCollector = {
    runCommand: async ({ command, args }) => ({ command, args, exitCode: 0, signal: null, stdout: command === 'git' && args[0] === 'rev-parse' ? 'fixture-commit\n' : '', stderr: '', durationMs: 1, ok: true }),
    async collect({ store: ignored, runId }) {
      return {
        artifacts: [
          await store.writeText({ runId, stage: 'evidence', name: 'executor-report.md', mime: 'text/markdown', text: 'EXECUTOR_REPORT', source: 'dsh-executor' }),
          await store.writeText({ runId, stage: 'evidence', name: 'git-diff.patch', mime: 'text/x-patch', text: 'DIFF_PATCH', source: 'git' }),
          await store.writeJson({ runId, stage: 'evidence', name: 'test-result.json', value: { ok: true }, source: 'test-runner' }),
        ],
      }
    },
  }
  return { root, project, store, evidenceCollector }
}

test('controller waits for explicit approval and does not execute', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({ planner: { plan: { title: 'safe plan', executorTask: 'TASK' }, executorTask: 'TASK' } })
  let executed = false
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => { executed = true } },
    runIdFactory: () => 'run-wait',
  })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'problem-1' } })
  assert.equal(result.state, 'WAITING_FOR_APPROVAL')
  assert.equal(executed, false)
  assert.equal(bridge.calls.length, 1)
})

test('controller completes Planner -> Executor -> Reviewer with ordered evidence', async () => {
  const { root, project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({
    planner: { plan: { title: 'safe plan', executorTask: 'TASK' }, executorTask: 'TASK' },
    'reviewer-0': ({ artifacts }) => {
      assert.deepEqual(artifacts.map(artifact => artifact.name), [
        'executor-report.md',
        'git-diff.patch',
        'test-result.json',
        'project-latest-round-0.zip',
      ])
      return { decision: 'ACCEPTED', summary: 'marker verified' }
    },
  })
  const executorCalls = []
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async request => { executorCalls.push(request); return { output: 'EXECUTOR_OK', stopReason: { kind: 'completed' } } } },
    runIdFactory: () => 'run-complete',
  })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'problem-1' }, approval: true })
  assert.equal(result.state, 'COMPLETE')
  assert.equal(result.decision, 'ACCEPTED')
  assert.equal(executorCalls[0].cwd, project)
  assert.equal(executorCalls[0].task, 'TASK')
  assert.ok(result.artifacts.some(artifact => artifact.name === 'run-manifest.json'))
  assert.ok(result.artifacts.some(artifact => artifact.name === 'audit-trace.json'))
  const persistedState = JSON.parse(await readFile(join(root, 'runs', 'run-complete', 'run-state.json'), 'utf8'))
  assert.equal(persistedState.state, 'COMPLETE')
})
