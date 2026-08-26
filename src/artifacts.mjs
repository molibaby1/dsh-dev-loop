import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, realpath, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  '.worktrees',
  '.tmp',
  '.omx',
  '.trae',
  '.superpowers',
  'agent_docs',
  '.wuxia_saves',
  '.vscode',
  '.idea',
  'node_modules',
  'dist',
  'coverage',
  'artifacts',
])

function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/') && !rel.startsWith('\\'))
}

async function canonicalExisting(pathValue, label) {
  try {
    return await realpath(pathValue)
  } catch (error) {
    throw new Error(`${label} is not accessible: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function assertRegularFile(pathValue, label) {
  const info = await lstat(pathValue)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
}

async function sha256File(pathValue) {
  const data = await readFile(pathValue)
  return createHash('sha256').update(data).digest('hex')
}

async function atomicWrite(pathValue, data) {
  await mkdir(dirname(pathValue), { recursive: true })
  const temp = `${pathValue}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temp, data, { mode: 0o600 })
  await rename(temp, pathValue)
}

function publicDescriptor(descriptor) {
  const { localPath: _localPath, ...publicValue } = descriptor
  return publicValue
}

export class ArtifactStore {
  constructor({ root, maxArtifactBytes = 10 * 1024 * 1024, maxZipBytes = 32 * 1024 * 1024 } = {}) {
    if (typeof root !== 'string' || root.trim() === '') throw new Error('artifact root is required')
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) throw new Error('maxArtifactBytes must be positive')
    if (!Number.isSafeInteger(maxZipBytes) || maxZipBytes < 1) throw new Error('maxZipBytes must be positive')
    this.configuredRoot = resolve(root)
    this.maxArtifactBytes = maxArtifactBytes
    this.maxZipBytes = maxZipBytes
    this.root = undefined
  }

  async init() {
    await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 })
    this.root = await canonicalExisting(this.configuredRoot, 'artifact root')
    return this
  }

  async runRoot(runId) {
    if (!this.root) await this.init()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('invalid runId')
    const pathValue = join(this.root, runId)
    if (!isInside(this.root, pathValue)) throw new Error('run root escapes artifact root')
    await mkdir(pathValue, { recursive: true, mode: 0o700 })
    const canonical = await canonicalExisting(pathValue, 'run artifact root')
    if (!isInside(this.root, canonical)) throw new Error('run root symlink escapes artifact root')
    return canonical
  }

  async writeBytes({ runId, stage, name, mime, bytes, source = 'controller' }) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('artifact bytes must be binary')
    const value = Buffer.from(bytes)
    const limit = mime === 'application/zip' || name.endsWith('.zip') ? this.maxZipBytes : this.maxArtifactBytes
    if (value.byteLength > limit) throw new Error(`artifact exceeds byte limit: ${name}`)
    const root = await this.runRoot(runId)
    const safeName = safeArtifactName(name)
    const localPath = join(root, safeName)
    await atomicWrite(localPath, value)
    return this.#descriptor({ runId, stage, name: safeName, mime, localPath, source, bytes: value.byteLength })
  }

  async writeText(options) {
    return this.writeBytes({ ...options, bytes: Buffer.from(String(options.text), 'utf8') })
  }

  async writeJson(options) {
    return this.writeText({ ...options, mime: options.mime ?? 'application/json', text: `${JSON.stringify(options.value, null, 2)}\n` })
  }

  async stageFile({ runId, stage, name, mime, sourcePath, source = 'controller' }) {
    const root = await this.runRoot(runId)
    const canonicalSource = await canonicalExisting(sourcePath, 'artifact source')
    await assertRegularFile(canonicalSource, 'artifact source')
    const sourceInfo = await stat(canonicalSource)
    const limit = mime === 'application/zip' || name.endsWith('.zip') ? this.maxZipBytes : this.maxArtifactBytes
    if (sourceInfo.size > limit) throw new Error(`artifact exceeds byte limit: ${name}`)
    const destination = join(root, safeArtifactName(name))
    if (!isInside(root, destination)) throw new Error('artifact destination escapes run root')
    const bytes = await readFile(canonicalSource)
    await atomicWrite(destination, bytes)
    return this.#descriptor({ runId, stage, name: safeArtifactName(name), mime, localPath: destination, source, bytes: bytes.byteLength })
  }

  async manifest({ runId, stage = 'manifest', artifacts, source = 'controller' }) {
    return this.writeJson({
      runId,
      stage,
      name: stage === 'manifest' ? 'run-manifest.json' : `${stage}.manifest.json`,
      source,
      value: {
        runId,
        stage,
        artifacts: artifacts.map(publicDescriptor),
      },
    })
  }

  async cleanup(runId) {
    if (!this.root) return
    const pathValue = join(this.root, runId)
    if (!isInside(this.root, pathValue)) throw new Error('cleanup path escapes artifact root')
    await rm(pathValue, { recursive: true, force: true })
  }

  #descriptor({ runId, stage, name, mime, localPath, source, bytes }) {
    const descriptor = {
      id: `${runId}:${stage}:${name}`,
      runId,
      stage,
      name,
      mime,
      bytes,
      sha256: undefined,
      source,
      localPath,
    }
    return Object.freeze({
      ...descriptor,
      verify: async () => {
        const actual = await sha256File(localPath)
        if (actual !== descriptor.sha256) throw new Error(`artifact hash changed: ${name}`)
        return true
      },
    })
  }
}

export async function finalizeArtifact(descriptor) {
  const hash = await sha256File(descriptor.localPath)
  const value = Object.freeze({
    id: descriptor.id,
    runId: descriptor.runId,
    stage: descriptor.stage,
    name: descriptor.name,
    mime: descriptor.mime,
    bytes: descriptor.bytes,
    sha256: hash,
    source: descriptor.source,
    localPath: descriptor.localPath,
    verify: async () => {
      const actual = await sha256File(descriptor.localPath)
      if (actual !== hash) throw new Error(`artifact hash changed: ${descriptor.name}`)
      return true
    },
  })
  return value
}

export function exposeArtifact(descriptor) {
  return publicDescriptor(descriptor)
}

export function safeArtifactName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 160) throw new Error('invalid artifact name')
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('\0')) throw new Error('artifact name must be a single safe filename')
  return name
}

export async function listProjectFiles(projectRoot, { excludedDirs = DEFAULT_EXCLUDED_DIRS } = {}) {
  const root = await canonicalExisting(projectRoot, 'project root')
  const files = []
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const name = entry.name
      const relativeName = prefix ? `${prefix}/${name}` : name
      if (name === '.DS_Store' || name === 'project.zip') continue
      if (entry.isDirectory()) {
        if (excludedDirs.has(name) || relativeName === 'public/reports') continue
        await visit(join(directory, name), relativeName)
        continue
      }
      if (entry.isSymbolicLink()) throw new Error(`project package refuses symbolic link: ${relativeName}`)
      if (!entry.isFile()) continue
      if (/^\.env(?:\..+)?$/.test(name) && !name.endsWith('.example')) continue
      if (/\r|\n/.test(relativeName)) throw new Error(`project filename contains a line break: ${relativeName}`)
      files.push(relativeName)
    }
  }
  await visit(root)
  return files
}

export async function createProjectZip(store, { runId, projectRoot, stage = 'planner', source = 'wuxia-life', round } = {}) {
  const root = await canonicalExisting(projectRoot, 'project root')
  const files = await listProjectFiles(root)
  if (files.length === 0) throw new Error('project package contains no files')
  const runRoot = await store.runRoot(runId)
  const suffix = stage === 'planner' ? 'project.zip' : `project-latest${round === undefined ? '' : `-round-${round}`}.zip`
  const output = join(runRoot, `.zip-work-${suffix}`)
  await zipFiles(root, output, files)
  const descriptor = await store.stageFile({ runId, stage, name: suffix, mime: 'application/zip', sourcePath: output, source })
  await rm(output, { force: true })
  return { artifact: await finalizeArtifact(descriptor), files }
}

function zipFiles(cwd, output, files) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('zip', ['-q', '-X', '-@', output], {
      cwd,
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => reject(new Error(`zip command unavailable: ${error.message}`)))
    child.once('close', async code => {
      if (code !== 0) return reject(new Error(`zip failed (${code}): ${stderr.trim()}`))
      try {
        const info = await stat(output)
        if (info.size === 0) throw new Error('zip produced an empty archive')
        resolvePromise()
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(`${files.join('\n')}\n`)
  })
}

export function descriptorForBridge(descriptor) {
  return Object.freeze({
    id: descriptor.id,
    runId: descriptor.runId,
    stage: descriptor.stage,
    name: descriptor.name,
    mime: descriptor.mime,
    bytes: descriptor.bytes,
    sha256: descriptor.sha256,
    source: descriptor.source,
    localPath: descriptor.localPath,
  })
}
