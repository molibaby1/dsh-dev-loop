import { access, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { checkZipAvailable } from './artifacts.mjs'
import { DevLoopError, isAbortError } from './diagnostics.mjs'

export function createPreflightChecker({ gitAdapter, checkZip = checkZipAvailable, bridge, runtime = {} } = {}) {
  if (typeof gitAdapter !== 'function') throw new Error('preflight fixed Git adapter is required')
  if (typeof checkZip !== 'function') throw new Error('preflight fixed ZIP check is required')
  return async function preflight({ projectRoot, artifactRoot, signal } = {}) {
    throwIfAborted(signal)
    const project = await checkProjectRoot(projectRoot)
    const artifacts = await checkArtifactRoot(artifactRoot, project)
    const git = await checkGit(gitAdapter, project, signal)
    const zip = await checkZip({ signal })
    if (zip?.exitCode !== 0 || zip?.timedOut || zip?.aborted) {
      throw new DevLoopError('ZIP_UNAVAILABLE', `zip environment check failed: ${zip?.timedOut ? 'timed out' : zip?.aborted ? 'cancelled' : zip?.stderr ?? `exit ${zip?.exitCode}`}`)
    }
    checkRuntime(runtime)
    let bridgeStatus = { ok: true, checked: false }
    if (typeof bridge?.probe === 'function') bridgeStatus = await bridge.probe({ signal })
    return Object.freeze({
      ok: true,
      checkedAt: new Date().toISOString(),
      projectRoot: project,
      artifactRoot: artifacts,
      git: { ok: true, root: String(git.stdout ?? '').trim() },
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

async function checkGit(gitAdapter, projectRoot, signal) {
  try {
    const result = await gitAdapter({ operation: 'root', repoRoot: projectRoot, signal })
    if (result?.exitCode !== 0 || result?.timedOut || result?.aborted || result?.outputLimitExceeded) throw new Error(`git exited with ${result?.exitCode}: ${String(result?.stderr ?? '').trim()}`)
    if (String(result.stdout ?? '').trim() !== projectRoot) throw new Error('git reported a different repository root')
    return result
  } catch (error) {
    if (isAbortError(error, signal)) throw error
    throw new DevLoopError('GIT_UNAVAILABLE', `git environment check failed: ${error.message}`, { cause: error })
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
