import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureGitSnapshot, createGitEvidenceAdapter, diffSnapshots } from '../src/evidence.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

test('evidence delta excludes pre-existing dirty content and includes new files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-delta-'))
  const repo = join(root, 'repo')
  const artifacts = join(root, 'artifacts')
  await mkdir(repo, { recursive: true })
  await mkdir(artifacts, { recursive: true })
  git(['init'], repo)
  git(['config', 'user.email', 'test@example.invalid'], repo)
  git(['config', 'user.name', 'DSH Test'], repo)
  await writeFile(join(repo, 'existing.txt'), 'before\n')
  git(['add', 'existing.txt'], repo)
  git(['commit', '-m', 'fixture'], repo)
  const gitAdapter = createGitEvidenceAdapter({ projectRoot: repo, artifactRoot: artifacts })
  const snapshots = join(gitAdapter.artifactRoot, '.snapshots')

  await writeFile(join(repo, 'existing.txt'), 'pre-existing-dirty\n')
  const baseline = await captureGitSnapshot({ repoRoot: repo, gitAdapter, snapshotRoot: snapshots, artifactRoot: gitAdapter.artifactRoot, snapshotName: 'baseline' })
  await writeFile(join(repo, 'existing.txt'), 'run-change\n')
  await writeFile(join(repo, 'new.txt'), 'new-from-run\n')
  const after = await captureGitSnapshot({ repoRoot: repo, gitAdapter, snapshotRoot: snapshots, artifactRoot: gitAdapter.artifactRoot, snapshotName: 'after-round-0' })
  const delta = await diffSnapshots({ baseline, after, gitAdapter })
  assert.match(delta, /run-change/)
  assert.match(delta, /new-from-run/)
  assert.doesNotMatch(delta, /^-before$/m)
  assert.match(delta, /-pre-existing-dirty/)

})
