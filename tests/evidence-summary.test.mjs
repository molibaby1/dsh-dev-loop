import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '../src/artifacts.mjs'
import { captureGitSnapshot, createEvidenceCollector, createGitEvidenceAdapter } from '../src/evidence.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

test('evidence collector emits a structured test and change summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-summary-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'DSH Test'])
  await writeFile(join(repo, 'file.txt'), 'before\n')
  git(repo, ['add', 'file.txt'])
  git(repo, ['commit', '-m', 'fixture'])
  const artifacts = join(root, 'artifacts')
  await mkdir(artifacts)
  const gitAdapter = createGitEvidenceAdapter({ projectRoot: repo, artifactRoot: artifacts })
  const baseline = await captureGitSnapshot({ repoRoot: repo, gitAdapter, snapshotRoot: join(gitAdapter.artifactRoot, '.snapshots'), artifactRoot: gitAdapter.artifactRoot, snapshotName: 'baseline' })
  await writeFile(join(repo, 'file.txt'), 'after\n')
  const store = await new ArtifactStore({ root: join(root, 'artifacts') }).init()
  const testCalls = []
  const collector = createEvidenceCollector({
    store,
    gitAdapter,
    artifactRoot: gitAdapter.artifactRoot,
    testExecutor: async request => {
      testCalls.push(request)
      return { source: 'dsh-tool-result', ok: true, exitCode: 0, durationMs: 2 }
    },
    testCommand: ['npm', ['run', 'verify:quick']],
  })
  const result = await collector.collect({ runId: 'run-summary', repoRoot: repo, baseline, executorReport: { output: 'done', stopReason: { kind: 'completed' } } })
  assert.equal(testCalls.length, 1)
  assert.deepEqual(testCalls[0], { runId: 'run-summary', round: 0, cwd: repo, command: 'npm', args: ['run', 'verify:quick'], signal: undefined })
  assert.equal(result.summary.test.ok, true)
  assert.equal(result.summary.changedFiles, 1)
  assert.deepEqual(result.summary.changedFileNames, ['file.txt'])
  assert.ok(result.artifacts.some(artifact => artifact.name === 'evidence-summary.json'))
})
