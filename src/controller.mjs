import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assertDecision, assertPlainObject, RunStateMachine } from './contracts.mjs'
import { createProjectZip, exposeArtifact, finalizeArtifact } from './artifacts.mjs'
import { DevLoopError, diagnosticFromError, isAbortError } from './diagnostics.mjs'
import { captureGitSnapshot } from './evidence.mjs'
import { createPreflightChecker } from './preflight.mjs'
import { DEV_LOOP_FINGERPRINT, publicProgressEvent } from './presentation.mjs'

export class DevLoopController {
  constructor({ store, bridge, executor, evidenceCollector, preflight, maxFixes = 1, runIdFactory = () => `run-${randomUUID()}` } = {}) {
    if (!store || !bridge || !executor || !evidenceCollector) throw new Error('store, bridge, executor, and evidenceCollector are required')
    if (typeof evidenceCollector.runCommand !== 'function') throw new Error('evidenceCollector.runCommand is required')
    if (maxFixes !== 1) throw new Error('phase one requires exactly one automatic NEEDS_FIX budget')
    this.store = store
    this.bridge = bridge
    this.executor = executor
    this.evidenceCollector = evidenceCollector
    this.preflight = preflight ?? createPreflightChecker({ runCommand: evidenceCollector.runCommand, bridge })
    this.maxFixes = maxFixes
    this.runIdFactory = runIdFactory
  }

  async run({ runId: requestedRunId, projectRoot: requestedProjectRoot, artifactRoot: requestedArtifactRoot, problemPackage: requestedProblemPackage, approval = false, approvalSource = 'human', plannerPrompt: requestedPlannerPrompt, reviewerPrompt: requestedReviewerPrompt, executorTask: requestedExecutorTask, testCommand: requestedTestCommand, signal, onProgress, onEvent, resumeFromApproval = false } = {}) {
    const runId = requestedRunId ?? this.runIdFactory()
    let projectRoot = requestedProjectRoot
    let artifactRoot = requestedArtifactRoot
    let problemPackage = requestedProblemPackage
    let plannerPrompt = requestedPlannerPrompt
    let reviewerPrompt = requestedReviewerPrompt
    let executorTask = requestedExecutorTask
    let testCommand = requestedTestCommand
    let resumeData
    if (resumeFromApproval) {
      if (!requestedRunId) throw new Error('runId is required to resume a run')
      resumeData = await loadResumeData(this.store, requestedRunId)
      projectRoot ??= resumeData.request.projectRoot
      artifactRoot ??= resumeData.request.artifactRoot
      problemPackage ??= resumeData.request.problemPackage
      plannerPrompt ??= resumeData.request.plannerPrompt
      reviewerPrompt ??= resumeData.request.reviewerPrompt
      executorTask ??= resumeData.request.executorTask
      testCommand ??= resumeData.request.testCommand
    }
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) throw new Error('projectRoot is required')
    if (!problemPackage || typeof problemPackage !== 'object' || Array.isArray(problemPackage)) throw new Error('problemPackage is required')
    const machine = new RunStateMachine({ runId, maxFixes: this.maxFixes, initialSnapshot: resumeData?.state })
    let runRoot
    let snapshotRoot
    const artifacts = resumeData?.manifest?.artifacts?.map(artifact => ({ ...artifact })) ?? []
    let baseline
    let problem
    let plannerResult
    let approvalArtifact
    let review
    let evidenceSummary
    let preflightResult
    let executionTask
    let diagnostic
    const thisController = this
    if (resumeData) {
      problem = resumeData.manifest?.phases?.problem ?? null
      plannerResult = resumeData.plan
      approvalArtifact = resumeData.manifest?.phases?.approval ?? null
      preflightResult = resumeData.manifest?.phases?.preflight ?? null
      evidenceSummary = resumeData.manifest?.phases?.evidenceSummary ?? null
    }

    const notify = event => {
      const value = { runId, at: new Date().toISOString(), fingerprint: DEV_LOOP_FINGERPRINT, ...event }
      try { onEvent?.(value) } catch {}
      if (event.kind === 'progress') {
        try { onProgress?.(value) } catch {}
      }
    }
    const persistState = async () => {
      await this.store.writeJson({
        runId,
        stage: 'state',
        name: 'run-state.json',
        value: machine.snapshot(),
        source: 'controller-state',
      })
    }
    const transition = async (next, metadata = {}) => {
      machine.transition(next, metadata)
      await persistState()
      notify({ kind: 'progress', ...publicProgressEvent({ runId, stage: next, metadata: { fixCount: machine.fixCount, ...metadata } }) })
    }
    const applyDecision = async (decision, metadata = {}) => {
      machine.applyDecision(decision, metadata)
      await persistState()
      notify({ kind: 'progress', ...publicProgressEvent({ runId, stage: machine.state, metadata: { fixCount: machine.fixCount, ...metadata, decision } }) })
    }
    const record = async descriptor => {
      const finalized = descriptor.sha256 ? descriptor : await finalizeArtifact(descriptor)
      upsertArtifact(artifacts, finalized)
      return finalized
    }
    const addJson = async (stage, name, value, source = 'controller') => record(await this.store.writeJson({ runId, stage, name, value, source }))

    notify({ kind: 'started', projectRoot, artifactRoot: artifactRoot ?? this.store.root ?? this.store.configuredRoot })

    try {
      runRoot = await this.store.runRoot(runId)
      snapshotRoot = join(runRoot, '.snapshots')
      if (resumeData) baseline = hydrateBaseline(resumeData.baseline, snapshotRoot)
    } catch (error) {
      diagnostic = diagnosticFromError(error, {
        code: 'ARTIFACT_ROOT_INVALID',
        phase: 'IDLE',
        runId,
        message: '任务尚未启动，也没有修改项目文件。',
      })
      machine.transition('FAILED', { diagnosticCode: diagnostic.code, reason: diagnostic.technical.message })
      notify({ kind: 'diagnostic', diagnostic })
      const result = {
        runId,
        state: 'FAILED',
        decision: null,
        fixCount: 0,
        fingerprint: DEV_LOOP_FINGERPRINT,
        summary: { schema: 1, fingerprint: DEV_LOOP_FINGERPRINT, runId, state: 'FAILED', hasModifiedProject: false, diagnostic },
        diagnostic,
        artifacts: [],
        audit: machine.snapshot(),
      }
      notify({ kind: 'finished', state: result.state, decision: null, summary: result.summary, diagnostic })
      return result
    }

    try {
      throwIfAborted(signal)
      if (machine.state !== 'CHECKING_ENVIRONMENT') await transition('CHECKING_ENVIRONMENT')
      preflightResult = await this.preflight({
        runId,
        projectRoot,
        artifactRoot: artifactRoot ?? this.store.root ?? this.store.configuredRoot,
        signal,
        testCommand,
      })
      await addJson('preflight', resumeFromApproval ? 'preflight-resume.json' : 'preflight.json', preflightResult, 'preflight')

      if (resumeFromApproval) {
        throwIfAborted(signal)
        if (!baseline || !plannerResult) throw new Error('stored run is missing its baseline or plan')
        approvalArtifact = await addJson('approval', 'approval-approved.json', {
          runId,
          approved: true,
          approvedAt: new Date().toISOString(),
          source: approvalSource,
          planSha256: resumeData.planSha256,
          resumedFrom: 'WAITING_FOR_APPROVAL',
        }, approvalSource)
        await transition('EXECUTING', { resumedFrom: 'WAITING_FOR_APPROVAL' })
      } else {
        await transition('ANALYZING')
        baseline = await captureGitSnapshot({
          repoRoot: projectRoot,
          runCommand: this.evidenceCollector.runCommand,
          snapshotRoot,
          snapshotName: 'baseline',
          signal,
        })
        await addJson('analysis', 'baseline-snapshot.json', persistableBaseline(baseline), 'git-baseline')
        problem = await addJson('problem', 'problem-package.json', {
          ...problemPackage,
          runId,
          source: 'human',
          baseline: {
            commit: baseline.commit,
            dirty: baseline.dirty,
            status: baseline.status,
            diffSha256: sha256Text(baseline.diff),
          },
        }, 'human')
        await addJson('request', 'run-request.json', {
          schema: 1,
          fingerprint: DEV_LOOP_FINGERPRINT,
          runId,
          projectRoot,
          artifactRoot: artifactRoot ?? this.store.root ?? this.store.configuredRoot,
          problemPackage,
          plannerPrompt,
          reviewerPrompt,
          executorTask,
          testCommand,
        }, 'human')
        const plannerZip = await createProjectZip(this.store, { runId, projectRoot, stage: 'planner', source: 'project' })
        const plannerArtifact = await record(plannerZip.artifact)
        const planner = await this.bridge.submit({
          runId,
          stage: 'planner',
          prompt: plannerPrompt ?? defaultPlannerPrompt(problemPackage),
          artifacts: [plannerArtifact],
          idempotencyKey: `${runId}:planner:${plannerArtifact.sha256}`,
          signal,
          onProgress: status => notify({ kind: 'progress', ...publicProgressEvent({ runId, stage: machine.state, metadata: { bridge: status.status } }) }),
        })
        throwIfAborted(signal)
        plannerResult = normalizePlannerResult(planner, executorTask)
        await transition('PLAN_READY')
        const planArtifact = await addJson('plan', 'plan.json', plannerResult, 'planner')
        throwIfAborted(signal)
        if (!approval) await transition('WAITING_FOR_APPROVAL')
        approvalArtifact = await addJson('approval', 'approval.json', {
          runId,
          approved: false,
          approvedAt: null,
          source: 'controller-default-deny',
          planSha256: planArtifact.sha256,
        }, 'controller')
        if (!approval) return await finishAndNotify()
        throwIfAborted(signal)
        let task = executorTask ?? plannerResult.executorTask
        if (typeof task !== 'string' || task.trim() === '') throw new Error('Planner result must contain executorTask or caller must provide executorTask')
        await transition('EXECUTING')
        executionTask = task
      }

      let task = resumeFromApproval ? (executorTask ?? plannerResult.executorTask) : executionTask
      if (typeof task !== 'string' || task.trim() === '') throw new Error('Planner result must contain executorTask or caller must provide executorTask')
      let round = 0
      let replanCount = 0
      while (true) {
        if (machine.state !== 'EXECUTING') await transition('EXECUTING', { round, replanCount })
        const executorResult = await this.executor.execute({
          runId,
          cwd: projectRoot,
          task,
          signal,
          onProgress: status => notify({ kind: 'progress', ...publicProgressEvent({ runId, stage: machine.state, metadata: { round, executor: status.status } }) }),
        })
        await transition('COLLECTING_EVIDENCE', { round, replanCount })
        const evidence = await this.evidenceCollector.collect({
          runId,
          round,
          repoRoot: projectRoot,
          executorReport: executorResult,
          baseline,
          signal,
          testCommand,
        })
        evidenceSummary = evidence.summary ?? evidenceSummary
        const finalizedEvidence = new Map()
        for (const artifact of evidence.artifacts) finalizedEvidence.set(artifact, await record(artifact))
        const evidenceArtifacts = (evidence.reviewArtifacts ?? evidence.artifacts)
          .map(artifact => finalizedEvidence.get(artifact))
          .filter(Boolean)
        const latestZip = await createProjectZip(this.store, {
          runId,
          projectRoot,
          stage: `reviewer-${round}`,
          source: 'project',
          round,
        })
        const latestArtifact = await record(latestZip.artifact)
        await transition('REVIEWING', { round, replanCount })
        review = normalizeReviewResult(await this.bridge.submit({
          runId,
          stage: `reviewer-${round}`,
          prompt: reviewerPrompt ?? defaultReviewerPrompt(problemPackage),
          artifacts: [...evidenceArtifacts, latestArtifact],
          idempotencyKey: `${runId}:reviewer:${round}:${sha256Text([...evidenceArtifacts, latestArtifact].map(item => item.sha256).join(','))}`,
          signal,
          onProgress: status => notify({ kind: 'progress', ...publicProgressEvent({ runId, stage: machine.state, metadata: { round, bridge: status.status } }) }),
        }))
        const reviewArtifactName = round === 0 ? 'review.json' : `review-round-${round}.json`
        const reviewArtifact = await addJson(`review-${round}`, reviewArtifactName, review, 'reviewer')
        await applyDecision(review.decision, { round, replanCount, reviewSha256: reviewArtifact.sha256 })
        if (machine.state === 'ANALYZING') {
          if (replanCount >= 1) {
            await transition('STOPPED', { round, reason: 'automatic replan budget exhausted', replanCount })
            return await finishAndNotify()
          }
          replanCount += 1
          const nextRound = round + 1
          const replanned = await this.bridge.submit({
            runId,
            stage: `planner-${nextRound}`,
            prompt: replanPrompt(plannerPrompt ?? defaultPlannerPrompt(problemPackage), review),
            artifacts: [latestArtifact, reviewArtifact],
            idempotencyKey: `${runId}:planner:${nextRound}:${sha256Text(`${latestArtifact.sha256},${reviewArtifact.sha256}`)}`,
            signal,
          })
          plannerResult = normalizePlannerResult(replanned, review.nextTask ?? task)
          await transition('PLAN_READY', { round: nextRound, replanOf: round, replanCount })
          await addJson(`plan-${nextRound}`, `plan-round-${nextRound}.json`, plannerResult, 'planner')
          await transition('EXECUTING', { round: nextRound, replanOf: round, replanCount })
          round = nextRound
          task = plannerResult.executorTask
          continue
        }
        if (machine.state !== 'EXECUTING') return await finishAndNotify()
        round += 1
        task = review.nextTask ?? task
      }
    } catch (error) {
      const cancelled = isAbortError(error, signal)
      diagnostic = diagnosticFromError(error, {
        code: cancelled ? 'CANCELLED' : undefined,
        phase: machine.state,
        runId,
        message: hasEnteredExecution(machine) ? '任务没有完整结束，当前项目修改会被保留。' : '尚未开始修改项目文件。',
      })
      const terminal = cancelled ? 'CANCELLED' : 'FAILED'
      if (!['COMPLETE', 'STOPPED', 'FAILED', 'CANCELLED'].includes(machine.state)) {
        await transition(terminal, { diagnosticCode: diagnostic.code, reason: diagnostic.technical.message })
      }
      await addJson('diagnostic', 'diagnostic.json', diagnostic, 'controller-diagnostic')
      notify({ kind: 'diagnostic', diagnostic })
      return await finishAndNotify()
    }

    async function finishAndNotify() {
      const result = await thisController.finish({
        machine,
        artifacts,
        runId,
        baseline,
        problem,
        plan: plannerResult,
        approval: approvalArtifact,
        review,
        diagnostic,
        preflight: preflightResult,
        evidenceSummary,
      })
      notify({ kind: 'finished', state: result.state, decision: result.decision, summary: result.summary, diagnostic: result.diagnostic })
      return result
    }
  }

  async resumeApproved({ runId, signal, approvalSource = 'human', onProgress, onEvent } = {}) {
    return this.run({
      runId,
      approval: true,
      approvalSource,
      signal,
      onProgress,
      onEvent,
      resumeFromApproval: true,
    })
  }

  async cancelRun({ runId, reason = '用户请求取消' } = {}) {
    if (typeof runId !== 'string' || runId.trim() === '') throw new Error('runId is required')
    let state
    try {
      state = await this.store.readJson({ runId, name: 'run-state.json' })
    } catch (error) {
      throw new DevLoopError('RUN_NOT_FOUND', `run state is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    const manifest = await this.store.readJson({ runId, name: 'run-manifest.json' }).catch(() => ({ artifacts: [], phases: {} }))
    if (['COMPLETE', 'STOPPED', 'FAILED', 'CANCELLED'].includes(state.state)) {
      throw new DevLoopError('RUN_ALREADY_TERMINAL', `run is already terminal: ${state.state}`)
    }
    const machine = new RunStateMachine({ runId, maxFixes: this.maxFixes, initialSnapshot: state })
    machine.transition('CANCELLED', { reason, cancellationSource: 'human' })
    const diagnostic = diagnosticFromError(Object.assign(new Error(reason), { name: 'AbortError', code: 'CANCELLED' }), {
      code: 'CANCELLED',
      phase: state.state,
      runId,
      message: hasEnteredExecution(machine) ? '任务已取消，当前项目修改会被保留。' : '任务已取消，尚未修改项目文件。',
    })
    const artifacts = (manifest.artifacts ?? []).map(artifact => ({ ...artifact }))
    const diagnosticArtifact = await finalizeArtifact(await this.store.writeJson({
      runId,
      stage: 'diagnostic',
      name: 'diagnostic.json',
      value: diagnostic,
      source: 'controller-diagnostic',
    }))
    upsertArtifact(artifacts, diagnosticArtifact)
    return this.finish({
      machine,
      artifacts,
      runId,
      baseline: manifest.baseline ?? null,
      problem: manifest.phases?.problem ?? null,
      plan: manifest.phases?.plan ?? null,
      approval: manifest.phases?.approval ?? null,
      review: manifest.phases?.review ?? null,
      diagnostic,
      preflight: manifest.phases?.preflight ?? null,
      evidenceSummary: manifest.phases?.evidenceSummary ?? null,
    })
  }

  async finish({ machine, artifacts, runId, baseline, problem, plan, approval, review, diagnostic, preflight, evidenceSummary } = {}) {
    await this.store.writeJson({
      runId,
      stage: 'state',
      name: 'run-state.json',
      value: machine.snapshot(),
      source: 'controller-state',
    })
    const summaryValue = {
      schema: 1,
      fingerprint: DEV_LOOP_FINGERPRINT,
      runId,
      state: machine.state,
      decision: review?.decision ?? null,
      fixCount: machine.fixCount,
      hasModifiedProject: hasEnteredExecution(machine),
      test: evidenceSummary?.test ?? null,
      changedFiles: evidenceSummary?.changedFiles ?? null,
      changedFileNames: evidenceSummary?.changedFileNames ?? [],
      diagnostic: diagnostic ?? null,
    }
    const summaryArtifact = await finalizeArtifact(await this.store.writeJson({
      runId,
      stage: 'summary',
      name: 'run-summary.json',
      value: summaryValue,
      source: 'controller-summary',
    }))
    upsertArtifact(artifacts, summaryArtifact)
    const manifest = await this.store.writeJson({
      runId,
      stage: 'manifest',
      name: 'run-manifest.json',
      value: {
        schema: 1,
        fingerprint: DEV_LOOP_FINGERPRINT,
        runId,
        state: machine.state,
        fixCount: machine.fixCount,
        baseline: baseline ? { commit: baseline.commit, dirty: baseline.dirty, status: baseline.status } : null,
        artifacts: artifacts.map(exposeArtifact),
        phases: {
          preflight: preflight ?? null,
          problem: problem ? exposeArtifact(problem) : null,
          plan: plan ?? null,
          approval: approval ? exposeArtifact(approval) : null,
          review: review ?? null,
          evidenceSummary: evidenceSummary ?? null,
          diagnostic: diagnostic ?? null,
        },
      },
      source: 'controller',
    })
    const manifestArtifact = await finalizeArtifact(manifest)
    upsertArtifact(artifacts, manifestArtifact)
    const audit = await this.store.writeJson({
      runId,
      stage: 'audit',
      name: 'audit-trace.json',
      value: {
        schema: 1,
        fingerprint: DEV_LOOP_FINGERPRINT,
        ...machine.snapshot(),
        diagnostic: diagnostic ?? null,
        artifacts: artifacts.map(exposeArtifact),
      },
      source: 'controller',
    })
    const auditArtifact = await finalizeArtifact(audit)
    upsertArtifact(artifacts, auditArtifact)
    return {
      fingerprint: DEV_LOOP_FINGERPRINT,
      runId,
      state: machine.state,
      decision: review?.decision ?? null,
      fixCount: machine.fixCount,
      summary: summaryValue,
      diagnostic: diagnostic ?? null,
      artifacts: artifacts.map(exposeArtifact),
      audit: machine.snapshot(),
    }
  }
}

function normalizePlannerResult(response, callerExecutorTask) {
  const value = response?.result ?? response
  const result = assertPlainObject(value, 'Planner result')
  rejectUnknownKeys(result, ['type', 'plan', 'executorTask', 'constraints', 'tests', 'risks', 'targetBehavior', 'focusedTests', 'verification', 'requiredReport'], 'Planner result')
  if (result.type !== undefined && result.type !== 'plan') throw new Error('Planner result type must be plan')
  const plan = result.plan && typeof result.plan === 'object' && !Array.isArray(result.plan) ? result.plan : result
  const executorTask = normalizeExecutorTask(result.executorTask ?? plan.executorTask ?? callerExecutorTask)
  if (!executorTask) throw new Error('Planner result executorTask must be non-empty')
  return {
    type: 'plan',
    plan,
    executorTask,
    ...(result.constraints === undefined ? {} : { constraints: result.constraints }),
    ...(result.tests === undefined ? {} : { tests: result.tests }),
    ...(result.risks === undefined ? {} : { risks: result.risks }),
    source: 'planner',
  }
}

function normalizeExecutorTask(value) {
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return undefined
  return JSON.stringify(value)
}

function normalizeReviewResult(response) {
  const value = response?.result ?? response
  const result = assertPlainObject(value, 'Reviewer result')
  rejectUnknownKeys(result, ['type', 'decision', 'summary', 'nextTask', 'findings'], 'Reviewer result')
  if (result.type !== undefined && result.type !== 'review') throw new Error('Reviewer result type must be review')
  const decision = assertDecision(result.decision)
  if (result.summary !== undefined && typeof result.summary !== 'string') throw new Error('Reviewer summary must be a string')
  if (result.nextTask !== undefined && typeof result.nextTask !== 'string') throw new Error('Reviewer nextTask must be a string')
  if (result.findings !== undefined && !Array.isArray(result.findings)) throw new Error('Reviewer findings must be an array')
  return {
    type: 'review',
    decision,
    summary: result.summary ?? '',
    nextTask: typeof result.nextTask === 'string' && result.nextTask.trim() !== '' ? result.nextTask : undefined,
    findings: result.findings ?? [],
    source: 'reviewer',
  }
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`)
}

function defaultPlannerPrompt(problemPackage) {
  return `You are Planner only. Return strict JSON with plan and executorTask. Do not execute tools. Problem package:\n${JSON.stringify(problemPackage)}`
}

function defaultReviewerPrompt(problemPackage) {
  return `You are Reviewer only. Return exactly one valid JSON object and nothing else. Use only these keys: decision, summary, nextTask, findings. decision must be one of ACCEPTED, NEEDS_FIX, NEEDS_REPLAN, DEFER, ESCALATE. summary must be a single-line string. findings must be an array. Include nextTask only when needed. Do not use rationale, acceptance, stopConditionTriggered, or any other keys. Do not execute tools. Do not put literal newlines inside JSON strings; use escaped \\n if needed. Problem package:\n${JSON.stringify(problemPackage)}`
}

function replanPrompt(basePrompt, review) {
  return `${basePrompt}\n\nThe Reviewer requested a replan. Produce a replacement plan and executorTask. Reviewer feedback:\n${JSON.stringify(review)}`
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = new Error('dev-loop run cancelled')
  error.name = 'AbortError'
  error.code = 'CANCELLED'
  throw error
}

function hasEnteredExecution(machine) {
  return machine.audit.some(entry => entry.to === 'EXECUTING')
}

function upsertArtifact(artifacts, descriptor) {
  const index = artifacts.findIndex(item => item.name === descriptor.name)
  if (index === -1) artifacts.push(descriptor)
  else artifacts[index] = descriptor
  return descriptor
}

function persistableBaseline(snapshot) {
  return {
    commit: snapshot?.commit ?? null,
    status: snapshot?.status ?? '',
    diffStat: snapshot?.diffStat ?? '',
    dirty: Boolean(snapshot?.dirty),
    files: snapshot?.files ?? [],
    fileHashes: snapshot?.fileHashes ?? {},
  }
}

function hydrateBaseline(snapshot, snapshotRoot) {
  if (!snapshot) return undefined
  return {
    ...snapshot,
    diff: '',
    snapshotRoot,
    snapshotDir: join(snapshotRoot, 'baseline'),
  }
}

async function loadResumeData(store, runId) {
  let state
  try {
    state = await store.readJson({ runId, name: 'run-state.json' })
  } catch (error) {
    throw new DevLoopError('RUN_NOT_FOUND', `run state is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!['WAITING_FOR_APPROVAL', 'CHECKING_ENVIRONMENT'].includes(state.state)) {
    throw new DevLoopError('RUN_NOT_APPROVABLE', `run cannot be approved from state ${state.state}`)
  }
  const [request, baseline, manifest] = await Promise.all([
    store.readJson({ runId, name: 'run-request.json' }),
    store.readJson({ runId, name: 'baseline-snapshot.json' }),
    store.readJson({ runId, name: 'run-manifest.json' }).catch(() => ({ artifacts: [], phases: {} })),
  ])
  const planDescriptor = (manifest.artifacts ?? []).find(artifact => artifact.name === 'plan.json')
  const plan = planDescriptor?.sha256
    ? await store.verifyJson({ runId, name: 'plan.json', sha256: planDescriptor.sha256 })
    : await store.readJson({ runId, name: 'plan.json' })
  if (request.runId !== runId) throw new Error('stored run request does not match runId')
  if (!plan || typeof plan !== 'object') throw new Error('stored plan is invalid')
  return { state, request, plan, baseline, manifest, planSha256: planDescriptor?.sha256 ?? null }
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
