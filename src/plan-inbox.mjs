import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

const INBOX_NAME = '.m2-inbox'
const MAX_INPUT_BYTES = 1024 * 1024

/** Create or validate the fixed M2 input inbox beneath the trusted artifact root. */
export async function ensureM2Inbox(artifactRoot) {
  const { root, inbox } = await resolveM2Inbox(artifactRoot)
  try {
    await mkdir(inbox, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  await assertInboxDirectory(root, inbox, 'M2 input')
  return inbox
}

/** Report whether the one fixed, complete-plan filename is ready to claim. */
export async function hasStagedM2Plan(artifactRoot) {
  return hasStagedM2Input(artifactRoot, { readyName: 'plan.json', label: 'M2 plan' })
}

/** Atomically claim and read the one completed plan file; claimed input stays as evidence. */
export async function claimStagedM2Plan(artifactRoot) {
  return claimStagedM2Input(artifactRoot, {
    readyName: 'plan.json',
    partialName: 'plan.partial.json',
    label: 'M2 plan',
    claimedName: () => `claimed-${randomUUID()}.json`,
    missingMessage: (ready, partialName) => `没有待领取方案；请将完整 JSON 写入 ${join(dirname(ready), partialName)} 后再移动为 ${ready}`,
    invalidMessage: '已领取方案无效',
    resultKey: 'plan',
  })
}

/** Report whether the one fixed, complete-review filename is ready to claim. */
export async function hasStagedM2Review(artifactRoot) {
  return hasStagedM2Input(artifactRoot, { readyName: 'review.json', label: 'M2 review' })
}

/** Atomically claim and read one completed Reviewer result; claimed input stays as evidence. */
export async function claimStagedM2Review(artifactRoot) {
  return claimStagedM2Input(artifactRoot, {
    readyName: 'review.json',
    partialName: 'review.partial.json',
    label: 'M2 review',
    claimedName: () => `claimed-review-${randomUUID()}.json`,
    missingMessage: (ready, partialName) => `没有待领取复审结果；请将完整 JSON 写入 ${join(dirname(ready), partialName)} 后再移动为 ${ready}`,
    invalidMessage: '已领取复审结果无效',
    resultKey: 'review',
  })
}

async function resolveM2Inbox(artifactRoot) {
  if (typeof artifactRoot !== 'string' || !isAbsolute(artifactRoot)) {
    throw new Error('trusted artifactRoot must be an absolute path')
  }
  const root = await realpath(artifactRoot)
  return { root, inbox: join(root, INBOX_NAME) }
}

async function hasStagedM2Input(artifactRoot, { readyName, label }) {
  const { root, inbox } = await resolveM2Inbox(artifactRoot)
  await assertInboxDirectory(root, inbox, label)
  const ready = join(inbox, readyName)
  let info
  try {
    info = await lstat(ready)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`staged ${label} must be a regular file: ${ready}`)
  }
  return true
}

async function claimStagedM2Input(artifactRoot, {
  readyName,
  partialName,
  label,
  claimedName,
  missingMessage,
  invalidMessage,
  resultKey,
}) {
  const { root, inbox } = await resolveM2Inbox(artifactRoot)
  await assertInboxDirectory(root, inbox, label)
  const ready = join(inbox, readyName)
  let readyInfo
  try {
    readyInfo = await lstat(ready)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(missingMessage(ready, partialName))
    throw error
  }
  if (readyInfo.isSymbolicLink() || !readyInfo.isFile()) {
    throw new Error(`staged ${label} must be a regular file: ${ready}`)
  }

  const claimed = join(inbox, claimedName())
  try {
    await rename(ready, claimed)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${missingMessage(ready, partialName)}；输入可能已被另一个 DSH 调用领取`, { cause: error })
    throw error
  }

  try {
    await assertInboxDirectory(root, inbox, label)
    const value = await readStableJson(claimed, label)
    return { [resultKey]: value, sourcePath: claimed }
  } catch (error) {
    throw new Error(`${invalidMessage}，输入保留于 ${claimed}：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

async function assertInboxDirectory(root, inbox, label) {
  const info = await lstat(inbox)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} inbox must be a regular directory: ${inbox}`)
  const canonical = await realpath(inbox)
  const rel = relative(root, canonical)
  if (canonical !== inbox || (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)))) {
    throw new Error(`${label} inbox escapes the trusted artifact root: ${inbox}`)
  }
}

async function readStableJson(path, label) {
  const pathInfo = await lstat(path)
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error(`claimed ${label} must be a regular file`)
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`claimed ${label} must be a regular file`)
    if (before.size > BigInt(MAX_INPUT_BYTES)) throw new Error(`staged ${label} exceeds ${MAX_INPUT_BYTES} bytes`)
    const openedPath = await lstat(path)
    if (openedPath.isSymbolicLink() || !sameFile(openedPath, before)) throw new Error(`claimed ${label} changed while opening`)

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
      throw new Error(`staged ${label} changed or was incomplete while reading`)
    }
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
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
