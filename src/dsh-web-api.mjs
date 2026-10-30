import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { encodeM2ExternalSubmitInput, readM2ExternalRequestFile } from './m2-request.mjs'

const DEFAULT_WEB_HOST = '127.0.0.1'
const DEFAULT_WEB_PORT = 3080

/** Submit one request through the running Web Host's existing Remote command API. */
export async function submitM2RequestToWeb({ profile, projectRoot, sessionId, requestFile, tokenFile, host = DEFAULT_WEB_HOST, port = DEFAULT_WEB_PORT, fetchImpl = globalThis.fetch } = {}) {
  if (profile !== 'web') throw new Error('M2 submit currently supports only the DSH web profile')
  if (typeof fetchImpl !== 'function') throw new Error('a Fetch implementation is required')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('sessionId must be a non-empty DSH Session id')
  const baseUrl = resolveWebProfileUrl(host, port)
  const canonicalProjectRoot = await canonicalDirectory(projectRoot)
  const { request, sha256 } = await readM2ExternalRequestFile(requestFile)
  if (typeof tokenFile !== 'string' || !isAbsolute(tokenFile) || tokenFile.includes('\0')) {
    throw new Error('token-file must be an absolute path')
  }
  const tokenFileStat = await lstat(tokenFile)
  if (!tokenFileStat.isFile() || (tokenFileStat.mode & 0o077) !== 0 || (tokenFileStat.mode & 0o400) === 0
    || (typeof process.getuid === 'function' && tokenFileStat.uid !== process.getuid())
    || tokenFileStat.size > 4096) {
    throw new Error('token-file must have owner-only permissions and be a regular file of at most 4096 bytes')
  }
  const canonicalTokenFile = await realpath(tokenFile)
  const tokenPathFromProject = relative(canonicalProjectRoot, canonicalTokenFile)
  if (tokenPathFromProject === '' || (tokenPathFromProject !== '..'
    && !tokenPathFromProject.startsWith(`..${sep}`) && !isAbsolute(tokenPathFromProject))) {
    throw new Error('token-file must be stored outside project-root')
  }
  const startupToken = (await readFile(canonicalTokenFile, 'utf8')).trim()
  if (startupToken === '' || /\s/u.test(startupToken)) throw new Error('token-file must contain only the current DSH Web startup token')

  const connectUrl = new URL('/connect', baseUrl)
  connectUrl.searchParams.set('token', startupToken)
  connectUrl.searchParams.set('interactions', 'none')
  let connectResponse
  try {
    connectResponse = await fetchImpl(connectUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error('DSH Web Host connection failed during startup-token authentication')
  }
  if (connectResponse.status === 401) {
    throw new Error('DSH Web Host rejected the startup token; it may have expired or the Host may have restarted. Refresh token-file from the current dsh web startup URL.')
  }
  if (connectResponse.status !== 302 || connectResponse.headers.get('location') !== './api/remote.mux') {
    throw new Error(`DSH Web Host startup-token exchange failed with HTTP ${connectResponse.status}`)
  }
  const setCookies = typeof connectResponse.headers.getSetCookie === 'function'
    ? connectResponse.headers.getSetCookie()
    : [connectResponse.headers.get('set-cookie')].filter(Boolean)
  const apiCookie = setCookies.length === 1 ? setCookies[0].split(';', 1)[0] : ''
  if (!/^[^=;,\s]+=[^;,\s]+$/u.test(apiCookie)) {
    throw new Error('DSH Web Host startup-token exchange returned no valid API cookie')
  }

  const call = createWebHostCaller(baseUrl, fetchImpl, apiCookie)

  const sessionResult = await call('session/list', { args: { _request: {} } })
  if (!Array.isArray(sessionResult?.items)) throw new Error('DSH Web Host returned an invalid session/list result')
  const matchingSessions = sessionResult.items.filter(session => session?.sessionId === sessionId)
  if (matchingSessions.length !== 1 || typeof matchingSessions[0].cwd !== 'string') {
    throw new Error(`DSH Session ${sessionId} is not attached to the requested project ${canonicalProjectRoot}`)
  }
  const sessionProjectRoot = await canonicalDirectory(matchingSessions[0].cwd, 'DSH Session cwd')
  if (sessionProjectRoot !== canonicalProjectRoot) {
    throw new Error(`DSH Session ${sessionId} cwd does not match requested project ${canonicalProjectRoot}`)
  }

  const agentId = sessionId
  const commands = await call('commands/list', { args: { agentId } })
  if (!Array.isArray(commands) || !commands.some(command => command?.name === 'dev-loop-m2')) {
    throw new Error(`DSH Session ${sessionId} has no registered /dev-loop-m2 command in the selected web profile`)
  }

  const commandInput = encodeM2ExternalSubmitInput({
    requestFile,
    requestFileSha256: sha256,
    projectRoot: canonicalProjectRoot,
  })
  const line = `/dev-loop-m2 提交外部方案文件 ${commandInput}`
  const execution = await call('commands/execute', { args: { agentId, line, submittedAttachments: [] } })
  if (execution === undefined || execution === null || typeof execution !== 'object'
    || typeof execution.commandId !== 'string' || execution.commandId.trim() === '') {
    throw new Error('DSH Web Host did not resolve /dev-loop-m2 in the selected Session')
  }
  if (execution.result?.kind !== 'success' || typeof execution.result.text !== 'string') {
    throw new Error(execution.result?.text ?? 'DSH Web Host returned an invalid /dev-loop-m2 result')
  }
  let receipt
  try {
    receipt = JSON.parse(execution.result.text)
  } catch (error) {
    throw new Error('DSH Web Host returned a non-JSON M2 submission receipt', { cause: error })
  }
  validateReceipt(receipt, { requestId: request.requestId, sessionId, projectRoot: canonicalProjectRoot })
  return receipt
}

function createWebHostCaller(baseUrl, fetchImpl, apiCookie) {
  return async (method, payload) => {
    const rpcId = randomUUID()
    const response = await fetchImpl(new URL(`/api/${method}`, baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: apiCookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    if (response.status === 401) {
      throw new Error(`DSH Web Host rejected the API cookie during ${method}; the Host may have restarted. Refresh token-file from the current dsh web startup URL.`)
    }
    if (!response.ok) throw new Error(`DSH Web Host ${method} failed with HTTP ${response.status}`)
    let envelope
    try {
      envelope = await response.json()
    } catch (error) {
      throw new Error(`DSH Web Host ${method} returned invalid JSON`, { cause: error })
    }
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || !envelope.result) {
      throw new Error(`DSH Web Host ${method} returned an invalid RPC envelope`)
    }
    if (envelope.result.ok !== true) {
      const detail = envelope.result.error
      throw new Error(`DSH Web Host ${method} rejected the request: ${detail?.code ?? 'unknown'}: ${detail?.message ?? 'no detail'}`)
    }
    return envelope.result.value
  }
}

function resolveWebProfileUrl(host, port) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('M2 submit connects only to a loopback DSH Web Host')
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('DSH Web Host port must be between 1 and 65535')
  const authorityHost = host === '::1' ? '[::1]' : host
  return new URL(`http://${authorityHost}:${port}`)
}

async function canonicalDirectory(path, label = 'project-root') {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new Error(`${label} must be an absolute path`)
  }
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be an existing directory`)
  return canonical
}

function validateReceipt(value, { requestId, sessionId, projectRoot }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || typeof value.runId !== 'string' || value.runId.trim() === ''
    || value.requestId !== requestId
    || value.sessionId !== sessionId
    || value.state !== 'WAITING_FOR_APPROVAL'
    || value.projectRoot !== projectRoot
    || typeof value.planSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.planSha256)
    || typeof value.deduplicated !== 'boolean') {
    throw new Error('DSH Web Host M2 receipt does not match the requested Run, Session, project, and plan')
  }
}
