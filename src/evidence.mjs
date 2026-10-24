import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { devNull } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const GIT_TIMEOUT_MS = 30_000
const GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
const GIT_OPERATIONS = new Set(['head', 'root', 'status', 'diff', 'diff-stat', 'files', 'snapshot-diff'])

/** Create the closed, project-bound Git adapter used only for evidence queries. */
export function createGitEvidenceAdapter({ projectRoot, artifactRoot, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const trustedProjectRoot = canonicalConfiguredPath(projectRoot, 'projectRoot')
  const trustedArtifactRoot = canonicalConfiguredPath(artifactRoot, 'artifactRoot')
  const executable = resolveExecutable('git')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GIT_TIMEOUT_MS) throw new Error(`Git timeoutMs must be between 1 and ${GIT_TIMEOUT_MS}`)

  const runGitEvidence = async function runGitEvidence({ operation, repoRoot = trustedProjectRoot, signal, ...parameters } = {}) {
    if (!GIT_OPERATIONS.has(operation)) throw new Error(`unsupported Git evidence operation: ${String(operation)}`)
    const allowed = operation === 'snapshot-diff' ? ['snapshotRoot', 'beforeSnapshot', 'afterSnapshot', 'file', 'beforeExists', 'afterExists'] : []
    for (const key of Object.keys(parameters)) if (!allowed.includes(key)) throw new Error(`unsupported Git evidence parameter: ${key}`)
    const repo = await canonicalExistingDirectory(repoRoot, 'repository')
    if (repo !== trustedProjectRoot) throw new Error('Git evidence repository does not match configured projectRoot')
    let cwd = repo
    const filterOverrides = ['status', 'diff', 'diff-stat'].includes(operation)
      ? await localFilterOverrides(executable, repo, signal, timeoutMs)
      : []
    let args = gitArguments(operation, undefined, undefined, filterOverrides)
    if (operation === 'snapshot-diff') {
      cwd = await assertSnapshotDirectory(trustedArtifactRoot, parameters.snapshotRoot)
      const file = safeRelativeFile(parameters.file)
      const before = parameters.beforeExists === true
        ? await assertSnapshotFile(cwd, parameters.beforeSnapshot, file)
        : devNull
      const after = parameters.afterExists === true
        ? await assertSnapshotFile(cwd, parameters.afterSnapshot, file)
        : devNull
      if (parameters.beforeExists !== true && parameters.beforeExists !== false) throw new Error('beforeExists must be boolean')
      if (parameters.afterExists !== true && parameters.afterExists !== false) throw new Error('afterExists must be boolean')
      args = gitArguments(operation, before, after)
    }
    return runGit(executable, args, cwd, signal, timeoutMs)
  }
  Object.defineProperties(runGitEvidence, {
    projectRoot: { value: trustedProjectRoot },
    artifactRoot: { value: trustedArtifactRoot },
  })
  return runGitEvidence
}

function canonicalConfiguredPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`)
  const path = resolve(value)
  try { return realpathSync(path) } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return path
    throw error
  }
}

async function canonicalExistingDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} path must be absolute`)
  const path = await realpath(value)
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a directory`)
  return path
}

function resolveExecutable(value) {
  const candidates = isAbsolute(value)
    ? [value]
    : String(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, value))
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate)
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      accessSync(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
      return path
    } catch {}
  }
  throw new Error(`fixed executable is unavailable: ${value}`)
}

function gitArguments(operation, before, after, filterOverrides = []) {
  const prefix = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...filterOverrides]
  switch (operation) {
    case 'head': return [...prefix, 'rev-parse', 'HEAD']
    case 'root': return [...prefix, 'rev-parse', '--show-toplevel']
    case 'status': return [...prefix, 'status', '--short', '--branch', '--untracked-files=normal']
    case 'diff': return [...prefix, 'diff', '--binary', '--no-ext-diff', '--no-textconv']
    case 'diff-stat': return [...prefix, 'diff', '--stat', '--no-ext-diff', '--no-textconv']
    case 'files': return [...prefix, 'ls-files', '-co', '--exclude-standard', '-z']
    case 'snapshot-diff': return [...prefix, 'diff', '--no-index', '--binary', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', before, after]
    default: throw new Error(`unsupported Git evidence operation: ${String(operation)}`)
  }
}

async function localFilterOverrides(executable, cwd, signal, timeoutMs) {
  const result = await runGit(executable, [
    '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
    'config', '--local', '--null', '--get-regexp', '^filter\\.',
  ], cwd, signal, timeoutMs)
  if (result.aborted) throw abortError('Git filter inspection cancelled')
  if (result.timedOut) throw new Error('Git filter inspection timed out')
  if (result.outputLimitExceeded) throw new Error('Git filter configuration exceeded the output limit')
  if (result.exitCode === 1 && result.stdout === '') return []
  if (result.exitCode !== 0) throw new Error(`Git filter inspection failed: ${result.stderr.trim()}`)

  const drivers = new Set()
  for (const entry of result.stdout.split('\0')) {
    const separator = entry.indexOf('\n')
    const key = separator < 0 ? entry : entry.slice(0, separator)
    const lowerKey = key.toLowerCase()
    for (const suffix of ['.clean', '.smudge', '.process', '.required']) {
      if (lowerKey.startsWith('filter.') && lowerKey.endsWith(suffix)) drivers.add(key.slice(0, -suffix.length))
    }
  }
  return [...drivers].sort().flatMap(driver => [
    '-c', `${driver}.clean=`,
    '-c', `${driver}.smudge=`,
    '-c', `${driver}.process=`,
    '-c', `${driver}.required=false`,
  ])
}

function runGit(executable, args, cwd, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(abortError('Git evidence collection cancelled'))
  const started = performance.now()
  const env = {
    PATH: process.env.PATH ?? '',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  }
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    let stopCause
    let outputLimitExceeded = false
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdout = []
    const stderr = []
    let forceTimer
    const stop = cause => {
      if (stopCause) return
      stopCause = cause
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
    }
    const collect = (chunks, chunk, which) => {
      const bytes = Buffer.from(chunk)
      const used = which === 'stdout' ? stdoutBytes : stderrBytes
      const remaining = Math.max(0, GIT_OUTPUT_LIMIT_BYTES - used)
      if (bytes.length > remaining) {
        if (remaining) chunks.push(bytes.subarray(0, remaining))
        outputLimitExceeded = true
        stop('output-limit')
      } else {
        chunks.push(bytes)
      }
      if (which === 'stdout') stdoutBytes += bytes.length
      else stderrBytes += bytes.length
    }
    const timeout = setTimeout(() => stop('timeout'), timeoutMs)
    const onAbort = () => stop('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => collect(stdout, chunk, 'stdout'))
    child.stderr.on('data', chunk => collect(stderr, chunk, 'stderr'))
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forceTimer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', (exitCode, signalName) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forceTimer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        command: executable,
        args,
        cwd,
        exitCode,
        signal: signalName,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Math.round(performance.now() - started),
        timedOut: stopCause === 'timeout',
        aborted: stopCause === 'aborted',
        outputLimitExceeded,
        ok: exitCode === 0 && !stopCause && !outputLimitExceeded,
      })
    })
  })
}

async function assertSnapshotDirectory(artifactRoot, snapshotRoot) {
  if (typeof snapshotRoot !== 'string' || !isAbsolute(snapshotRoot)) throw new Error('snapshotRoot must be an absolute path')
  return ensureDirectoryWithin(artifactRoot, snapshotRoot, false)
}

async function assertSnapshotFile(snapshotRoot, snapshotName, file) {
  const name = safeSnapshotName(snapshotName)
  const directory = resolve(snapshotRoot, name)
  await ensureDirectoryWithin(snapshotRoot, directory, false)
  const path = resolve(directory, file)
  if (!isInside(directory, path)) throw new Error(`snapshot file escapes snapshot directory: ${file}`)
  let current = directory
  const segments = relative(directory, path).split(sep)
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index])
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`snapshot file path contains a symlink: ${file}`)
    if (index < segments.length - 1 && !info.isDirectory()) throw new Error(`snapshot file parent is not a directory: ${file}`)
    if (index === segments.length - 1 && !info.isFile()) throw new Error(`snapshot file is not a regular file: ${file}`)
  }
  if (await realpath(path) !== path) throw new Error(`snapshot file path is not canonical: ${file}`)
  return path
}

async function ensureDirectoryWithin(baseValue, targetValue, create) {
  const base = await realpath(baseValue)
  if (base !== resolve(baseValue)) throw new Error('artifact root must be canonical')
  const target = resolve(targetValue)
  if (!isInside(base, target)) throw new Error('snapshot directory escapes artifact root')
  let current = base
  const segments = relative(base, target).split(sep).filter(Boolean)
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`snapshot directory contains an unsafe path: ${current}`)
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error
      await mkdir(current, { mode: 0o700 })
    }
    if (await realpath(current) !== current) throw new Error(`snapshot directory path is not canonical: ${current}`)
  }
  return target
}

async function readRepositoryFile(repoRoot, file) {
  const path = resolve(repoRoot, file)
  if (!isInside(repoRoot, path)) throw new Error(`repository path escapes root: ${file}`)
  let current = repoRoot
  const segments = relative(repoRoot, path).split(sep).filter(Boolean)
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index])
    let info
    try { info = await lstat(current) } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    if (info.isSymbolicLink()) {
      if (index !== segments.length - 1) throw new Error(`repository path traverses a symlink: ${file}`)
      const target = await readlink(current)
      return Buffer.concat([Buffer.from('\0SYMLINK\0'), Buffer.from(target)])
    }
    if (index < segments.length - 1 && !info.isDirectory()) return undefined
    if (index === segments.length - 1) return info.isFile() ? readFile(current) : undefined
  }
  return undefined
}

function safeRelativeFile(file) {
  if (typeof file !== 'string' || file === '' || isAbsolute(file) || file.includes('\0')) throw new Error('unsafe repository path')
  const path = resolve('/', file)
  const normalized = relative('/', path)
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized !== file.replaceAll('/', sep)) throw new Error(`unsafe repository path: ${file}`)
  return normalized
}

function safeSnapshotName(value) {
  if (!['baseline', 'approval-check', 'reviewer-current'].includes(value) && !/^after-round-\d+$/u.test(value)) {
    throw new Error(`unsupported snapshot name: ${String(value)}`)
  }
  return value
}

function snapshotNameFromPath(path) {
  return safeSnapshotName(basename(path))
}

function abortError(message) {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'CANCELLED'
  return error
}

async function git(gitAdapter, repoRoot, operation, signal) {
  const result = await gitAdapter({ operation, repoRoot, signal })
  if (result.aborted) throw abortError('Git evidence collection cancelled')
  if (result.timedOut) throw new Error(`git evidence operation timed out: ${operation}`)
  if (result.outputLimitExceeded) throw new Error(`git evidence output exceeded the limit: ${operation}`)
  const expectedExitCodes = operation === 'snapshot-diff' ? [0, 1] : [0]
  if (!expectedExitCodes.includes(result.exitCode)) throw new Error(`git ${operation} failed: ${result.stderr.trim()}`)
  return result.stdout
}

export async function captureGitSnapshot({ repoRoot, gitAdapter, snapshotRoot, artifactRoot = gitAdapter?.artifactRoot, snapshotName = 'baseline', signal }) {
  throwIfAborted(signal)
  repoRoot = await canonicalExistingDirectory(repoRoot, 'repository')
  const [commit, status, diff, diffStat, fileList] = await Promise.all([
    git(gitAdapter, repoRoot, 'head', signal),
    git(gitAdapter, repoRoot, 'status', signal),
    git(gitAdapter, repoRoot, 'diff', signal),
    git(gitAdapter, repoRoot, 'diff-stat', signal),
    git(gitAdapter, repoRoot, 'files', signal),
  ])
  const files = parseNulPaths(fileList)
  const snapshotDir = snapshotRoot ? join(resolve(snapshotRoot), safeSnapshotName(snapshotName)) : undefined
  const fileHashes = snapshotDir ? await copyAndHashFiles(repoRoot, files, snapshotDir, artifactRoot, signal) : {}
  return {
    commit: commit.trim(),
    status,
    diff,
    diffStat,
    dirty: status.split('\n').some(line => /^[MADRCU?]{1,2}\s/.test(line)),
    files,
    fileHashes,
    snapshotName,
    snapshotDir,
    snapshotRoot: snapshotRoot ? resolve(snapshotRoot) : undefined,
  }
}

export async function diffSnapshots({ baseline, after, gitAdapter, signal }) {
  throwIfAborted(signal)
  if (!baseline?.snapshotDir || !after?.snapshotDir) return after?.diff ?? ''
  const paths = [...new Set([...Object.keys(baseline.fileHashes ?? {}), ...Object.keys(after.fileHashes ?? {})])]
    .filter(file => baseline.fileHashes?.[file] !== after.fileHashes?.[file])
    .sort()
  const chunks = []
  for (const file of paths) {
    const before = baseline.fileHashes?.[file] ? join(baseline.snapshotDir, file) : devNull
    const current = after.fileHashes?.[file] ? join(after.snapshotDir, file) : devNull
    const result = await gitAdapter({
      operation: 'snapshot-diff',
      repoRoot: gitAdapter.projectRoot,
      snapshotRoot: baseline.snapshotRoot,
      beforeSnapshot: 'baseline',
      afterSnapshot: after.snapshotName ?? snapshotNameFromPath(after.snapshotDir),
      file,
      beforeExists: Boolean(baseline.fileHashes?.[file]),
      afterExists: Boolean(after.fileHashes?.[file]),
      signal,
    })
    if (result.aborted) throw abortError('Git snapshot diff cancelled')
    if (result.timedOut) throw new Error(`git diff --no-index timed out for ${file}`)
    if (result.outputLimitExceeded) throw new Error(`git diff --no-index output exceeded the limit for ${file}`)
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`git diff --no-index failed for ${file}: ${result.stderr.trim()}`)
    if (result.stdout) chunks.push(normalizePatchPaths(result.stdout, before, current, file))
  }
  return chunks.join('')
}

export function createEvidenceCollector({ store, gitAdapter, testExecutor, artifactRoot = store?.root, testCommand = ['npm', ['run', 'verify:quick']] } = {}) {
  if (!store) throw new Error('artifact store is required')
  if (typeof gitAdapter !== 'function') throw new Error('fixed Git evidence adapter is required')
  if (typeof testExecutor !== 'function') throw new Error('DSH test executor is required')
  return {
    gitAdapter,
    async collect({ runId, round = 0, repoRoot, executorReport, baseline, signal, testCommand: requestedTestCommand }) {
      throwIfAborted(signal)
      const after = await captureGitSnapshot({
        repoRoot,
        gitAdapter,
        snapshotRoot: baseline?.snapshotRoot,
        artifactRoot,
        snapshotName: `after-round-${round}`,
        signal,
      })
      const delta = await diffSnapshots({ baseline, after, gitAdapter, signal })
      const [command, args] = requestedTestCommand ?? testCommand
      throwIfAborted(signal)
      const test = await testExecutor({ runId, round, cwd: repoRoot, command, args, signal })
      const changedFileNames = changedFilesBetween(baseline, after)
      const summary = {
        round,
        changedFiles: changedFileNames.length,
        changedFileNames,
        deltaBytes: Buffer.byteLength(delta ?? '', 'utf8'),
        baseline: { commit: baseline?.commit ?? null, dirty: Boolean(baseline?.dirty) },
        after: { commit: after?.commit ?? null, dirty: Boolean(after?.dirty) },
        test: {
          ok: test?.ok === true,
          exitCode: test?.exitCode ?? null,
          timedOut: Boolean(test?.timedOut),
          durationMs: test?.durationMs ?? null,
          command: [command, ...args],
        },
        executor: { stopReason: executorReport?.stopReason ?? null },
      }
      const suffix = round === 0 ? '' : `-round-${round}`
      const reportText = typeof executorReport === 'string'
        ? executorReport
        : formatExecutorReport(executorReport, baseline, after, delta)
      const report = await store.writeText({
        runId,
        stage: `evidence-${round}`,
        name: `executor-report${suffix}.md`,
        mime: 'text/markdown',
        text: reportText,
        source: 'dsh-executor',
      })
      const diff = await store.writeText({
        runId,
        stage: `evidence-${round}`,
        name: `git-diff${suffix}.patch`,
        mime: 'text/x-patch',
        text: delta,
        source: 'git-run-delta',
      })
      const testResult = await store.writeJson({
        runId,
        stage: `evidence-${round}`,
        name: `test-result${suffix}.json`,
        value: {
          command: [command, ...args],
          cwd: repoRoot,
          ...test,
        },
        source: 'dsh-authorized-test-tool',
      })
      const summaryArtifact = await store.writeJson({
        runId,
        stage: `evidence-${round}`,
        name: `evidence-summary${suffix}.json`,
        value: summary,
        source: 'evidence-summary',
      })
      const baselineArtifact = await store.writeJson({
        runId,
        stage: `evidence-${round}`,
        name: `baseline-snapshot${suffix}.json`,
        value: compactSnapshot(baseline),
        source: 'git-baseline',
      })
      const afterArtifact = await store.writeJson({
        runId,
        stage: `evidence-${round}`,
        name: `after-snapshot${suffix}.json`,
        value: compactSnapshot(after),
        source: 'git-after',
      })
      return {
        baseline,
        after,
        delta,
        test,
        summary,
        artifacts: [report, diff, testResult, summaryArtifact, baselineArtifact, afterArtifact],
        reviewArtifacts: [report, diff, testResult, summaryArtifact],
      }
    },
  }
}

async function copyAndHashFiles(repoRoot, files, snapshotDir, artifactRoot, signal) {
  const root = resolve(repoRoot)
  await ensureDirectoryWithin(artifactRoot, snapshotDir, true)
  const hashes = {}
  for (const file of files) {
    throwIfAborted(signal)
    safeRelativeFile(file)
    const source = resolve(root, file)
    if (!isInside(root, source)) throw new Error(`repository path escapes root: ${file}`)
    const bytes = await readRepositoryFile(root, file)
    if (!bytes) continue
    const destination = resolve(snapshotDir, file)
    if (!isInside(snapshotDir, destination)) throw new Error(`snapshot path escapes root: ${file}`)
    await ensureDirectoryWithin(snapshotDir, dirname(destination), true)
    try {
      const existing = await lstat(destination)
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`unsafe existing snapshot path: ${file}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await writeFile(destination, bytes, { mode: 0o600 })
    hashes[file] = createHash('sha256').update(bytes).digest('hex')
  }
  return hashes
}

function normalizePatchPaths(text, before, current, file) {
  const target = `a/${file}`
  const destination = `b/${file}`
  const strip = value => String(value).replace(/^[/\\]+/u, '')
  const beforeToken = strip(before)
  const currentToken = strip(current)
  let normalized = String(text)
  if (before === devNull) {
    normalized = normalized.replaceAll(`a/${currentToken}`, target).replaceAll(`b/${currentToken}`, destination)
  } else if (current === devNull) {
    normalized = normalized.replaceAll(`a/${beforeToken}`, target).replaceAll(`b/${beforeToken}`, destination)
  } else {
    normalized = normalized.replaceAll(`a/${beforeToken}`, target).replaceAll(`b/${currentToken}`, destination)
  }
  return normalized
}

function parseNulPaths(value) {
  return String(value).split('\0').filter(Boolean).sort()
}

function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function changedFilesBetween(baseline, after) {
  return [...new Set([...Object.keys(baseline?.fileHashes ?? {}), ...Object.keys(after?.fileHashes ?? {})])]
    .filter(file => baseline?.fileHashes?.[file] !== after?.fileHashes?.[file])
    .sort()
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = new Error('evidence collection cancelled')
  error.name = 'AbortError'
  throw error
}

function compactSnapshot(snapshot) {
  return {
    commit: snapshot?.commit ?? null,
    status: snapshot?.status ?? '',
    diffStat: snapshot?.diffStat ?? '',
    dirty: Boolean(snapshot?.dirty),
    files: snapshot?.files ?? [],
    fileHashes: snapshot?.fileHashes ?? {},
  }
}

function formatExecutorReport(result, baseline, after, delta) {
  const output = result?.output ?? result?.text ?? ''
  const stopReason = result?.stopReason ?? 'unknown'
  const changedFiles = [...new Set([...Object.keys(baseline?.fileHashes ?? {}), ...Object.keys(after?.fileHashes ?? {})])]
    .filter(file => baseline?.fileHashes?.[file] !== after?.fileHashes?.[file]).length
  return [
    '# Executor Report',
    '',
    `- stopReason: ${stopReason}`,
    `- baselineCommit: ${baseline?.commit ?? 'unknown'}`,
    `- afterCommit: ${after?.commit ?? 'unknown'}`,
    `- baselineDirty: ${baseline?.dirty ?? 'unknown'}`,
    `- changedFilesFromBaseline: ${changedFiles}`,
    `- runDeltaBytes: ${Buffer.byteLength(delta ?? '', 'utf8')}`,
    '',
    '## Executor output',
    '',
    String(output).trim() || '(no executor output)',
    '',
  ].join('\n')
}
