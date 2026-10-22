const EXECUTOR_PROVIDER = 'openai-codex'
const EXECUTOR_MODEL = 'gpt-6-luna'

export async function* streamCodex(ctx, options = {}) {
  if (!ctx?.llm?.stream) throw new Error('DSH LLM stream service is required')
  yield* ctx.llm.stream({
    ...options,
    provider: options.provider ?? EXECUTOR_PROVIDER,
    model: options.model ?? EXECUTOR_MODEL,
  })
}

export function createDshCodexExecutor({ ctx, provider = EXECUTOR_PROVIDER, model = EXECUTOR_MODEL, permissionPreset = 'workspace-write', sessionIdFactory, messageFactory } = {}) {
  if (!ctx?.agents) throw new Error('DSH Agent service is required')
  return {
    provider,
    model,
    async execute({ runId, cwd, task, signal, onProgress }) {
      if (typeof task !== 'string' || task.trim() === '') throw new Error('executor task must be non-empty')
      if (signal?.aborted) throw new Error('executor request was aborted before start')
      let makeSessionId = sessionIdFactory
      let makeMessage = messageFactory
      if (!makeSessionId || !makeMessage) {
        const [{ SessionId }, { createUserMessage }] = await Promise.all([
          import('@deepseek-ai/dsh-session'),
          import('@deepseek-ai/dsh-llm'),
        ])
        makeSessionId ??= SessionId
        makeMessage ??= createUserMessage
      }
      const sessionId = makeSessionId(`dev-loop-${runId}`)
      const agentPresets = ctx.agentPresets ?? ctx.get?.('agentPresets')
      if (!agentPresets?.mount) throw new Error('DSH Agent preset service is required for Executor')
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: { provider, model },
        setup: async agentCtx => {
          await agentPresets.mount(agentCtx)
        },
      })
      const agent = handle.agent
      let cancelled = false
      const onAbort = () => {
        if (cancelled) return
        cancelled = true
        agent.cancel({ kind: 'user' })
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      let disposeSessionEvents
      try {
        if (ctx.permissionPresets?.set) {
          ctx.permissionPresets.set(agent.session, permissionPreset)
        } else {
          throw new Error('DSH permission preset service is required for Executor')
        }
        if (cancelled) throw abortExecutorError()
        const firstSeq = agent.session.seq
        const events = []
        disposeSessionEvents = ctx.on('session/event', (session, event) => {
          if (session === agent.session && event.seq >= firstSeq) events.push(event)
        })
        onProgress?.({ status: 'started', runId })
        agent.followup(makeMessage({
          content: [{ type: 'text', text: task }],
          source: { kind: 'user' },
        }))
        await agent.whenIdle()
        if (signal?.aborted || cancelled) throw abortExecutorError()
        disposeSessionEvents()
        disposeSessionEvents = undefined
        onProgress?.({ status: 'completed', runId })
        return {
          runId,
          provider,
          model,
          output: lastAssistantText(events),
          stopReason: lastTurnReason(events),
          events,
        }
      } finally {
        disposeSessionEvents?.()
        signal?.removeEventListener('abort', onAbort)
        await handle.dispose()
      }
    },
  }
}

function abortExecutorError() {
  const error = new Error('executor run was aborted')
  error.name = 'AbortError'
  error.code = 'CANCELLED'
  return error
}

function lastAssistantText(events) {
  const messages = events.filter(event => event.type === 'assistant/message')
  const message = messages.at(-1)?.data?.message
  return message?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
}

function lastTurnReason(events) {
  return events.findLast(event => event.type === 'turn/end')?.data?.reason ?? { kind: 'unknown' }
}

export const DSH_EXECUTOR_DEFAULTS = Object.freeze({
  provider: EXECUTOR_PROVIDER,
  model: EXECUTOR_MODEL,
  permissionPreset: 'workspace-write',
})
