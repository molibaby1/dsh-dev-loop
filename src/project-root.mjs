import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Canonicalize a configured project path for trust comparisons. */
export function canonicalProjectRoot(value) {
  if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value)) {
    throw new Error('configured projectRoot must be an absolute path')
  }
  return canonicalOrResolved(value)
}

/** Require a request path to resolve to the Host-configured project directory. */
export function assertConfiguredProjectRoot(configured, requested) {
  const trusted = canonicalProjectRoot(configured)
  if (requested === undefined) return trusted
  if (typeof requested !== 'string' || requested.trim() === '' || !isAbsolute(requested)) {
    throw new Error('projectRoot must match configured projectRoot')
  }
  if (canonicalOrResolved(requested) !== trusted) {
    throw new Error('projectRoot must match configured projectRoot')
  }
  return trusted
}

function canonicalOrResolved(value) {
  const path = resolve(value)
  try {
    return realpathSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return path
    throw error
  }
}
