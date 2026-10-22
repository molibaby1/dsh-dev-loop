import { descriptorForBridge } from './artifacts.mjs'
import { DevLoopError, isAbortError } from './diagnostics.mjs'

function ensureLoopbackNoProxy(baseUrl) {
  let hostname
  try {
    hostname = new URL(baseUrl).hostname
  } catch {
    return
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return
  const entries = new Set(
    `${process.env.NO_PROXY || ''},${process.env.no_proxy || ''}`
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  )
  for (const host of ['127.0.0.1', 'localhost', '::1']) entries.add(host)
  const value = [...entries].join(',')
  process.env.NO_PROXY = value
  process.env.no_proxy = value
}

export class BridgeClient {
  constructor({ baseUrl = 'http://127.0.0.1:7688', token = '', fetchImpl = globalThis.fetch, timeoutMs = 300_000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
    this.baseUrl = String(baseUrl).replace(/\/$/u, '')
    ensureLoopbackNoProxy(this.baseUrl)
    this.token = token
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async submit({ runId, stage, prompt, artifacts, idempotencyKey, timeoutMs = this.timeoutMs, signal, onProgress } = {}) {
    if (!runId || !stage || !prompt) throw new Error('runId, stage, and prompt are required')
    if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('at least one attachment is required')
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    let requestId
    const headers = {
      authorization: this.token ? `Bearer ${this.token}` : '',
      'content-type': 'application/json',
      accept: 'application/json',
    }
    try {
      onProgress?.({ status: 'submitting', stage })
      const response = await this.fetchImpl(`${this.baseUrl}/internal/attachments/requests`, {
        method: 'POST',
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          runId,
          stage,
          prompt,
          idempotencyKey: idempotencyKey ?? `${runId}:${stage}:${artifacts.map(artifact => artifact.sha256).join(',')}`,
          artifacts: artifacts.map(descriptorForBridge),
        }),
      })
      const accepted = await response.json().catch(() => ({}))
      if (!response.ok) throw bridgeHttpError(response.status, accepted)
      if (!accepted.id) throw new DevLoopError('BRIDGE_UNREACHABLE', 'Bridge attachment response did not include a request id')
      requestId = accepted.id
      onProgress?.({ status: accepted.status ?? 'pending', stage, requestId })
      while (true) {
        const wait = await this.fetchImpl(`${this.baseUrl}/internal/attachments/requests/${encodeURIComponent(accepted.id)}/wait?waitSeconds=2`, {
          method: 'GET',
          signal: controller.signal,
          headers,
        })
        const body = await wait.json().catch(() => ({}))
        if (!wait.ok) throw bridgeHttpError(wait.status, body)
        onProgress?.({ status: body.status ?? 'waiting', stage, requestId })
        if (body.status === 'completed') return body.result ?? body
        if (body.status === 'failed') throw new DevLoopError('BRIDGE_UNREACHABLE', body.error || 'Bridge attachment request failed')
        if (body.status === 'cancelled') throw new DevLoopError('CANCELLED', body.error || 'Bridge attachment request cancelled')
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error, signal)) {
        if (requestId) await cancelBridgeRequest(this, requestId, headers, timedOut ? 'Controller attachment request timeout' : 'Controller attachment request cancelled')
        if (timedOut) throw new DevLoopError('BRIDGE_TIMEOUT', `Bridge request timed out after ${timeoutMs}ms`, { cause: error })
        const cancelled = new DevLoopError('CANCELLED', 'Bridge request cancelled', { cause: error })
        cancelled.name = 'AbortError'
        throw cancelled
      }
      if (error instanceof DevLoopError) throw error
      throw new DevLoopError('BRIDGE_UNREACHABLE', error instanceof Error ? error.message : String(error), { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async probe({ signal, timeoutMs = Math.min(this.timeoutMs, 3000) } = {}) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const response = await this.fetchImpl(this.baseUrl, { method: 'HEAD', signal: controller.signal })
      if (response.status === 401 || response.status === 403) throw new DevLoopError('BRIDGE_UNAUTHORIZED', `Bridge probe HTTP ${response.status}`)
      if (response.status >= 500) throw new DevLoopError('BRIDGE_UNREACHABLE', `Bridge probe HTTP ${response.status}`)
      return { ok: true, checked: true, status: response.status }
    } catch (error) {
      if (signal?.aborted) {
        const cancelled = new DevLoopError('CANCELLED', 'Bridge probe cancelled', { cause: error })
        cancelled.name = 'AbortError'
        throw cancelled
      }
      if (timedOut) throw new DevLoopError('BRIDGE_TIMEOUT', `Bridge probe timed out after ${timeoutMs}ms`, { cause: error })
      if (error instanceof DevLoopError) throw error
      throw new DevLoopError('BRIDGE_UNREACHABLE', `Bridge is unreachable at ${this.baseUrl}`, { cause: error })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function bridgeHttpError(status, body = {}) {
  const message = body.message || body.error || `Bridge HTTP ${status}`
  if (status === 401 || status === 403) return new DevLoopError('BRIDGE_UNAUTHORIZED', message, { details: { status } })
  return new DevLoopError('BRIDGE_UNREACHABLE', message, { details: { status } })
}

async function cancelBridgeRequest(client, requestId, headers, reason) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)
  try {
    await client.fetchImpl(`${client.baseUrl}/internal/attachments/requests/${encodeURIComponent(requestId)}/cancel`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({ reason }),
    })
  } catch {}
  finally {
    clearTimeout(timer)
  }
}

export function createFakeBridge(responses = {}) {
  const calls = []
  return {
    calls,
    async submit(request) {
      calls.push(request)
      const response = responses[request.stage]
      if (typeof response === 'function') return response(request)
      if (response === undefined) throw new Error(`no fake Bridge response for ${request.stage}`)
      return structuredClone(response)
    },
  }
}
