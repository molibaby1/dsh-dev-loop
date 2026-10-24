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

const plannerHandoffFields = Object.freeze([
  '目标',
  '修改范围',
  '排除路径',
  '非目标',
  '验收条件',
  '执行要求',
  '上下文来源',
  'Planner 观察到的分支',
  'Planner 观察到的 commit',
  'DSH Agent 执行任务',
])

const reviewHandoffFields = Object.freeze([
  '审核回执',
  'Reviewer decision',
  '复审摘要',
  '发现的问题',
])

const reviewDecisions = new Set(['ACCEPTED', 'NEEDS_FIX', 'NEEDS_REPLAN', 'DEFER', 'ESCALATE'])

/** Parse one fixed-title Planner plan, Reviewer result, or exact standalone action. */
export function parseDevLoopM2Input(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (!text) throw new Error('请输入完整的 Planner 交接文本或一条独立操作命令')
  const actions = new Map([
    ['批准当前方案', { action: 'approve-current-plan' }],
    ['查看当前状态', { action: 'status-current-task' }],
    ['取消当前任务', { action: 'cancel-current-task' }],
  ])
  if (actions.has(text)) return actions.get(text)
  if (text.startsWith('{')) throw new Error('M2 入口只接受固定标题普通文本；不要提交 JSON')
  if (text === '提交复审结果') throw new Error('请在“提交复审结果”后粘贴 Reviewer 回执、decision、摘要和发现的问题')
  if (text.startsWith('提交复审结果\n') || text.startsWith('提交复审结果\r\n')) {
    return parseReviewerHandoff(text.slice('提交复审结果'.length).trim())
  }

  const firstField = readHeader(text.split(/\r?\n/u)[0])?.name
  if (firstField === '审核回执') return parseReviewerHandoff(text)
  return parsePlannerHandoff(text)
}

/** Execute one natural-language M2 handoff operation within the invoking DSH session. */
export async function executeDevLoopM2Command({ ctx, config = {}, invocation } = {}) {
  let action
  try {
    action = parseDevLoopM2Input(invocation?.rawInput)
    const sessionId = invocation?.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new Error('无法从可信 DSH 调用上下文读取 session ID；任务尚未提交或执行')
    }
    const controller = await createDshDevLoopController({
      ctx,
      config: {
        ...config,
        mode: 'manual-handoff',
        artifactRoot: config.artifactRoot,
        projectRoot: config.projectRoot,
      },
      sessionId,
    })
    const linked = linkAbortSignal(invocation.signal)
    let promise
    const trackedRunIds = new Set()
    const onEvent = event => {
      if (event.kind === 'started') {
        trackedRunIds.add(event.runId)
        activeRuns.set(event.runId, { abort: linked.abort, promise })
      }
      if (event.kind === 'finished') activeRuns.delete(event.runId)
    }
    try {
      if (action.action === 'submit-plan') {
        promise = controller.submitExternalPlan({ plan: action.plan, signal: linked.signal, onEvent })
      } else {
        const operation = {
          'approve-current-plan': 'approve',
          'status-current-task': 'status',
          'cancel-current-task': 'cancel',
          'submit-current-review': 'review',
        }[action.action]
        const current = await controller.findExternalRunForSession({ operation })
        if (action.action === 'approve-current-plan') {
          promise = controller.approveExternalPlan({
            runId: current.runId,
            planSha256: current.planSha256,
            signal: linked.signal,
            onEvent,
          })
        } else if (action.action === 'status-current-task') {
          promise = controller.getExternalRunStatus({ runId: current.runId })
        } else if (action.action === 'cancel-current-task') {
          const active = activeRuns.get(current.runId)
          if (active) {
            active.abort()
            promise = active.promise
          } else {
            promise = controller.cancelRun({ runId: current.runId })
          }
        } else {
          promise = controller.submitExternalReview({
            runId: current.runId,
            receipt: action.receipt,
            decision: action.decision,
            summary: action.summary,
            findings: action.findings,
          })
        }
      }
      const result = await promise
      return { kind: resultKind(result), text: summarizeM2Result(result) }
    } finally {
      linked.dispose()
      for (const runId of trackedRunIds) {
        if (activeRuns.get(runId)?.promise === promise) activeRuns.delete(runId)
      }
    }
  } catch (error) {
    const diagnostic = diagnosticForInput(error)
    return {
      kind: 'error',
      text: `M2 交接未完成\n${diagnostic.title}\n${diagnostic.message}\n建议：${diagnostic.suggestion}\n\n技术详情：${diagnostic.technical.message}`,
    }
  }
}

/** Build the separate M2 human-handoff command without changing the legacy `/dev-loop` route. */
export function createDevLoopM2Command({ ctx, config = {} } = {}) {
  if (!ctx) throw new Error('DSH context is required')
  return {
    name: 'dev-loop-m2',
    description: '提交固定标题方案，随后用独立命令批准、查询、取消或提交复审',
    recordInput: true,
    input: { hint: '粘贴 Planner 固定标题文本；或输入：批准当前方案 / 查看当前状态 / 取消当前任务 / 提交 Reviewer 回执文本' },
    handler: invocation => executeDevLoopM2Command({ ctx, config, invocation }),
  }
}

function parsePlannerHandoff(text) {
  const fields = parseTitledFields(text, plannerHandoffFields)
  const includedPaths = parseRepositoryPathList(fields.get('修改范围'), '修改范围')
  if (includedPaths.length === 0) throw new Error('修改范围必须至少列出一个仓库相对路径')
  const observedContext = {
    branch: readSingleLineField(fields, 'Planner 观察到的分支'),
    commit: readSingleLineField(fields, 'Planner 观察到的 commit'),
  }
  if (!/^[a-f0-9]{40,64}$/iu.test(observedContext.commit)) throw new Error('Planner 观察到的 commit 必须是 Git commit SHA')
  return {
    action: 'submit-plan',
    plan: {
      schema: 1,
      summary: readTextField(fields, '目标'),
      scope: {
        includedPaths,
        excludedPaths: parseRepositoryPathList(fields.get('排除路径'), '排除路径'),
        nonGoals: parseBulletList(fields.get('非目标'), '非目标', { allowNone: true }),
      },
      acceptanceCriteria: parseBulletList(fields.get('验收条件'), '验收条件'),
      executionRequirements: parseBulletList(fields.get('执行要求'), '执行要求'),
      contextSources: parseBulletList(fields.get('上下文来源'), '上下文来源'),
      observedContext,
      executorTask: readTextField(fields, 'DSH Agent 执行任务'),
    },
  }
}

function parseReviewerHandoff(text) {
  const fields = parseTitledFields(text, reviewHandoffFields)
  const receipt = readSingleLineField(fields, '审核回执')
  if (!/^[A-Za-z0-9_-]{22}$/u.test(receipt)) throw new Error('审核回执缺失或格式无效')
  const decision = readSingleLineField(fields, 'Reviewer decision')
  if (!reviewDecisions.has(decision)) throw new Error('Reviewer decision 必须是 ACCEPTED、NEEDS_FIX、NEEDS_REPLAN、DEFER 或 ESCALATE')
  return {
    action: 'submit-current-review',
    receipt,
    decision,
    summary: readTextField(fields, '复审摘要'),
    findings: parseBulletList(fields.get('发现的问题'), '发现的问题', { allowNone: true }),
  }
}

function parseTitledFields(text, requiredFields) {
  const values = new Map()
  let current
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^(?:[-*]\s+|\d+[.)]\s+)/u.test(line)) {
      if (!current) throw new Error('标题前不能出现未归属的列表内容')
      current.lines.push({ value: line.replace(/^(?:[-*]\s+|\d+[.)]\s+)/u, '').trim(), listItem: true })
      continue
    }
    const header = readHeader(line)
    if (header) {
      if (!requiredFields.includes(header.name)) throw new Error(`交接文本包含不支持的标题：${header.name}`)
      if (values.has(header.name)) throw new Error(`交接文本标题重复：${header.name}`)
      current = { name: header.name, lines: header.value === '' ? [] : [{ value: header.value, listItem: false }] }
      values.set(header.name, current)
      continue
    }
    if (!current) throw new Error('交接文本必须从固定标题开始')
    current.lines.push({ value: line, listItem: false })
  }
  const missing = requiredFields.filter(name => !values.has(name))
  if (missing.length > 0) throw new Error(`交接文本缺少必要标题：${missing.join('、')}`)
  for (const [name, field] of values) {
    if (field.lines.length === 0 || field.lines.every(line => line.value.trim() === '')) throw new Error(`${name}不能为空`)
  }
  return new Map([...values].map(([name, field]) => [name, field.lines]))
}

function readHeader(line) {
  const match = /^([^:：]+)[：:](.*)$/u.exec(line.trim())
  return match ? { name: match[1].trim(), value: match[2].trim() } : undefined
}

function readTextField(fields, name) {
  const value = fields.get(name).map(line => line.value).join('\n').trim()
  if (!value) throw new Error(`${name}不能为空`)
  return value
}

function readSingleLineField(fields, name) {
  const lines = fields.get(name)
  if (lines.length !== 1 || !lines[0].value.trim()) throw new Error(`${name}必须填写一行非空内容`)
  return lines[0].value.trim()
}

function parseBulletList(lines, name, { allowNone = false } = {}) {
  const values = lines.map(line => line.value.trim())
  if (allowNone && values.length === 1 && values[0] === '无') return []
  if (values.length === 0 || values.some(value => value === '')) throw new Error(`${name}不能为空`)
  if (lines.some(line => !line.listItem)) throw new Error(`${name}每项必须使用“- ”列出`)
  return values
}

function parseRepositoryPathList(lines, name) {
  const paths = parseBulletList(lines, name, { allowNone: true })
  return paths.map(value => {
    const path = value.replaceAll('\\', '/').replace(/\/+$/u, '')
    const segments = path.split('/')
    if (
      path === ''
      || path.startsWith('/')
      || /^[A-Za-z]:/u.test(path)
      || path.includes('\0')
      || (path !== '.' && segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    ) {
      throw new Error(`${name}包含非法路径：${value}`)
    }
    return path
  })
}

function summarizeM2Result(result = {}) {
  const lines = [`状态：${result.state ?? '未知'}`]
  if (result.state === 'WAITING_FOR_APPROVAL') lines.push('方案已保存，尚未调用 DSH Agent，也未修改项目文件。输入“批准当前方案”后才会执行。')
  if (result.state === 'REVIEWING') {
    lines.push('DSH 执行和取证已完成，等待 Reviewer 复审。')
    if (result.handoff?.reviewReceipt) lines.push(`审核回执：${result.handoff.reviewReceipt}`)
    if (result.handoff?.evidencePath) lines.push(`证据目录：${result.handoff.evidencePath}`)
    if (result.handoff?.evidenceManifestPath) lines.push(`证据清单：${result.handoff.evidenceManifestPath}`)
  }
  if (result.decision) lines.push(`Reviewer 结论：${result.decision}`)
  if (result.summary?.test?.ok === true) lines.push('测试结果：通过')
  if (result.summary?.test?.ok === false) lines.push('测试结果：未通过')
  if (Number.isSafeInteger(result.summary?.changedFiles)) lines.push(`变更文件：${result.summary.changedFiles} 个`)
  if (result.diagnostic?.message) lines.push(`诊断：${result.diagnostic.message}`)
  else if (result.state === 'CANCELLED') lines.push('任务已取消。')
  return lines.join('\n')
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
