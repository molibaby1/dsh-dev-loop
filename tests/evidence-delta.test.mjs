import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureGitSnapshot, createLocalCommandRunner, diffSnapshots } from '../src/evidence.mjs'

async function command(runCommand, args, cwd) {
  const result = await runCommand({ command: 'git', args, cwd })
  assert.equal(result.exitCode, 0, `${args.join(' ')}: ${result.stderr}`)
  return result
}

test('evidence delta excludes pre-existing dirty content and includes new files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-delta-'))
  const repo = join(root, 'repo')
  const snapshots = join(root, 'snapshots')
  await mkdir(repo, { recursive: true })
  const runCommand = createLocalCommandRunner()
  await command(runCommand, ['init'], repo)
  await command(runCommand, ['config', 'user.email', 'test@example.invalid'], repo)
  await command(runCommand, ['config', 'user.name', 'DSH Test'], repo)
  await writeFile(join(repo, 'existing.txt'), 'before\n')
  await command(runCommand, ['add', 'existing.txt'], repo)
  await command(runCommand, ['commit', '-m', 'fixture'], repo)

  await writeFile(join(repo, 'existing.txt'), 'pre-existing-dirty\n')
  const baseline = await captureGitSnapshot({ repoRoot: repo, runCommand, snapshotRoot: snapshots, snapshotName: 'baseline' })
  await writeFile(join(repo, 'existing.txt'), 'run-change\n')
  await writeFile(join(repo, 'new.txt'), 'new-from-run\n')
  const after = await captureGitSnapshot({ repoRoot: repo, runCommand, snapshotRoot: snapshots, snapshotName: 'after' })
  const delta = await diffSnapshots({ baseline, after, runCommand })
  assert.match(delta, /run-change/)
  assert.match(delta, /new-from-run/)
  assert.doesNotMatch(delta, /^-before$/m)
  assert.match(delta, /-pre-existing-dirty/)

})
