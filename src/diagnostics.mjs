const DEFINITIONS = Object.freeze({
  INPUT_INVALID: ['输入内容无法识别', '请直接输入一句要完成的需求，例如：修复登录页提交后没有反应的问题。', false],
  PROJECT_ROOT_INVALID: ['项目目录不可用', '请检查项目目录是否存在、是否为绝对路径以及当前进程是否有权访问。', false],
  ARTIFACT_ROOT_INVALID: ['产物目录不可用', '请检查产物目录配置，并确保它位于项目目录之外。', false],
  GIT_UNAVAILABLE: ['Git 环境检查失败', '请确认目标目录是 Git 仓库，并且系统可以运行 git。', true],
  ZIP_UNAVAILABLE: ['项目打包工具不可用', '请安装 zip 命令后重新检查；代码尚未被修改。', true],
  BRIDGE_UNREACHABLE: ['规划服务无法连接', '请确认本地 Bridge 已启动，并检查地址、代理和端口配置。', true],
  BRIDGE_UNAUTHORIZED: ['规划服务认证失败', '请更新 Bridge 访问令牌后重试。', true],
  BRIDGE_TIMEOUT: ['规划服务等待超时', '请检查 Bridge 和 ChatGPT Web 状态，然后重试当前任务。', true],
  DSH_RUNTIME_MISSING: ['DSH 执行服务不完整', '请检查 Agent、Agent Preset 和权限预设插件是否已加载。', false],
  PERMISSION_PRESET_MISSING: ['执行权限配置不可用', '请检查 permission preset 插件和当前 profile 配置。', false],
  PLANNER_PROTOCOL_INVALID: ['规划结果格式不正确', '请重新生成方案；如果重复发生，请复制诊断信息进行排查。', true],
  REVIEWER_PROTOCOL_INVALID: ['审阅结果格式不正确', '可以保留当前代码修改，重新提交审阅。', true],
  EXECUTOR_FAILED: ['代码执行阶段失败', '请查看技术详情和当前代码差异，再决定是否继续。', false],
  TEST_FAILED: ['代码已修改，但验证未通过', '请查看失败测试和代码差异，修复后重新运行测试。', true],
  PLAN_CONTEXT_MISMATCH: ['方案上下文不匹配', '请确认方案中的分支和 commit 与 Host 配置的项目一致。', false],
  PROJECT_CONTEXT_CHANGED: ['方案后的项目上下文已变化', '请重新检查项目状态并提交一份基于当前分支和 commit 的新方案。', false],
  PROJECT_ROOT_CHANGED: ['项目目录与 Host 配置不一致', '请在可信 Host 配置的项目目录中创建新的交接方案。', false],
  ARTIFACT_ROOT_CHANGED: ['产物目录与 Host 配置不一致', '请使用配置该运行产物目录的 Host 恢复交接。', false],
  DSH_EXECUTION_INCOMPLETE: ['DSH Agent 未完成执行', '请查看 DSH 会话和已保留的项目差异，再决定是否重新授权。', false],
  DSH_TOOL_APPROVAL_FAILED: ['DSH 工具审批未成功', '请检查 DSH 原生审批记录；本次运行没有继续取证或自动重试。', false],
  EXECUTION_SCOPE_VIOLATION: ['DSH Agent 修改了批准范围外的文件', '请检查保留的 Git 差异；本次运行不会进入 Reviewer 完成阶段。', false],
  PROJECT_COMMIT_CHANGED: ['DSH Agent 改动了项目 commit', '请检查当前分支与 Git 历史；本次运行不会进入 Reviewer 完成阶段。', false],
  EVIDENCE_STALE: ['Reviewer 看到的项目状态已过期', '请检查当前项目差异；本次运行已停止，需基于当前状态重新交接。', false],
  CANCELLED: ['任务已取消', '当前修改会被保留，请在继续前查看代码差异。', false],
  RUN_NOT_FOUND: ['找不到这次运行', '请确认 runId 是否正确，并检查产物目录是否可访问。', false],
  RUN_NOT_APPROVABLE: ['这次运行不能批准', '只有处于“等待确认”状态且方案未被改动的运行才能批准。', false],
  RUN_ALREADY_TERMINAL: ['这次运行已经结束', '请查看原运行卡片；如需再次执行，请创建新的任务。', false],
  INTERNAL_ERROR: ['任务遇到内部错误', '请复制诊断编号和技术详情，以便进一步排查。', false],
})

export class DevLoopError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DevLoopError'
    this.code = code
    this.details = options.details ?? {}
    this.retryable = options.retryable
  }
}

export function abortError(message = 'operation cancelled') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'CANCELLED')
}

export function diagnosticFromError(error, context = {}) {
  const code = context.code ?? error?.code ?? inferCode(error, context.phase)
  const [title, suggestion, retryableDefault] = DEFINITIONS[code] ?? DEFINITIONS.INTERNAL_ERROR
  return Object.freeze({
    code: DEFINITIONS[code] ? code : 'INTERNAL_ERROR',
    phase: context.phase ?? 'UNKNOWN',
    severity: code === 'CANCELLED' ? 'info' : 'error',
    title,
    message: context.message ?? impactMessage(context.phase),
    suggestion,
    retryable: error?.retryable ?? retryableDefault,
    runId: context.runId,
    at: new Date().toISOString(),
    technical: sanitizeTechnical(error, context),
  })
}

export function diagnosticForInput(error) {
  return diagnosticFromError(error, {
    code: inferInputCode(error),
    phase: 'INPUT',
    message: '任务尚未启动，也没有修改项目文件。',
  })
}

function inferInputCode(error) {
  const message = String(error?.message ?? error)
  if (/projectRoot|project root/i.test(message)) return 'PROJECT_ROOT_INVALID'
  if (/artifactRoot|artifact root/i.test(message)) return 'ARTIFACT_ROOT_INVALID'
  return 'INPUT_INVALID'
}

function inferCode(error, phase) {
  const message = String(error?.message ?? error)
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'CANCELLED'
  if (/401|403|unauthori[sz]ed|forbidden|token/i.test(message) && /bridge|attachment|http/i.test(message)) return 'BRIDGE_UNAUTHORIZED'
  if (/Bridge request timed out|timed out.*Bridge/i.test(message)) return 'BRIDGE_TIMEOUT'
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|Bridge.*unreachable|network/i.test(message)) return 'BRIDGE_UNREACHABLE'
  if (/zip command unavailable|zip failed|\bzip\b.*not (?:found|available)/i.test(message)) return 'ZIP_UNAVAILABLE'
  if (/^git |Git environment|not a git repository/i.test(message)) return 'GIT_UNAVAILABLE'
  if (/permission preset/i.test(message)) return 'PERMISSION_PRESET_MISSING'
  if (/DSH .* service|Agent preset service/i.test(message)) return 'DSH_RUNTIME_MISSING'
  if (/Planner result|executorTask/i.test(message) || phase === 'PLAN_READY') return 'PLANNER_PROTOCOL_INVALID'
  if (/Reviewer result|review decision/i.test(message) || phase === 'REVIEWING') return 'REVIEWER_PROTOCOL_INVALID'
  if (phase === 'EXECUTING') return 'EXECUTOR_FAILED'
  return 'INTERNAL_ERROR'
}

function impactMessage(phase) {
  if (['IDLE', 'CHECKING_ENVIRONMENT', 'ANALYZING', 'PLAN_READY', 'WAITING_FOR_APPROVAL', 'INPUT'].includes(phase)) {
    return '尚未开始修改项目文件。'
  }
  return '任务没有完整结束，当前项目修改会被保留。'
}

function sanitizeTechnical(error, context) {
  const raw = String(error?.message ?? error ?? 'unknown error')
  const message = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/giu, '$1[REDACTED]')
    .slice(0, 4000)
  return {
    name: error?.name ?? 'Error',
    message,
    ...(context.operation ? { operation: context.operation } : {}),
    ...(error?.details && typeof error.details === 'object' ? { details: redactObject(error.details) } : {}),
  }
}

function redactObject(value) {
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|authorization|password/i.test(key)) output[key] = '[REDACTED]'
    else if (typeof item === 'string') output[key] = item.slice(0, 1000)
    else if (typeof item === 'number' || typeof item === 'boolean' || item === null) output[key] = item
  }
  return output
}
