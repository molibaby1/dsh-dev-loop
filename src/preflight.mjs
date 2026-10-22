import { access, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DevLoopError, isAbortError } from './diagnostics.mjs'

export function createPreflightChecker({ runCommand, bridge, runtime = {} } = {}) {
  if (typeof runCommand !== 'function') throw new Error('preflight runCommand is required')
  return async function preflight({ projectRoot, artifactRoot, signal } = {}) {
    throwIfAborted(signal)
    const project = await checkProjectRoot(projectRoot)
    const artifacts = await checkArtifactRoot(artifactRoot, project)
    const git = await checkCommand(runCommand, {
      command: 'git', args: ['rev-parse', '--show-toplevel'], cwd: project, signal,
      code: 'GIT_UNAVAILABLE', label: 'git',
    })
    const zip = await checkCommand(runCommand, {
      command: 'zip', args: ['-v'], cwd: project, signal,
      code: 'ZIP_UNAVAILABLE', label: 'zip',
    })
    checkRuntime(runtime)
    let bridgeStatus = { ok: true, checked: false }
    if (typeof bridge?.probe === 'function') bridgeStatus = await bridge.probe({ signal })
    return Object.freeze({
      ok: true,
      checkedAt: new Date().toISOString(),
      projectRoot: project,
      artifactRoot: artifacts,
      git: { ok: true, root: String(git.stdout ?? '').trim() || project },
      zip: { ok: true },
      bridge: bridgeStatus,
      runtime: {
        agents: runtime.agents !== false,
        agentPresets: runtime.agentPresets !== false,
        permissionPresets: runtime.permissionPresets !== false,
      },
    })
  }
}

async function checkProjectRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new DevLoopError('PROJECT_ROOT_INVALID', 'projectRoot must be an absolute path')
  }
  const root = resolve(value)
  try {
    const info = await lstat(root)
    if (!info.isDirectory()) throw new Error('not a directory')
    await access(root, constants.R_OK | constants.W_OK)
  } catch (error) {
    throw new DevLoopError('PROJECT_ROOT_INVALID', `projectRoot is not accessible: ${error.message}`, { cause: error })
  }
  return root
}

async function checkArtifactRoot(value, projectRoot) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new DevLoopError('ARTIFACT_ROOT_INVALID', 'artifactRoot must be an absolute path')
  }
  const root = resolve(value)
  if (isInside(projectRoot, root)) {
    throw new DevLoopError('ARTIFACT_ROOT_INVALID', 'artifactRoot must be outside projectRoot')
  }
  try {
    const info = await lstat(root)
    if (!info.isDirectory()) throw new Error('not a directory')
    await access(root, constants.R_OK | constants.W_OK)
  } catch (error) {
    throw new DevLoopError('ARTIFACT_ROOT_INVALID', `artifactRoot is not accessible: ${error.message}`, { cause: error })
  }
  return root
}

async function checkCommand(runCommand, options) {
  try {
    const result = await runCommand(options)
    if (result?.exitCode !== 0) {
      throw new Error(`${options.label} exited with ${result?.exitCode}: ${String(result?.stderr ?? '').trim()}`)
    }
    return result
  } catch (error) {
    if (isAbortError(error, options.signal)) throw error
    throw new DevLoopError(options.code, `${options.label} environment check failed: ${error.message}`, { cause: error })
  }
}

function checkRuntime(runtime) {
  const missing = Object.entries(runtime).filter(([, available]) => available === false).map(([name]) => name)
  if (missing.length > 0) {
    throw new DevLoopError('DSH_RUNTIME_MISSING', `DSH runtime services are missing: ${missing.join(', ')}`, { details: { missing: missing.join(', ') } })
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('preflight cancelled')
    error.name = 'AbortError'
    throw error
  }
}

function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
