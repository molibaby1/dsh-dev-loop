import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createGitEvidenceAdapter } from '../src/evidence.mjs'

function fixtureGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function roots(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-git-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const artifacts = join(root, 'artifacts')
  await mkdir(repo)
  await mkdir(artifacts)
  fixtureGit(repo, ['init'])
  fixtureGit(repo, ['config', 'user.email', 'test@example.invalid'])
  fixtureGit(repo, ['config', 'user.name', 'DSH Boundary Test'])
  await writeFile(join(repo, 'tracked.txt'), 'before\n')
  fixtureGit(repo, ['add', 'tracked.txt'])
  fixtureGit(repo, ['commit', '-m', 'fixture'])
  return { root, repo, artifacts }
}

function findGitExecutable() {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git')
    try {
      accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
      return realpathSync(candidate)
    } catch {}
  }
  throw new Error('Git fixture executable is unavailable')
}

async function fakeGitFixture(root) {
  if (process.platform === 'win32') return undefined
  const bin = join(root, 'fake-bin')
  await mkdir(bin)
  const executable = join(bin, 'git')
  const logPath = join(root, 'git-calls.jsonl')
  const modePath = join(root, 'git-mode')
  const realGit = findGitExecutable()
  const source = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd(), env: process.env, executable: process.argv[1] }) + '\\n')
const mode = readFileSync(${JSON.stringify(modePath)}, 'utf8').trim()
const hangs = (mode === 'head' && args.includes('HEAD')) || (mode === 'status' && args.includes('status'))
if (hangs) {
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (true) Atomics.wait(wait, 0, 0, 1_000)
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd: process.cwd(), env: process.env, maxBuffer: 64 * 1024 * 1024 })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exitCode = result.status ?? 1
`
  await writeFile(executable, source, { mode: 0o700 })
  await chmod(executable, 0o700)
  await writeFile(modePath, '')
  return {
    executable,
    logPath,
    modePath,
    path: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  }
}

async function readCalls(logPath) {
  try {
    return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function waitForCalls(logPath, count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readCalls(logPath)).length >= count) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`fake Git did not record ${count} calls`)
}

test('Git adapter exposes only fixed read-only operations and rejects caller command data', async t => {
  const { root, repo, artifacts } = await roots(t)
  const fake = await fakeGitFixture(root)
  if (!fake) return t.skip('the executable interception fixture requires POSIX shebang execution')
  const priorPath = process.env.PATH
  const envKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_COUNT']
  const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  try {
    process.env.PATH = fake.path
    const adapter = createGitEvidenceAdapter({ projectRoot: repo, artifactRoot: artifacts })
    process.env.GIT_DIR = '/outside/.git'
    process.env.GIT_WORK_TREE = '/outside'
    process.env.GIT_INDEX_FILE = '/outside/index'
    process.env.GIT_EXTERNAL_DIFF = '/outside/diff'
    process.env.GIT_CONFIG_COUNT = '1'

    const status = await adapter({ operation: 'status' })
    const diff = await adapter({ operation: 'diff', repoRoot: repo })
    assert.equal(status.exitCode, 0)
    assert.equal(diff.exitCode, 0)
    const calls = await readCalls(fake.logPath)
    assert.equal(calls.length, 4)
    assert.equal(realpathSync(calls[0].executable), realpathSync(fake.executable))
    assert.deepEqual(calls[0].args.slice(-5), ['config', '--local', '--null', '--get-regexp', '^filter\\.'])
    assert.ok(calls[1].args.includes('status'))
    assert.equal(calls[1].cwd, adapter.projectRoot)
    assert.equal(calls[1].env.GIT_OPTIONAL_LOCKS, '0')
    assert.equal(calls[1].env.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(calls[1].env.GIT_CONFIG_GLOBAL, '/dev/null')
    assert.equal(calls[1].env.GIT_ATTR_NOSYSTEM, '1')
    for (const key of envKeys) assert.equal(Object.hasOwn(calls[1].env, key), false)
    assert.ok(calls[3].args.includes('--no-ext-diff'))
    assert.ok(calls[3].args.includes('--no-textconv'))
    assert.ok(calls[3].args.includes('core.fsmonitor=false'))

    await assert.rejects(adapter({ operation: 'status', args: ['add', '.'] }), /unsupported Git evidence parameter/)
    await assert.rejects(adapter({ operation: 'status', cwd: '/outside' }), /unsupported Git evidence parameter/)
    await assert.rejects(adapter({ operation: 'status', env: { GIT_DIR: '/outside' } }), /unsupported Git evidence parameter/)
    for (const [command, args] of [
      ['npm', ['run', 'verify:quick']],
      ['node', ['-e', 'process.exit(0)']],
      ['sh', ['-c', 'true']],
    ]) {
      await assert.rejects(adapter({ operation: 'status', command, args }), /unsupported Git evidence parameter/)
    }
    await assert.rejects(adapter({ operation: 'shell', command: 'node', args: ['-e', 'process.exit(0)'] }), /unsupported Git evidence operation/)
    assert.equal((await readCalls(fake.logPath)).length, 4)
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('Git evidence records commit history and changed paths from validated commit ids', async t => {
  const { repo, artifacts } = await roots(t)
  const adapter = createGitEvidenceAdapter({ projectRoot: repo, artifactRoot: artifacts })
  const beforeCommit = fixtureGit(repo, ['rev-parse', 'HEAD']).trim()
  await writeFile(join(repo, 'committed.txt'), 'committed change\n')
  fixtureGit(repo, ['add', 'committed.txt'])
  fixtureGit(repo, ['commit', '-m', 'add committed evidence fixture'])
  const afterCommit = fixtureGit(repo, ['rev-parse', 'HEAD']).trim()

  const [history, historyFiles, committedFiles] = await Promise.all([
    adapter({ operation: 'history', includeCommit: afterCommit, excludeCommit: beforeCommit }),
    adapter({ operation: 'history-files', includeCommit: afterCommit, excludeCommit: beforeCommit }),
    adapter({ operation: 'committed-files', beforeCommit, afterCommit }),
  ])
  assert.equal(history.exitCode, 0)
  assert.match(history.stdout, new RegExp(afterCommit))
  assert.match(history.stdout, /add committed evidence fixture/)
  assert.match(history.stdout, /diff --git a\/committed\.txt b\/committed\.txt/)
  assert.equal(historyFiles.exitCode, 0)
  assert.deepEqual(historyFiles.stdout.split('\0').filter(Boolean), ['committed.txt'])
  assert.equal(committedFiles.exitCode, 0)
  assert.deepEqual(committedFiles.stdout.split('\0').filter(Boolean), ['committed.txt'])

  await assert.rejects(adapter({ operation: 'history', includeCommit: `${afterCommit} --config=core.pager=sh`, excludeCommit: beforeCommit }), /full Git commit SHA/)
  await assert.rejects(adapter({ operation: 'committed-files', beforeCommit, afterCommit: 'HEAD' }), /full Git commit SHA/)
})

test('Git read queries disable local fsmonitor, external diff, and clean-filter execution', async t => {
  const { root, repo, artifacts } = await roots(t)
  const marker = join(root, 'external-was-run')
  const helper = join(root, 'external-hook.sh')
  await writeFile(helper, `#!/bin/sh\nprintf invoked >> '${marker}'\ncat\n`)
  await chmod(helper, 0o755)
  await writeFile(join(repo, '.gitattributes'), 'tracked.txt filter=External\n')
  fixtureGit(repo, ['add', '.gitattributes'])
  fixtureGit(repo, ['commit', '-m', 'fixture attributes'])
  fixtureGit(repo, ['config', 'filter.External.clean', helper])
  fixtureGit(repo, ['config', 'core.fsmonitor', helper])
  fixtureGit(repo, ['config', 'diff.external', helper])
  await writeFile(join(repo, 'tracked.txt'), 'after\n')

  const adapter = createGitEvidenceAdapter({ projectRoot: repo, artifactRoot: artifacts })
  const status = await adapter({ operation: 'status' })
  const diff = await adapter({ operation: 'diff' })
  assert.equal(status.exitCode, 0)
  assert.equal(diff.exitCode, 0)
  await assert.rejects(import('node:fs/promises').then(fs => fs.access(marker)), { code: 'ENOENT' })
})

test('Git snapshot reads reject escaping roots, traversal, and symlink files', async t => {
  const { root, repo, artifacts } = await roots(t)
  const adapter = createGitEvidenceAdapter({ projectRoot: repo, artifactRoot: artifacts })
  const outside = join(root, 'outside')
  const snapshotRoot = join(adapter.artifactRoot, '.snapshots')
  await mkdir(join(snapshotRoot, 'baseline'), { recursive: true })
  await mkdir(join(snapshotRoot, 'after-round-0'), { recursive: true })
  await writeFile(outside, 'must not be read')
  await symlink(outside, join(snapshotRoot, 'baseline', 'linked.txt'))

  await assert.rejects(adapter({
    operation: 'snapshot-diff', repoRoot: repo, snapshotRoot: join(root, 'outside-snapshots'),
    beforeSnapshot: 'baseline', afterSnapshot: 'after-round-0', file: 'tracked.txt', beforeExists: false, afterExists: false,
  }), /escapes artifact root/)
  await assert.rejects(adapter({
    operation: 'snapshot-diff', repoRoot: repo, snapshotRoot,
    beforeSnapshot: 'baseline', afterSnapshot: 'after-round-0', file: '../outside', beforeExists: false, afterExists: false,
  }), /unsafe repository path/)
  await assert.rejects(adapter({
    operation: 'snapshot-diff', repoRoot: repo, snapshotRoot,
    beforeSnapshot: 'baseline', afterSnapshot: 'after-round-0', file: 'linked.txt', beforeExists: true, afterExists: false,
  }), /symlink/)
})

test('Git adapter cancellation and timeout settle through one fixed process with no fallback', async t => {
  const { root, repo, artifacts } = await roots(t)
  const fake = await fakeGitFixture(root)
  if (!fake) return t.skip('the executable interception fixture requires POSIX shebang execution')
  const priorPath = process.env.PATH
  try {
    process.env.PATH = fake.path
    const adapter = createGitEvidenceAdapter({ projectRoot: repo, artifactRoot: artifacts, timeoutMs: 2_000 })
    await writeFile(fake.modePath, 'head')
    const timeoutResult = adapter({ operation: 'head' })
    const timedOut = await timeoutResult
    assert.equal(timedOut.timedOut, true)
    assert.equal((await readCalls(fake.logPath)).length, 1)

    await writeFile(fake.modePath, 'status')
    const cancellation = new AbortController()
    const cancelledRun = adapter({ operation: 'status', signal: cancellation.signal })
    await waitForCalls(fake.logPath, 3)
    cancellation.abort()
    const cancelled = await cancelledRun
    assert.equal(cancelled.aborted, true)
    assert.equal((await readCalls(fake.logPath)).length, 3)
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
  }
})
