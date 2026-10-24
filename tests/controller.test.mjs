import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
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
  const gitAdapter = async ({ operation, repoRoot }) => ({
    exitCode: 0,
    stdout: operation === 'root' ? `${repoRoot}\n` : operation === 'head' ? 'fixture-commit\n' : '',
    stderr: '',
  })
  const evidenceCollector = {
    projectRoot: project,
    gitAdapter,
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

test('controller returns a structured bootstrap diagnostic when run storage cannot initialize', async () => {
  const controller = new DevLoopController({
    store: { async runRoot() { throw new Error('storage offline') } },
    bridge: createFakeBridge({}),
    executor: { execute: async () => ({}) },
    evidenceCollector: { projectRoot: '/tmp/project', gitAdapter: async () => ({ exitCode: 0, stdout: '/tmp/project\n', stderr: '' }), collect: async () => ({ artifacts: [] }) },
    runIdFactory: () => 'run-storage-failure',
  })
  const result = await controller.run({ projectRoot: '/tmp/project', problemPackage: { id: 'problem-1' } })
  assert.equal(result.state, 'FAILED')
  assert.equal(result.diagnostic.code, 'ARTIFACT_ROOT_INVALID')
  assert.equal(result.summary.hasModifiedProject, false)
  assert.deepEqual(result.artifacts, [])

  await assert.rejects(controller.run({
    projectRoot: '/tmp/project',
    artifactRoot: '/tmp/untrusted-artifacts',
    problemPackage: { id: 'problem-1' },
  }), /configured artifactRoot/)
})

test('controller rejects a request to run against an unconfigured repository', async () => {
  const { root, project, store, evidenceCollector } = await fixture()
  const alternate = join(root, 'alternate-project')
  await mkdir(alternate)
  const bridge = createFakeBridge({})
  let executed = false
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    projectRoot: project,
    executor: { execute: async () => { executed = true; return {} } },
  })

  await assert.rejects(controller.run({
    projectRoot: alternate,
    problemPackage: { id: 'problem-1' },
  }), /projectRoot must match configured projectRoot/)
  assert.equal(bridge.calls.length, 0)
  assert.equal(executed, false)
})

test('controller rejects an artifact-root override before preflight or Bridge calls', async () => {
  const { root, project, store, evidenceCollector } = await fixture()
  const alternate = join(root, 'alternate-artifacts')
  await mkdir(alternate)
  let preflightCalled = false
  const bridge = createFakeBridge({})
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    projectRoot: project,
    preflight: async () => { preflightCalled = true; return { ok: true } },
    executor: { execute: async () => ({}) },
  })

  await assert.rejects(controller.run({
    projectRoot: project,
    artifactRoot: alternate,
    problemPackage: { id: 'problem-1' },
  }), /configured artifactRoot/)
  assert.equal(preflightCalled, false)
  assert.equal(bridge.calls.length, 0)
})

test('controller accepts an artifact-root alias only when it resolves to the configured store root', async () => {
  const { root, project, store, evidenceCollector } = await fixture()
  const alias = join(root, 'artifact-root-alias')
  await symlink(store.root, alias)
  const preflightRoots = []
  const controller = new DevLoopController({
    store,
    bridge: createFakeBridge({ planner: { executorTask: 'bounded task' } }),
    evidenceCollector,
    projectRoot: project,
    preflight: async ({ artifactRoot }) => { preflightRoots.push(artifactRoot); return { ok: true } },
    executor: { execute: async () => ({}) },
  })

  const result = await controller.run({
    projectRoot: project,
    artifactRoot: alias,
    problemPackage: { id: 'problem-1' },
  })

  assert.equal(result.state, 'WAITING_FOR_APPROVAL')
  assert.deepEqual(preflightRoots, [store.root])
})

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

test('controller resumes a persisted plan with a fresh controller', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({
    planner: { executorTask: 'persisted task' },
    'reviewer-0': { decision: 'ACCEPTED', summary: 'approved after review' },
  })
  let executed = 0
  const first = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => { executed += 1; return { output: 'done', stopReason: { kind: 'completed' } } } },
    runIdFactory: () => 'run-resume',
  })
  const waiting = await first.run({ projectRoot: project, problemPackage: { id: 'problem-1' } })
  assert.equal(waiting.state, 'WAITING_FOR_APPROVAL')
  assert.equal(executed, 0)

  const resumed = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => { executed += 1; return { output: 'done', stopReason: { kind: 'completed' } } } },
  })
  const result = await resumed.resumeApproved({ runId: waiting.runId })
  assert.equal(result.state, 'COMPLETE')
  assert.equal(executed, 1)
  assert.equal(bridge.calls.filter(call => call.stage === 'planner').length, 1)
  assert.ok(result.audit.audit.some(entry => entry.to === 'WAITING_FOR_APPROVAL'))
  assert.ok(result.audit.audit.some(entry => entry.to === 'EXECUTING'))
  assert.equal(new Set(result.artifacts.map(artifact => artifact.name)).size, result.artifacts.length)
})

test('controller rejects a changed persisted plan before approval', async () => {
  const { root, project, store, evidenceCollector } = await fixture()
  const controller = new DevLoopController({
    store,
    bridge: createFakeBridge({ planner: { executorTask: 'safe task' } }),
    evidenceCollector,
    executor: { execute: async () => ({}) },
    runIdFactory: () => 'run-tampered-plan',
  })
  const waiting = await controller.run({ projectRoot: project, problemPackage: { id: 'problem-1' } })
  await writeFile(join(root, 'runs', waiting.runId, 'plan.json'), '{"executorTask":"tampered"}\n')
  await assert.rejects(() => controller.resumeApproved({ runId: waiting.runId }), /artifact hash changed/)
})

test('controller rejects a persisted request that changes the trusted artifact root on resume', async () => {
  const { root, project, store, evidenceCollector } = await fixture()
  const alternate = join(root, 'alternate-artifacts')
  await mkdir(alternate)
  const bridge = createFakeBridge({ planner: { executorTask: 'persisted task' } })
  const first = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    projectRoot: project,
    executor: { execute: async () => ({}) },
    runIdFactory: () => 'run-tampered-artifact-root',
  })
  const waiting = await first.run({ projectRoot: project, problemPackage: { id: 'problem-1' } })
  const request = await store.readJson({ runId: waiting.runId, name: 'run-request.json' })
  request.artifactRoot = alternate
  await store.writeJson({ runId: waiting.runId, stage: 'request', name: 'run-request.json', value: request, source: 'human' })
  let executed = false
  const resumed = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    projectRoot: project,
    executor: { execute: async () => { executed = true; return { output: 'done', stopReason: { kind: 'completed' } } } },
  })

  await assert.rejects(() => resumed.resumeApproved({ runId: waiting.runId }), /configured artifactRoot/)
  assert.equal(executed, false)
})

test('controller cancels a persisted waiting run without executing', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const controller = new DevLoopController({
    store,
    bridge: createFakeBridge({ planner: { executorTask: 'must not run' } }),
    evidenceCollector,
    executor: { execute: async () => { throw new Error('should not execute') } },
    runIdFactory: () => 'run-cancel-waiting',
  })
  const waiting = await controller.run({ projectRoot: project, problemPackage: { id: 'problem-1' } })
  const result = await controller.cancelRun({ runId: waiting.runId })
  assert.equal(result.state, 'CANCELLED')
  assert.equal(result.summary.hasModifiedProject, false)
})

test('controller persists a cancelled preflight as a terminal diagnostic', async () => {
  const { root, project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({})
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => ({}) },
    preflight: async () => {
      const error = new Error('cancelled by user')
      error.name = 'AbortError'
      throw error
    },
    runIdFactory: () => 'run-cancelled',
  })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'problem-1' } })
  assert.equal(result.state, 'CANCELLED')
  assert.equal(result.diagnostic.code, 'CANCELLED')
  assert.equal(bridge.calls.length, 0)
  assert.ok(result.artifacts.some(artifact => artifact.name === 'diagnostic.json'))
  const persisted = JSON.parse(await readFile(join(root, 'runs', 'run-cancelled', 'run-state.json'), 'utf8'))
  assert.equal(persisted.state, 'CANCELLED')
})

test('controller honors cancellation after Planner before approval or execution', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const aborter = new AbortController()
  const bridge = createFakeBridge({
    planner: () => {
      aborter.abort()
      return { executorTask: 'must not execute' }
    },
  })
  let executed = false
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => { executed = true } },
    runIdFactory: () => 'run-cancel-after-planner',
  })
  const result = await controller.run({
    projectRoot: project,
    problemPackage: { id: 'problem-1' },
    approval: true,
    signal: aborter.signal,
  })
  assert.equal(result.state, 'CANCELLED')
  assert.equal(result.summary.hasModifiedProject, false)
  assert.equal(executed, false)
})

test('controller replans after NEEDS_REPLAN and resumes execution', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({
    planner: { executorTask: 'initial task' },
    'reviewer-0': { decision: 'NEEDS_REPLAN', summary: 'the plan needs a different approach' },
    'planner-1': ({ prompt, artifacts }) => {
      assert.match(prompt, /the plan needs a different approach/)
      assert.deepEqual(artifacts.map(artifact => artifact.name), ['project-latest-round-0.zip', 'review.json'])
      return { executorTask: 'replanned task' }
    },
    'reviewer-1': { decision: 'ACCEPTED', summary: 'replanned result verified' },
  })
  const tasks = []
  const progress = []
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async ({ task }) => { tasks.push(task); return { output: 'done', stopReason: { kind: 'completed' } } } },
    runIdFactory: () => 'run-replan',
  })
  const result = await controller.run({
    projectRoot: project,
    problemPackage: { id: 'problem-1' },
    approval: true,
    onProgress: event => progress.push(event.stage),
  })
  assert.equal(result.state, 'COMPLETE')
  assert.deepEqual(tasks, ['initial task', 'replanned task'])
  assert.deepEqual(bridge.calls.map(call => call.stage), ['planner', 'reviewer-0', 'planner-1', 'reviewer-1'])
  assert.deepEqual(progress, [
    'CHECKING_ENVIRONMENT',
    'ANALYZING',
    'PLAN_READY',
    'EXECUTING',
    'COLLECTING_EVIDENCE',
    'REVIEWING',
    'ANALYZING',
    'PLAN_READY',
    'EXECUTING',
    'COLLECTING_EVIDENCE',
    'REVIEWING',
    'COMPLETE',
  ])
})

test('controller stops after one automatic replan', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({
    planner: { executorTask: 'initial task' },
    'reviewer-0': { decision: 'NEEDS_REPLAN', summary: 'replan once' },
    'planner-1': { executorTask: 'replanned task' },
    'reviewer-1': { decision: 'NEEDS_REPLAN', summary: 'still needs replan' },
  })
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => ({ output: 'done', stopReason: { kind: 'completed' } }) },
    runIdFactory: () => 'run-replan-limit',
  })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'problem-1' }, approval: true })
  assert.equal(result.state, 'STOPPED')
  assert.equal(result.audit.audit.at(-1).reason, 'automatic replan budget exhausted')
  assert.equal(bridge.calls.filter(call => call.stage.startsWith('planner-')).length, 1)
})

test('controller reports phase progress after each transition', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({ planner: { executorTask: 'TASK' } })
  const progress = []
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => ({ output: 'done', stopReason: { kind: 'completed' } }) },
    runIdFactory: () => 'run-progress',
  })
  const result = await controller.run({
    projectRoot: project,
    problemPackage: { id: 'problem-1' },
    onProgress: event => progress.push(event.stage),
  })
  assert.equal(result.state, 'WAITING_FOR_APPROVAL')
  assert.deepEqual(progress, ['CHECKING_ENVIRONMENT', 'ANALYZING', 'PLAN_READY', 'WAITING_FOR_APPROVAL'])
})

test('controller executes an approved run without waiting for approval', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({
    planner: { executorTask: 'TASK' },
    'reviewer-0': { decision: 'ACCEPTED', summary: 'auto-approved smoke' },
  })
  let executed = false
  const progress = []
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => { executed = true; return { output: 'done', stopReason: { kind: 'completed' } } } },
    runIdFactory: () => 'run-auto-approved',
  })
  const result = await controller.run({
    projectRoot: project,
    problemPackage: { id: 'problem-1' },
    approval: true,
    approvalSource: 'dev-loop-auto',
    onProgress: event => progress.push(event.stage),
  })
  assert.equal(result.state, 'COMPLETE')
  assert.equal(executed, true)
  assert.equal(progress.includes('WAITING_FOR_APPROVAL'), false)
})

test('controller uses caller executorTask when Planner omits it', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const bridge = createFakeBridge({
    planner: { plan: { title: 'safe plan' } },
    'reviewer-0': { decision: 'ACCEPTED', summary: 'smoke verified' },
  })
  const tasks = []
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async ({ task }) => { tasks.push(task); return { output: 'EXECUTOR_OK', stopReason: { kind: 'completed' } } } },
    runIdFactory: () => 'run-caller-task',
  })
  const result = await controller.run({
    projectRoot: project,
    problemPackage: { id: 'problem-1' },
    approval: true,
    executorTask: 'caller task',
  })
  assert.equal(result.state, 'COMPLETE')
  assert.deepEqual(tasks, ['caller task'])
})

test('controller serializes structured Planner executorTask for the Executor', async () => {
  const { project, store, evidenceCollector } = await fixture()
  const structuredTask = { mode: 'read-only-smoke-test', objective: 'do not modify the repository' }
  const bridge = createFakeBridge({
    planner: { plan: { title: 'safe plan', executorTask: structuredTask }, executorTask: structuredTask },
    'reviewer-0': { decision: 'ACCEPTED', summary: 'smoke verified' },
  })
  const tasks = []
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async ({ task }) => { tasks.push(task); return { output: 'EXECUTOR_OK', stopReason: { kind: 'completed' } } } },
    runIdFactory: () => 'run-structured-task',
  })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'problem-1' }, approval: true })
  assert.equal(result.state, 'COMPLETE')
  assert.deepEqual(tasks, [JSON.stringify(structuredTask)])
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
  const reviewerCall = bridge.calls.find(request => request.stage === 'reviewer-0')
  assert.ok(reviewerCall.idempotencyKey.length <= 256)
  assert.equal(executorCalls[0].cwd, await realpath(project))
  assert.equal(executorCalls[0].task, 'TASK')
  assert.ok(result.artifacts.some(artifact => artifact.name === 'run-manifest.json'))
  assert.ok(result.artifacts.some(artifact => artifact.name === 'audit-trace.json'))
  const persistedState = JSON.parse(await readFile(join(root, 'runs', 'run-complete', 'run-state.json'), 'utf8'))
  assert.equal(persistedState.state, 'COMPLETE')
})
