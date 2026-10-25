import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const INBOX_NAME = '.m2-inbox'
const READY_NAME = 'plan.json'
const MAX_PLAN_BYTES = 1024 * 1024

/** Create or validate the fixed M2 plan inbox beneath the trusted artifact root. */
export async function ensureM2PlanInbox(artifactRoot) {
  if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)) {
    throw new Error('trusted artifactRoot must be an absolute path')
  }
  const root = await realpath(artifactRoot)
  const inbox = join(root, INBOX_NAME)
  try {
    await mkdir(inbox, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  await assertInboxDirectory(root, inbox)
  return inbox
}

/** Report whether the one fixed, complete-plan filename is ready to claim. */
export async function hasStagedM2Plan(artifactRoot) {
  const root = await realpath(artifactRoot)
  const inbox = join(root, INBOX_NAME)
  await assertInboxDirectory(root, inbox)
  const ready = join(inbox, READY_NAME)
  let info
  try {
    info = await lstat(ready)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`staged M2 plan must be a regular file: ${ready}`)
  }
  return true
}

/** Atomically claim and read the one completed plan file; claimed input stays as evidence. */
export async function claimStagedM2Plan(artifactRoot) {
  const root = await realpath(artifactRoot)
  const inbox = join(root, INBOX_NAME)
  await assertInboxDirectory(root, inbox)
  const ready = join(inbox, READY_NAME)
  let readyInfo
  try {
    readyInfo = await lstat(ready)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`没有待领取方案；请将完整 JSON 写入 ${join(inbox, 'plan.partial.json')} 后再移动为 ${ready}`)
    throw error
  }
  if (readyInfo.isSymbolicLink() || !readyInfo.isFile()) {
    throw new Error(`staged M2 plan must be a regular file: ${ready}`)
  }

  const claimed = join(inbox, `claimed-${randomUUID()}.json`)
  try {
    await rename(ready, claimed)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`没有待领取方案；输入可能已被另一个 DSH 调用领取：${ready}`, { cause: error })
    throw error
  }

  try {
    await assertInboxDirectory(root, inbox)
    const plan = await readStablePlan(claimed)
    return { plan, sourcePath: claimed }
  } catch (error) {
    throw new Error(`已领取方案无效，输入保留于 ${claimed}：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

async function assertInboxDirectory(root, inbox) {
  const info = await lstat(inbox)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`M2 plan inbox must be a regular directory: ${inbox}`)
  const canonical = await realpath(inbox)
  const rel = relative(root, canonical)
  if (canonical !== inbox || (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)))) {
    throw new Error(`M2 plan inbox escapes the trusted artifact root: ${inbox}`)
  }
}

async function readStablePlan(path) {
  const pathInfo = await lstat(path)
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error('claimed M2 plan must be a regular file')
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('claimed M2 plan must be a regular file')
    if (before.size > BigInt(MAX_PLAN_BYTES)) throw new Error(`staged M2 plan exceeds ${MAX_PLAN_BYTES} bytes`)
    const openedPath = await lstat(path)
    if (openedPath.isSymbolicLink() || !sameFile(openedPath, before)) throw new Error('claimed M2 plan changed while opening')

    const expectedBytes = Number(before.size)
    const bytes = Buffer.alloc(expectedBytes + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(before, after) || bytesRead !== expectedBytes) {
      throw new Error('staged M2 plan changed or was incomplete while reading')
    }
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    return value
  } finally {
    await handle.close()
  }
}

function sameFile(pathInfo, handleInfo) {
  return BigInt(pathInfo.dev) === handleInfo.dev && BigInt(pathInfo.ino) === handleInfo.ino
}

function sameSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}
