import { descriptorForBridge } from './artifacts.mjs'

export class BridgeClient {
  constructor({ baseUrl = 'http://127.0.0.1:7688', token = '', fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
    this.baseUrl = String(baseUrl).replace(/\/$/u, '')
    this.token = token
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async submit({ runId, stage, prompt, artifacts, idempotencyKey, timeoutMs = this.timeoutMs } = {}) {
    if (!runId || !stage || !prompt) throw new Error('runId, stage, and prompt are required')
    if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('at least one attachment is required')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let requestId
    const headers = {
      authorization: this.token ? `Bearer ${this.token}` : '',
      'content-type': 'application/json',
      accept: 'application/json',
    }
    try {
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
      if (!response.ok) throw new Error(accepted.message || accepted.error || `Bridge HTTP ${response.status}`)
      if (!accepted.id) throw new Error('Bridge attachment response did not include a request id')
      requestId = accepted.id
      while (true) {
        const wait = await this.fetchImpl(`${this.baseUrl}/internal/attachments/requests/${encodeURIComponent(accepted.id)}/wait?waitSeconds=2`, {
          method: 'GET',
          signal: controller.signal,
          headers,
        })
        const body = await wait.json().catch(() => ({}))
        if (!wait.ok) throw new Error(body.message || body.error || `Bridge wait HTTP ${wait.status}`)
        if (body.status === 'completed') return body.result ?? body
        if (body.status === 'failed' || body.status === 'cancelled') {
          throw new Error(body.error || `Bridge attachment request ${body.status}`)
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (requestId) await cancelBridgeRequest(this, requestId, headers)
        throw new Error(`Bridge request timed out after ${timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

async function cancelBridgeRequest(client, requestId, headers) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)
  try {
    await client.fetchImpl(`${client.baseUrl}/internal/attachments/requests/${encodeURIComponent(requestId)}/cancel`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({ reason: 'Controller attachment request timeout' }),
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
