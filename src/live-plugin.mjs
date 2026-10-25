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
      description: '领取 Host 暂存的 JSON 方案或复审结果，单独审批后执行',
      recordInput: true,
      input: { hint: '输入“领取待审方案”或“领取复审结果”读取 Host 暂存文件，或粘贴固定标题方案/Reviewer 结果；也可批准、查询或取消' },
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
