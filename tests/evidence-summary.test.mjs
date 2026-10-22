import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '../src/artifacts.mjs'
import { captureGitSnapshot, createEvidenceCollector, createLocalCommandRunner } from '../src/evidence.mjs'

async function git(runCommand, cwd, args) {
  const result = await runCommand({ command: 'git', args, cwd })
  assert.equal(result.exitCode, 0, result.stderr)
}

test('evidence collector emits a structured test and change summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-summary-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  const runCommand = createLocalCommandRunner()
  await git(runCommand, repo, ['init'])
  await git(runCommand, repo, ['config', 'user.email', 'test@example.invalid'])
  await git(runCommand, repo, ['config', 'user.name', 'DSH Test'])
  await writeFile(join(repo, 'file.txt'), 'before\n')
  await git(runCommand, repo, ['add', 'file.txt'])
  await git(runCommand, repo, ['commit', '-m', 'fixture'])
  const baseline = await captureGitSnapshot({ repoRoot: repo, runCommand, snapshotRoot: join(root, 'snapshots'), snapshotName: 'baseline' })
  await writeFile(join(repo, 'file.txt'), 'after\n')
  const store = await new ArtifactStore({ root: join(root, 'artifacts') }).init()
  const collector = createEvidenceCollector({ store, runCommand, testCommand: [process.execPath, ['-e', 'process.exit(0)']] })
  const result = await collector.collect({ runId: 'run-summary', repoRoot: repo, baseline, executorReport: { output: 'done', stopReason: { kind: 'completed' } } })
  assert.equal(result.summary.test.ok, true)
  assert.equal(result.summary.changedFiles, 1)
  assert.deepEqual(result.summary.changedFileNames, ['file.txt'])
  assert.ok(result.artifacts.some(artifact => artifact.name === 'evidence-summary.json'))
})
