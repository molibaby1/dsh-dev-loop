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
  assert.equal(seen[0].model, 'gpt-6-luna')
})

test('DSH Codex executor selects installed route and workspace-write permission', async () => {
  const calls = []
  const events = [
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STALE' }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'EXECUTOR_DONE' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const session = { seq: 2 }
  let onSessionEvent
  const agent = {
    session,
    followup(message) {
      calls.push(['followup', message])
      for (const event of events) onSessionEvent(session, event)
    },
    async whenIdle() {},
    cancel() {},
  }
  const handle = { agent, async dispose() { calls.push(['dispose']) } }
  let setupResult
  const ctx = {
    agents: {
      async create(options) {
        calls.push(['create', options])
        setupResult = await options.setup({})
        return handle
      },
    },
    agentPresets: {
      async mount(agentCtx) {
        calls.push(['agent-preset', agentCtx])
        return { id: 'default' }
      },
    },
    permissionPresets: {
      set(session, preset) { calls.push(['permission', session, preset]) },
    },
    on(name, callback) {
      assert.equal(name, 'session/event')
      onSessionEvent = callback
      return () => {
        onSessionEvent = undefined
        calls.push(['listener-dispose'])
      }
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
  assert.equal(result.model, 'gpt-6-luna')
  assert.equal(calls[0][1].agentOptions.provider, 'openai-codex')
  assert.equal(calls[0][1].agentOptions.model, 'gpt-6-luna')
  assert.equal(calls[0][1].meta.cwd, '/repo')
  assert.equal(calls[1][0], 'agent-preset')
  assert.equal(setupResult, undefined)
  assert.equal(calls[2][2], 'workspace-write')
  assert.deepEqual(result.events, events.slice(1))
  assert.ok(calls.some(call => call[0] === 'listener-dispose'))
  assert.equal(calls.at(-1)[0], 'dispose')
})

test('DSH Codex executor propagates Agent failures and disposes its event listener and handle', async () => {
  const calls = []
  const agent = {
    session: { seq: 0 },
    followup() {},
    async whenIdle() { throw new Error('agent failed') },
    cancel() {},
  }
  const executor = createDshCodexExecutor({
    ctx: {
      agents: { async create() { return { agent, async dispose() { calls.push('handle-dispose') } } } },
      agentPresets: { async mount() {} },
      permissionPresets: { set() {} },
      on(_name, _listener) { return () => calls.push('listener-dispose') },
    },
    sessionIdFactory: value => value,
    messageFactory: value => value,
  })

  await assert.rejects(executor.execute({ runId: 'run-error', cwd: '/repo', task: 'fail' }), /agent failed/)
  assert.deepEqual(calls, ['listener-dispose', 'handle-dispose'])
})
