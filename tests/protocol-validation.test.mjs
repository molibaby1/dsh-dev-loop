import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '../src/artifacts.mjs'
import { DevLoopController } from '../src/controller.mjs'

async function makeController(responses) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-protocol-'))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'fixture.txt'), 'fixture')
  const store = await new ArtifactStore({ root: join(root, 'runs'), maxArtifactBytes: 1024 * 1024, maxZipBytes: 1024 * 1024 }).init()
  const evidenceCollector = {
    runCommand: async ({ command, args }) => ({ command, args, exitCode: 0, signal: null, stdout: command === 'git' && args[0] === 'rev-parse' ? 'commit\n' : '', stderr: '', durationMs: 1, ok: true }),
    async collect({ runId }) {
      return { artifacts: [
        await store.writeText({ runId, stage: 'evidence', name: 'executor-report.md', mime: 'text/markdown', text: 'report', source: 'executor' }),
        await store.writeText({ runId, stage: 'evidence', name: 'git-diff.patch', mime: 'text/x-patch', text: 'diff', source: 'git' }),
        await store.writeJson({ runId, stage: 'evidence', name: 'test-result.json', value: { ok: true }, source: 'test' }),
      ] }
    },
  }
  const bridge = { async submit({ stage }) { return structuredClone(responses[stage]) } }
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async () => ({ output: 'done', stopReason: { kind: 'completed' } }) },
    runIdFactory: () => `run-${Math.random().toString(16).slice(2)}`,
  })
  return { controller, project }
}

test('Controller persists unsupported Planner fields as a diagnostic failure', async () => {
  const { controller, project } = await makeController({ planner: { executorTask: 'task', unsupported: true } })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'problem' } })
  assert.equal(result.state, 'FAILED')
  assert.equal(result.diagnostic.code, 'PLANNER_PROTOCOL_INVALID')
  assert.match(result.diagnostic.technical.message, /unsupported fields/)
})

test('Controller accepts structured Planner metadata', async () => {
  const { controller, project } = await makeController({
    planner: { executorTask: 'task', targetBehavior: ['safe'], focusedTests: ['focused'] },
    'reviewer-0': { decision: 'ACCEPTED' },
  })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'problem' }, approval: true })
  assert.equal(result.state, 'COMPLETE')
})

test('Controller persists unsupported Reviewer decisions as a diagnostic failure', async () => {
  const { controller, project } = await makeController({
    planner: { executorTask: 'task' },
    'reviewer-0': { decision: 'UNKNOWN' },
  })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'problem' }, approval: true })
  assert.equal(result.state, 'FAILED')
  assert.equal(result.diagnostic.code, 'REVIEWER_PROTOCOL_INVALID')
  assert.match(result.diagnostic.technical.message, /invalid review decision/)
})
