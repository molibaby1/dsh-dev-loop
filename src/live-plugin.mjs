/** Cordis plugin name used by loader diagnostics. */
export const name = 'dev-loop-live'

/** Services accessed while mounting and handling the command. */
export const inject = ['agents', 'agentPresets', 'commands', 'permissionPresets']

/**
 * Hot-loadable Web-profile entry. Keep the module graph dependency-free at boot;
 * the installed package is imported only when a human invokes the command.
 */
export function apply(ctx, config = {}) {
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'dev-loop',
      description: '输入一句需求，先生成方案，确认后再修改和验证',
      recordInput: true,
      input: { hint: '例如：修复登录页提交后没有反应的问题', images: false },
      handler: async invocation => {
        try {
          const modulePath = config.modulePath ?? 'dsh-dev-loop'
          const module = await import(modulePath)
          return await module.executeDevLoopCommand({ ctx, config, invocation })
        } catch (error) {
          return {
            kind: 'error',
            text: `开发流程无法启动\n任务尚未执行。\n建议：检查插件安装和 Web profile 配置。\n\n技术详情：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    })
    commandCtx.commands.register({
      name: 'dev-loop-m2',
      description: '接收固定标题的 Planner 文本，单独审批后执行，并提交绑定证据的 Reviewer 回执',
      recordInput: true,
      input: { hint: '粘贴固定标题方案，或输入：批准当前方案、查看当前状态、取消当前任务；复审时粘贴 Reviewer 回执文本' },
      handler: async invocation => {
        try {
          const modulePath = config.modulePath ?? 'dsh-dev-loop'
          const module = await import(modulePath)
          return await module.executeDevLoopM2Command({ ctx, config, invocation })
        } catch (error) {
          return {
            kind: 'error',
            text: `M2 自然语言交接入口无法启动\n任务尚未执行。\n建议：检查插件安装和 Web profile 配置。\n\n技术详情：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    })
  })
}
