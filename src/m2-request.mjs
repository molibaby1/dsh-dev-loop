import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  normalizeExternalPlan,
  normalizeExternalRequestId,
  normalizeExternalSourceMetadata,
} from './controller.mjs'

export const MAX_M2_REQUEST_BYTES = 1024 * 1024

/** Read and validate one ChatGPT-produced request without following a file symlink. */
export async function readM2ExternalRequestFile(path, expectedSha256) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('M2 request file path must be an absolute path')
  }
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/iu.test(expectedSha256)) {
    throw new Error('M2 request file SHA-256 must be a hex digest')
  }
  const initialStat = await lstat(path)
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) {
    throw new Error('M2 request file must be a regular file, not a symlink')
  }
  if (initialStat.size > MAX_M2_REQUEST_BYTES) throw new Error(`M2 request file exceeds ${MAX_M2_REQUEST_BYTES} bytes`)

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  const handle = await open(path, flags)
  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) throw new Error('M2 request file must be a regular file')
    if (fileStat.size > MAX_M2_REQUEST_BYTES) throw new Error(`M2 request file exceeds ${MAX_M2_REQUEST_BYTES} bytes`)

    const chunks = []
    const chunk = Buffer.alloc(64 * 1024)
    let totalBytes = 0
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > MAX_M2_REQUEST_BYTES) throw new Error(`M2 request file exceeds ${MAX_M2_REQUEST_BYTES} bytes`)
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      position += bytesRead
    }

    const bytes = Buffer.concat(chunks, totalBytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase()) {
      throw new Error('M2 request file changed after it was inspected')
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { request: normalizeM2ExternalRequest(JSON.parse(text)), sha256 }
  } finally {
    await handle.close()
  }
}

/** Validate the request envelope and reuse the Controller's strict Plan validator. */
export function normalizeM2ExternalRequest(value) {
  const request = assertRecord(value, 'M2 request')
  rejectUnknownKeys(request, ['schema', 'requestId', 'source', 'plan'], 'M2 request')
  if (request.schema !== 1) throw new Error('M2 request schema must be 1')
  return {
    schema: 1,
    requestId: normalizeExternalRequestId(request.requestId),
    source: normalizeExternalSourceMetadata(request.source),
    plan: normalizeExternalPlan(request.plan),
  }
}

/** Encode only request-file metadata into the DSH slash-command line. */
export function encodeM2ExternalSubmitInput({ requestFile, requestFileSha256, projectRoot } = {}) {
  const payload = normalizeM2ExternalSubmitInput({ requestFile, requestFileSha256, projectRoot })
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode the bounded, shell-free metadata carried by `/dev-loop-m2`. */
export function decodeM2ExternalSubmitInput(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 16_384 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error('M2 external submit input must be a base64url value')
  }
  const bytes = Buffer.from(token, 'base64url')
  if (bytes.toString('base64url') !== token) throw new Error('M2 external submit input is not canonical base64url')
  let value
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error('M2 external submit input is invalid JSON', { cause: error })
  }
  return normalizeM2ExternalSubmitInput(value)
}

function normalizeM2ExternalSubmitInput(value) {
  const input = assertRecord(value, 'M2 external submit input')
  rejectUnknownKeys(input, ['requestFile', 'requestFileSha256', 'projectRoot'], 'M2 external submit input')
  if (typeof input.requestFile !== 'string' || !isAbsolute(input.requestFile) || input.requestFile.includes('\0')) {
    throw new Error('M2 request file path must be an absolute path')
  }
  if (typeof input.projectRoot !== 'string' || !isAbsolute(input.projectRoot) || input.projectRoot.includes('\0')) {
    throw new Error('M2 project root must be an absolute path')
  }
  if (typeof input.requestFileSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(input.requestFileSha256)) {
    throw new Error('M2 request file SHA-256 must be a hex digest')
  }
  return {
    requestFile: input.requestFile,
    requestFileSha256: input.requestFileSha256.toLowerCase(),
    projectRoot: input.projectRoot,
  }
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain JSON object`)
  return value
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unsupported field ${JSON.stringify(key)}`)
  }
}
