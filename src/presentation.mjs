import { DEV_LOOP_CLIENT_VERSION, DEV_LOOP_VERSION } from './version.mjs'

export const DEV_LOOP_FINGERPRINT = Object.freeze({
  schema: 1,
  backend: { id: `dsh-dev-loop@${DEV_LOOP_VERSION}`, buildId: DEV_LOOP_VERSION },
  client: { id: `dsh-dev-loop-ui@${DEV_LOOP_CLIENT_VERSION}`, buildId: DEV_LOOP_CLIENT_VERSION },
})

export const DEV_LOOP_EVENTS = Object.freeze({
  started: 'dev-loop/run-started',
  progress: 'dev-loop/progress',
  diagnostic: 'dev-loop/diagnostic',
  finished: 'dev-loop/run-finished',
})

export const STAGE_PRESENTATION = Object.freeze({
  IDLE: { label: '准备任务', detail: '等待开始。' },
  CHECKING_ENVIRONMENT: { label: '检查运行环境', detail: '检查项目、Git、打包工具和运行服务。' },
  ANALYZING: { label: '分析项目现状', detail: '记录代码基线并准备规划材料。' },
  PLAN_READY: { label: '方案已生成', detail: '规划结果已经生成。' },
  WAITING_FOR_APPROVAL: { label: '等待确认', detail: '尚未开始修改代码。' },
  EXECUTING: { label: '修改代码', detail: 'Executor 正在处理项目文件。' },
  COLLECTING_EVIDENCE: { label: '运行验证', detail: '正在收集代码差异和测试结果。' },
  REVIEWING: { label: '审阅结果', detail: 'Reviewer 正在检查修改和验证证据。' },
  COMPLETE: { label: '任务完成', detail: '修改和审阅已经完成。' },
  STOPPED: { label: '任务已停止', detail: '系统按照安全边界停止了运行。' },
  FAILED: { label: '任务失败', detail: '运行遇到无法自动处理的问题。' },
  CANCELLED: { label: '任务已取消', detail: '任务已按用户请求停止。' },
})

export const DECISION_PRESENTATION = Object.freeze({
  ACCEPTED: '审阅通过',
  NEEDS_FIX: '需要修复',
  NEEDS_REPLAN: '需要重新规划',
  DEFER: '等待进一步确认',
  ESCALATE: '需要人工处理',
})

export function presentStage(stage) {
  return STAGE_PRESENTATION[stage] ?? { label: '处理任务', detail: `内部阶段：${String(stage ?? 'unknown')}` }
}

export function presentDecision(decision) {
  if (!decision) return '尚无审阅结论'
  return DECISION_PRESENTATION[decision] ?? `未知结论（${String(decision)}）`
}

export function summarizeResult(result = {}) {
  const stage = presentStage(result.state)
  const summary = result.summary ?? {}
  const lines = [stage.label]
  lines.push(`运行版本：${formatFingerprint(result.fingerprint, result.version)}`)
  if (result.runId) lines.push(`诊断编号：${result.runId}`)
  if (result.state === 'WAITING_FOR_APPROVAL' && result.runId) lines.push(`方案已生成，尚未修改代码。输入：/dev-loop approve ${result.runId}`)
  if (result.state === 'CANCELLED') lines.push('当前修改会被保留，请先查看代码差异。')
  if (result.decision) lines.push(`审阅结论：${presentDecision(result.decision)}`)
  if (summary.test?.ok === true) lines.push('测试结果：通过')
  if (summary.test?.ok === false) lines.push(`测试结果：未通过${summary.test.exitCode === undefined ? '' : `（退出码 ${summary.test.exitCode}）`}`)
  if (Number.isSafeInteger(summary.changedFiles)) lines.push(`变更文件：${summary.changedFiles} 个`)
  if (result.diagnostic?.suggestion) lines.push(`建议：${result.diagnostic.suggestion}`)
  return lines.join('\n')
}

function formatFingerprint(fingerprint, version) {
  if (version) return `后端 ${version} · 客户端 ${DEV_LOOP_CLIENT_VERSION}`
  if (!fingerprint?.backend?.buildId) return '未知（旧服务器或旧事件）'
  return `后端 ${fingerprint.backend.buildId} · 客户端 ${fingerprint.client?.buildId ?? '未知'}`
}

export function publicProgressEvent(event = {}) {
  const presented = presentStage(event.stage)
  return {
    runId: event.runId,
    stage: event.stage,
    label: presented.label,
    detail: presented.detail,
    round: event.metadata?.round ?? event.round ?? 0,
    fixCount: event.metadata?.fixCount ?? event.fixCount ?? 0,
    replanCount: event.metadata?.replanCount ?? event.replanCount ?? 0,
    decision: event.metadata?.decision ?? event.decision ?? null,
    hasModifiedProject: hasModifiedProject(event.stage),
    at: event.at ?? new Date().toISOString(),
    fingerprint: event.fingerprint ?? DEV_LOOP_FINGERPRINT,
  }
}

export function hasModifiedProject(stage) {
  return ['EXECUTING', 'COLLECTING_EVIDENCE', 'REVIEWING', 'COMPLETE', 'STOPPED'].includes(stage)
}
