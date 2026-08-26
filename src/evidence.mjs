import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function createLocalCommandRunner({ env = process.env } = {}) {
  return async function runCommand({ command, args = [], cwd, timeoutMs = 300_000, signal, extraEnv } = {}) {
    if (typeof command !== 'string' || command.length === 0) throw new Error('command is required')
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('args must be strings')
    const started = performance.now()
    const childEnv = { ...env, ...(extraEnv ?? {}) }
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], signal })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (exitCode, signalName) => {
        clearTimeout(timer)
        resolvePromise({
          command,
          args,
          cwd,
          exitCode,
          signal: signalName,
          stdout,
          stderr,
          durationMs: Math.round(performance.now() - started),
          timedOut: exitCode === null && signalName === 'SIGTERM',
          ok: exitCode === 0,
        })
      })
    })
  }
}

async function git(runCommand, repoRoot, args) {
  const result = await runCommand({ command: 'git', args, cwd: repoRoot })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

export async function captureGitSnapshot({ repoRoot, runCommand, snapshotRoot, snapshotName = 'snapshot' }) {
  const [commit, status, diff, diffStat, fileList] = await Promise.all([
    git(runCommand, repoRoot, ['rev-parse', 'HEAD']),
    git(runCommand, repoRoot, ['status', '--short', '--branch']),
    git(runCommand, repoRoot, ['diff', '--binary']),
    git(runCommand, repoRoot, ['diff', '--stat']),
    git(runCommand, repoRoot, ['ls-files', '-co', '--exclude-standard', '-z']),
  ])
  const files = parseNulPaths(fileList)
  const snapshotDir = snapshotRoot ? join(resolve(snapshotRoot), snapshotName) : undefined
  const fileHashes = snapshotDir ? await copyAndHashFiles(repoRoot, files, snapshotDir) : {}
  return {
    commit: commit.trim(),
    status,
    diff,
    diffStat,
    dirty: status.split('\n').some(line => /^[MADRCU?]{1,2}\s/.test(line)),
    files,
    fileHashes,
    snapshotDir,
    snapshotRoot: snapshotRoot ? resolve(snapshotRoot) : undefined,
  }
}

export async function diffSnapshots({ baseline, after, runCommand }) {
  if (!baseline?.snapshotDir || !after?.snapshotDir) return after?.diff ?? ''
  const paths = [...new Set([...Object.keys(baseline.fileHashes ?? {}), ...Object.keys(after.fileHashes ?? {})])]
    .filter(file => baseline.fileHashes?.[file] !== after.fileHashes?.[file])
    .sort()
  const chunks = []
  for (const file of paths) {
    const before = baseline.fileHashes?.[file] ? join(baseline.snapshotDir, file) : '/dev/null'
    const current = after.fileHashes?.[file] ? join(after.snapshotDir, file) : '/dev/null'
    const result = await runCommand({
      command: 'git',
      args: ['diff', '--no-index', '--binary', '--src-prefix=a/', '--dst-prefix=b/', before, current],
      cwd: baseline.snapshotDir,
    })
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`git diff --no-index failed for ${file}: ${result.stderr.trim()}`)
    if (result.stdout) chunks.push(normalizePatchPaths(result.stdout, before, current, file))
  }
  return chunks.join('')
}

export function createEvidenceCollector({ store, runCommand = createLocalCommandRunner(), testCommand = ['npm', ['run', 'verify:quick']] } = {}) {
  if (!store) throw new Error('artifact store is required')
  return {
    runCommand,
    async collect({ runId, round = 0, repoRoot, executorReport, baseline, signal, testCommand: requestedTestCommand }) {
      const after = await captureGitSnapshot({
        repoRoot,
        runCommand,
        snapshotRoot: baseline?.snapshotRoot,
        snapshotName: `after-round-${round}`,
      })
      const delta = await diffSnapshots({ baseline, after, runCommand })
      const [command, args] = requestedTestCommand ?? testCommand
      const test = await runCommand({ command, args, cwd: repoRoot, signal })
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
        source: 'test-runner',
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
        artifacts: [report, diff, testResult, baselineArtifact, afterArtifact],
        reviewArtifacts: [report, diff, testResult],
      }
    },
  }
}

async function copyAndHashFiles(repoRoot, files, snapshotDir) {
  const root = resolve(repoRoot)
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 })
  const hashes = {}
  for (const file of files) {
    if (isAbsolute(file) || file === '..' || file.startsWith(`..${sep}`) || file.includes('\0')) throw new Error(`unsafe repository path: ${file}`)
    const source = resolve(root, file)
    if (!isInside(root, source)) throw new Error(`repository path escapes root: ${file}`)
    let info
    try { info = await lstat(source) } catch { continue }
    if (!info.isFile() || info.isSymbolicLink()) continue
    const destination = join(snapshotDir, file)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(source, destination)
    const bytes = await readFile(source)
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
  if (before === '/dev/null') {
    normalized = normalized.replaceAll(`a/${currentToken}`, target).replaceAll(`b/${currentToken}`, destination)
  } else if (current === '/dev/null') {
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
