import { isAbsolute, relative, resolve } from 'node:path'
import { createDshDevLoopController } from './host.mjs'

/** Parse the explicit, JSON-only `/dev-loop` command input. */
export function parseDevLoopInput(rawInput, defaults = {}) {
  const text = String(rawInput ?? '').trim()
  if (!text) throw new Error('usage: /dev-loop {"projectRoot":"...","problemPackage":{...},"approve":true}')
  let input
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new Error(`/dev-loop input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('/dev-loop input must be a JSON object')
  const projectRoot = input.projectRoot ?? defaults.projectRoot
  const artifactRoot = input.artifactRoot ?? defaults.artifactRoot
  const problemPackage = input.problemPackage ?? input.problem
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') throw new Error('projectRoot is required')
  if (!isAbsolute(projectRoot)) throw new Error('projectRoot must be absolute')
  if (typeof artifactRoot !== 'string' || artifactRoot.trim() === '') throw new Error('artifactRoot is required')
  if (!isAbsolute(artifactRoot)) throw new Error('artifactRoot must be absolute')
  if (!problemPackage || typeof problemPackage !== 'object' || Array.isArray(problemPackage)) throw new Error('problemPackage must be a JSON object')
  if (input.approve !== true) throw new Error('explicit approval required: set "approve":true in the command JSON')
  if (resolve(projectRoot) === resolve(artifactRoot) || isInside(resolve(projectRoot), resolve(artifactRoot))) {
    throw new Error('artifactRoot must be outside projectRoot')
  }
  const testCommand = input.testCommand ?? defaults.testCommand
  if (testCommand !== undefined) validateTestCommand(testCommand)
  return {
    projectRoot,
    artifactRoot,
    problemPackage,
    approval: true,
    executorTask: optionalString(input.executorTask, 'executorTask'),
    plannerPrompt: optionalString(input.plannerPrompt, 'plannerPrompt'),
    reviewerPrompt: optionalString(input.reviewerPrompt, 'reviewerPrompt'),
    testCommand,
    runId: optionalString(input.runId, 'runId'),
  }
}

/** Build the DSH command definition; execution remains owned by the DSH host context. */
export function createDevLoopCommand({ ctx, config = {} } = {}) {
  if (!ctx) throw new Error('DSH context is required')
  return {
    name: 'dev-loop',
    description: 'run the bounded Planner/Executor/Reviewer development loop',
    input: { hint: '{"projectRoot":"...","problemPackage":{...},"approve":true}', images: false },
    handler: async ({ rawInput }) => {
      try {
        const request = parseDevLoopInput(rawInput, config)
        const controller = await createDshDevLoopController({ ctx, config: { ...config, ...request } })
        const result = await controller.run(request)
        return {
          kind: result.state === 'COMPLETE' ? 'success' : 'error',
          text: formatResult(result),
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function formatResult(result) {
  const names = Array.isArray(result.artifacts) ? result.artifacts.map(artifact => artifact.name).join(', ') : ''
  return `dsh-dev-loop ${result.state}; decision=${result.decision ?? 'none'}; runId=${result.runId}; artifacts=${names}`
}

function validateTestCommand(value) {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !Array.isArray(value[1]) || value[1].some(item => typeof item !== 'string')) {
    throw new Error('testCommand must be [command, string[]]')
  }
}

function optionalString(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value
}

function isInside(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}
