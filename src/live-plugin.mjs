/**
 * Hot-loadable Web-profile entry. Keep the module graph dependency-free at boot;
 * the profile's already-installed package is imported only when a human invokes
 * the command, so config HMR can mount this entry without a process restart.
 */
export function apply(ctx, config = {}) {
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'dev-loop',
      description: 'run the bounded Planner/Executor/Reviewer development loop',
      input: { hint: '{"problemPackage":{...},"approve":true}', images: false },
      handler: async ({ rawInput }) => {
        try {
          const modulePath = config.modulePath ?? 'dsh-dev-loop'
          const module = await import(modulePath)
          const request = module.parseDevLoopInput(rawInput, config)
          const controller = await module.createDshDevLoopController({ ctx, config: { ...config, ...request } })
          const result = await controller.run(request)
          return {
            kind: result.state === 'COMPLETE' ? 'success' : 'error',
            text: formatResult(result),
          }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  })
}

function formatResult(result) {
  const names = Array.isArray(result.artifacts) ? result.artifacts.map(artifact => artifact.name).join(', ') : ''
  return `dsh-dev-loop ${result.state}; decision=${result.decision ?? 'none'}; runId=${result.runId}; artifacts=${names}`
}

export default { apply }
