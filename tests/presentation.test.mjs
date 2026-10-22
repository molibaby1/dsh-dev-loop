import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeResult } from '../src/presentation.mjs'

test('summary explains approval gate and runtime fingerprint', () => {
  const text = summarizeResult({
    state: 'WAITING_FOR_APPROVAL',
    runId: 'run-plan',
    fingerprint: {
      backend: { buildId: 'backend-test' },
      client: { buildId: 'client-test' },
    },
  })
  assert.match(text, /等待确认/)
  assert.match(text, /后端 backend-test · 客户端 client-test/)
  assert.match(text, /\/dev-loop approve run-plan/)
})

test('summary identifies missing fingerprint as an old runtime', () => {
  assert.match(summarizeResult({ state: 'FAILED', runId: 'run-old' }), /未知（旧服务器或旧事件）/)
})
