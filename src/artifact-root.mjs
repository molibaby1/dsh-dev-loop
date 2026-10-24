import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

/** Require a requested artifact path to resolve to the Host-configured directory. */
export function assertConfiguredArtifactRoot(configured, requested) {
  if (typeof configured !== 'string' || configured.trim() === '' || !isAbsolute(configured)) {
    throw new Error('configured artifactRoot must be an absolute path')
  }
  const trusted = canonicalPath(configured)
  if (requested === undefined) return configured
  if (typeof requested !== 'string' || requested.trim() === '' || !isAbsolute(requested)) {
    throw new Error('artifactRoot must be an absolute path')
  }
  if (canonicalPath(requested) !== trusted) throw new Error('artifactRoot must match configured artifactRoot')
  return configured
}

function canonicalPath(value) {
  const path = resolve(value)
  try {
    return realpathSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
  }

  let cursor = path
  const missingSegments = []
  while (true) {
    const parent = dirname(cursor)
    if (parent === cursor) return path
    missingSegments.unshift(basename(cursor))
    cursor = parent
    try {
      return resolve(realpathSync(cursor), ...missingSegments)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    }
  }
}
