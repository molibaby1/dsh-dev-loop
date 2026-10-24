import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '../src/artifacts.mjs'
import { createFakeBridge } from '../src/bridge-client.mjs'
import { DevLoopController } from '../src/controller.mjs'

test('controller performs at most one automatic NEEDS_FIX round', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-fix-'))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'fixture.txt'), 'fix')
  const store = await new ArtifactStore({ root: join(root, 'runs'), maxArtifactBytes: 1024 * 1024, maxZipBytes: 1024 * 1024 }).init()
  const gitAdapter = async ({ operation, repoRoot }) => ({
    exitCode: 0,
    stdout: operation === 'root' ? `${repoRoot}\n` : operation === 'head' ? 'fixture\n' : '',
    stderr: '',
  })
  const evidenceCollector = {
    projectRoot: project,
    gitAdapter,
    runCommand: async ({ command, args }) => ({ command, args, exitCode: 0, signal: null, stdout: command === 'git' && args[0] === 'rev-parse' ? 'fixture\n' : '', stderr: '', durationMs: 1, ok: true }),
    async collect({ runId, round }) {
      return { artifacts: [
        await store.writeText({ runId, stage: `evidence-${round}`, name: `executor-report${round ? `-round-${round}` : ''}.md`, mime: 'text/markdown', text: 'report', source: 'dsh-executor' }),
        await store.writeText({ runId, stage: `evidence-${round}`, name: `git-diff${round ? `-round-${round}` : ''}.patch`, mime: 'text/x-patch', text: 'diff', source: 'git' }),
        await store.writeJson({ runId, stage: `evidence-${round}`, name: `test-result${round ? `-round-${round}` : ''}.json`, value: { ok: true }, source: 'test-runner' }),
      ] }
    },
  }
  const bridge = createFakeBridge({
    planner: { plan: { executorTask: 'initial task' }, executorTask: 'initial task' },
    'reviewer-0': { decision: 'NEEDS_FIX', summary: 'fix one issue', nextTask: 'fix one issue' },
    'reviewer-1': { decision: 'ACCEPTED', summary: 'fixed' },
  })
  const tasks = []
  const controller = new DevLoopController({
    store,
    bridge,
    evidenceCollector,
    executor: { execute: async ({ task }) => { tasks.push(task); return { output: 'done', stopReason: { kind: 'completed' } } } },
    runIdFactory: () => 'run-fix',
  })
  const result = await controller.run({ projectRoot: project, problemPackage: { id: 'fix-problem' }, approval: true })
  assert.equal(result.state, 'COMPLETE')
  assert.deepEqual(tasks, ['initial task', 'fix one issue'])
  assert.equal(result.fixCount, 1)
})
