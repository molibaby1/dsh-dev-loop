/** Cordis plugin name used by loader diagnostics. */
export const name = 'dev-loop-live-hotfix'

/** Services accessed while mounting and handling the command. */
export const inject = ['agents', 'agentPresets', 'commands', 'permissionPresets']

/** Hot-reloadable profile entry with a fresh module graph per hotfix version. */
export function apply(ctx, config = {}) {
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'dev-loop',
      description: '输入需求，先生成方案，确认后再修改和验证',
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
  })
}
