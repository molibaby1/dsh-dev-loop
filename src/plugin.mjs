import { createDshDevLoopController } from './host.mjs'
import { createDshCodexExecutor } from './dsh-executor.mjs'

/**
 * DSH composition entry. The Controller remains independent, while this small
 * host adapter exposes the installed subscription route inside a DSH context.
 */
export function apply(ctx, config = {}) {
  const executor = createDshCodexExecutor({
    ctx,
    provider: config.provider ?? 'openai-codex',
    model: config.model ?? 'gpt-5.6-luna',
    permissionPreset: config.permissionPreset ?? 'danger-full-access',
  })
  ctx.provide('dshDevLoopExecutor', executor)
  ctx.provide('dshDevLoopController', {
    create: controllerConfig => createDshDevLoopController({ ctx, config: controllerConfig }),
  })
}

export default { apply }
