import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshCodexExecutor, streamCodex } from '../src/dsh-executor.mjs'

test('streamCodex pins the installed provider and model route', async () => {
  const seen = []
  const ctx = { llm: { async *stream(options) { seen.push(options); yield { type: 'text', text: 'ok' } } } }
  const chunks = []
  for await (const chunk of streamCodex(ctx, { messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  assert.equal(chunks[0].text, 'ok')
  assert.equal(seen[0].provider, 'openai-codex')
  assert.equal(seen[0].model, 'gpt-5.6-luna')
})

test('DSH Codex executor selects installed route and danger permission', async () => {
  const calls = []
  const events = [
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'EXECUTOR_DONE' }] } } },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const agent = {
    session: { seq: 0, events },
    followup(message) { calls.push(['followup', message]) },
    async whenIdle() {},
    cancel() {},
  }
  const handle = { agent, async dispose() { calls.push(['dispose']) } }
  const ctx = {
    agents: {
      async create(options) {
        calls.push(['create', options])
        return handle
      },
    },
    permissionPresets: {
      set(session, preset) { calls.push(['permission', session, preset]) },
    },
  }
  const executor = createDshCodexExecutor({
    ctx,
    sessionIdFactory: value => value,
    messageFactory: value => value,
  })
  const result = await executor.execute({ runId: 'run-executor', cwd: '/repo', task: 'make the change' })
  assert.equal(result.output, 'EXECUTOR_DONE')
  assert.equal(result.provider, 'openai-codex')
  assert.equal(result.model, 'gpt-5.6-luna')
  assert.equal(calls[0][1].agentOptions.provider, 'openai-codex')
  assert.equal(calls[0][1].agentOptions.model, 'gpt-5.6-luna')
  assert.equal(calls[0][1].meta.cwd, '/repo')
  assert.equal(calls[1][2], 'danger-full-access')
  assert.equal(calls.at(-1)[0], 'dispose')
})
