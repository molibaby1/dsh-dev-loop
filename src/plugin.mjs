import { createDshDevLoopController } from './host.mjs'
import { createDshCodexExecutor } from './dsh-executor.mjs'
import { createDevLoopCommand } from './command.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dev-loop'

/** Services accessed while mounting and handling the command. */
export const inject = ['agents', 'agentPresets', 'commands', 'permissionPresets']

/**
 * DSH composition entry. The Controller remains independent, while this small
 * host adapter exposes the installed subscription route inside a DSH context.
 */
export function apply(ctx, config = {}) {
  const effectiveConfig = {
    ...config,
    provider: config.provider ?? 'openai-codex',
    model: config.model ?? 'gpt-6-luna',
    permissionPreset: config.permissionPreset ?? 'danger-full-access',
    autoApprove: config.autoApprove ?? false,
    bridgeBaseUrl: config.bridgeBaseUrl ?? process.env.DSH_BRIDGE_URL ?? 'http://127.0.0.1:7688',
    bridgeToken: config.bridgeToken ?? process.env.DSH_BRIDGE_TOKEN ?? '',
    bridgeTokenFile: config.bridgeTokenFile ?? process.env.DSH_BRIDGE_TOKEN_FILE,
    artifactRoot: config.artifactRoot ?? process.env.DSH_DEV_LOOP_ARTIFACT_ROOT,
    projectRoot: config.projectRoot ?? process.env.DSH_DEV_LOOP_PROJECT_ROOT,
  }
  const executor = createDshCodexExecutor({ ...effectiveConfig, ctx })
  ctx.provide('dshDevLoopExecutor', executor)
  ctx.provide('dshDevLoopController', {
    create: controllerConfig => createDshDevLoopController({ ctx, config: { ...effectiveConfig, ...controllerConfig } }),
  })
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register(createDevLoopCommand({ ctx, config: effectiveConfig }))
  })
}
