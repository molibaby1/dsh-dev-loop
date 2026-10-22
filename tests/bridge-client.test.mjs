import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeClient } from '../src/bridge-client.mjs'

test('BridgeClient waits for visible attachment worker completion', async () => {
  const requests = []
  let polls = 0
  const client = new BridgeClient({
    baseUrl: 'http://bridge.test',
    token: 'token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (options.method === 'POST' && url.endsWith('/requests')) return response({ id: 'attachment-1', status: 'pending' })
      polls += 1
      return polls === 1 ? response({ id: 'attachment-1', status: 'running' }) : response({ id: 'attachment-1', status: 'completed', result: { decision: 'ACCEPTED' } })
    },
  })
  assert.equal(client.timeoutMs, 300_000)
  const result = await client.submit({
    runId: 'run-bridge',
    stage: 'reviewer-0',
    prompt: 'review',
    idempotencyKey: 'idem',
    artifacts: [{ id: 'a', runId: 'run-bridge', stage: 'reviewer-0', name: 'report.md', mime: 'text/markdown', bytes: 4, sha256: 'a'.repeat(64), source: 'test', localPath: '/tmp/report.md' }],
  })
  assert.deepEqual(result, { decision: 'ACCEPTED' })
  assert.equal(requests.length, 3)
  const posted = JSON.parse(requests[0].options.body)
  assert.equal(posted.artifacts[0].localPath, '/tmp/report.md')
})

test('BridgeClient cancels a timed-out attachment request', async () => {
  const calls = []
  const client = new BridgeClient({
    baseUrl: 'http://bridge.test',
    timeoutMs: 15,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (options.method === 'POST' && url.endsWith('/requests')) return response({ id: 'attachment-timeout', status: 'pending' })
      if (url.endsWith('/cancel')) return response({ id: 'attachment-timeout', status: 'cancelled' })
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    },
  })
  await assert.rejects(client.submit({
    runId: 'run-timeout', stage: 'planner', prompt: 'timeout', artifacts: [{ id: 'a', runId: 'run-timeout', stage: 'planner', name: 'a.md', mime: 'text/markdown', bytes: 1, sha256: 'b'.repeat(64), source: 'test', localPath: '/tmp/a.md' }],
  }), /timed out/)
  assert.ok(calls.some(call => call.url.endsWith('/cancel')))
})

test('BridgeClient distinguishes an upstream cancellation from timeout', async () => {
  const controller = new AbortController()
  const calls = []
  const client = new BridgeClient({
    baseUrl: 'http://bridge.test',
    timeoutMs: 5000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (options.method === 'POST' && url.endsWith('/requests')) return response({ id: 'attachment-cancel', status: 'pending' })
      if (url.endsWith('/cancel')) return response({ id: 'attachment-cancel', status: 'cancelled' })
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    },
  })
  const pending = client.submit({
    runId: 'run-cancel',
    stage: 'planner',
    prompt: 'cancel',
    signal: controller.signal,
    artifacts: [{ id: 'a', runId: 'run-cancel', stage: 'planner', name: 'a.md', mime: 'text/markdown', bytes: 1, sha256: 'c'.repeat(64), source: 'test', localPath: '/tmp/a.md' }],
  })
  setImmediate(() => controller.abort())
  await assert.rejects(pending, error => error.code === 'CANCELLED' && error.name === 'AbortError')
  const cancelCall = calls.find(call => call.url.endsWith('/cancel'))
  assert.ok(cancelCall)
  assert.match(JSON.parse(cancelCall.options.body).reason, /cancelled/)
})

test('BridgeClient probe distinguishes timeout and authorization failure', async () => {
  const timeoutClient = new BridgeClient({
    baseUrl: 'http://bridge.test',
    fetchImpl: async (_url, options) => await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
  })
  await assert.rejects(timeoutClient.probe({ timeoutMs: 5 }), error => error.code === 'BRIDGE_TIMEOUT')

  const unauthorizedClient = new BridgeClient({
    baseUrl: 'http://bridge.test',
    fetchImpl: async () => ({ status: 401 }),
  })
  await assert.rejects(unauthorizedClient.probe(), error => error.code === 'BRIDGE_UNAUTHORIZED')
})

function response(body) {
  return { ok: true, status: 200, async json() { return body } }
}
