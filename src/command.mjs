import { isAbsolute, relative, resolve } from 'node:path'
import { createDshDevLoopController } from './host.mjs'
import { assertConfiguredArtifactRoot } from './artifact-root.mjs'
import { diagnosticForInput, diagnosticFromError } from './diagnostics.mjs'
import { assertConfiguredProjectRoot } from './project-root.mjs'
import { summarizeResult } from './presentation.mjs'
import { DEV_LOOP_VERSION } from './version.mjs'

/** Parse friendly Chinese text or the legacy JSON `/dev-loop` input. */
export function parseDevLoopInput(rawInput, defaults = {}) {
  const text = String(rawInput ?? '').trim()
  if (!text) throw new Error('请输入一句要完成的需求，例如：修复登录页提交后没有反应的问题')
  let input
  if (text.startsWith('{')) {
    try {
      input = JSON.parse(text)
    } catch (error) {
      throw new Error(`/dev-loop input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('/dev-loop input must be a JSON object')
  } else {
    input = {
      problemPackage: {
        id: 'natural-language-task',
        summary: text,
        source: 'human',
      },
    }
  }
  const projectRoot = assertConfiguredProjectRoot(defaults.projectRoot, input.projectRoot)
  const artifactRoot = assertConfiguredArtifactRoot(defaults.artifactRoot, input.artifactRoot)
  const problemPackage = input.problemPackage ?? input.problem
  if (!problemPackage || typeof problemPackage !== 'object' || Array.isArray(problemPackage)) throw new Error('problemPackage must be a JSON object')
  const autoApprove = defaults.autoApprove === true
  if (resolve(projectRoot) === resolve(artifactRoot) || isInside(resolve(projectRoot), resolve(artifactRoot))) {
    throw new Error('artifactRoot must be outside projectRoot')
  }
  const testCommand = input.testCommand ?? defaults.testCommand
  if (testCommand !== undefined) validateTestCommand(testCommand)
  return {
    projectRoot,
    artifactRoot,
    problemPackage,
    approval: autoApprove || input.approve === true,
    approvalSource: autoApprove ? 'dev-loop-auto' : input.approve === true ? 'human' : 'waiting-for-human',
    executorTask: optionalString(input.executorTask, 'executorTask'),
    plannerPrompt: optionalString(input.plannerPrompt, 'plannerPrompt'),
    reviewerPrompt: optionalString(input.reviewerPrompt, 'reviewerPrompt'),
    testCommand,
    runId: optionalRunId(input.runId),
  }
}

const activeRuns = new Map()

/** Execute one command invocation while tracking active Controller runs for cancellation. */
export async function executeDevLoopCommand({ ctx, config = {}, invocation } = {}) {
  const { rawInput, signal } = invocation ?? {}
  const action = parseDevLoopControl(rawInput)
  try {
    if (action) return await executeControlAction({ ctx, config, invocation, action })
    const request = parseDevLoopInput(rawInput, config)
    const controller = await createDshDevLoopController({ ctx, config: { ...config, ...request, artifactRoot: config.artifactRoot } })
    const linked = linkAbortSignal(signal)
    let promise
    const onEvent = event => {
      if (event.kind === 'started') activeRuns.set(event.runId, { abort: linked.abort, promise })
      if (event.kind === 'finished') activeRuns.delete(event.runId)
    }
    promise = controller.run({ ...request, signal: linked.signal, onEvent })
    try {
      const result = await promise
      return {
        kind: resultKind(result),
        text: summarizeResult({ ...result, version: DEV_LOOP_VERSION }),
      }
    } finally {
      linked.dispose()
      for (const [runId, active] of activeRuns) if (active.promise === promise) activeRuns.delete(runId)
    }
  } catch (error) {
    const diagnostic = action
      ? diagnosticFromError(error, { phase: 'CONTROL', runId: action.runId })
      : diagnosticForInput(error)
    return {
      kind: 'error',
      text: `运行版本：后端 ${DEV_LOOP_VERSION}\n${diagnostic.title}\n${diagnostic.message}\n建议：${diagnostic.suggestion}\n诊断编号：${diagnostic.runId ?? '未生成'}\n\n技术详情：${diagnostic.technical.message}`,
    }
  }
}

async function executeControlAction({ ctx, config, invocation, action }) {
  const controller = await createDshDevLoopController({ ctx, config })
  if (action.kind === 'cancel') {
    const active = activeRuns.get(action.runId)
    if (active) {
      active.abort()
      const result = await active.promise
      return { kind: 'error', text: summarizeResult(result) }
    }
    const result = await controller.cancelRun({ runId: action.runId })
    return { kind: 'error', text: summarizeResult(result) }
  }
  const linked = linkAbortSignal(invocation.signal)
  let promise
  const onEvent = event => {
    if (event.kind === 'started') activeRuns.set(event.runId, { abort: linked.abort, promise })
    if (event.kind === 'finished') activeRuns.delete(event.runId)
  }
  promise = controller.resumeApproved({
    runId: action.runId,
    signal: linked.signal,
    approvalSource: 'human',
    onEvent,
  })
  activeRuns.set(action.runId, { abort: linked.abort, promise })
  try {
    const result = await promise
    return { kind: resultKind(result), text: summarizeResult(result) }
  } finally {
    linked.dispose()
    activeRuns.delete(action.runId)
  }
}

export function parseDevLoopControl(rawInput) {
  const text = String(rawInput ?? '').trim()
  const match = /^(approve|批准|cancel|取消)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/iu.exec(text)
  if (!match) return undefined
  return { kind: /approve|批准/iu.test(match[1]) ? 'approve' : 'cancel', runId: match[2] }
}

function resultKind(result) {
  return ['FAILED', 'CANCELLED', 'STOPPED'].includes(result?.state) ? 'error' : 'success'
}

function linkAbortSignal(source) {
  const controller = new AbortController()
  const abort = () => controller.abort(source?.reason)
  if (source?.aborted) abort()
  else source?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    abort,
    dispose: () => source?.removeEventListener('abort', abort),
  }
}

/** Build the DSH command definition; execution remains owned by the DSH host context. */
export function createDevLoopCommand({ ctx, config = {} } = {}) {
  if (!ctx) throw new Error('DSH context is required')
  return {
    name: 'dev-loop',
    description: '输入一句需求，先生成方案，确认后再修改和验证',
    recordInput: true,
    input: { hint: '例如：修复登录页提交后没有反应的问题', images: false },
    handler: invocation => executeDevLoopCommand({ ctx, config, invocation }),
  }
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

function optionalRunId(value) {
  const runId = optionalString(value, 'runId')
  if (runId === undefined) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('runId contains unsupported characters')
  return runId
}

function isInside(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}
