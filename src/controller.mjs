import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { assertDecision, assertPlainObject, RunStateMachine, STATES } from './contracts.mjs'
import { createProjectZip, exposeArtifact, finalizeArtifact } from './artifacts.mjs'
import { DevLoopError, diagnosticFromError, isAbortError } from './diagnostics.mjs'
import { captureGitSnapshot } from './evidence.mjs'
import { createPreflightChecker } from './preflight.mjs'
import { DEV_LOOP_FINGERPRINT, publicProgressEvent } from './presentation.mjs'
import { assertConfiguredProjectRoot } from './project-root.mjs'
import { assertConfiguredArtifactRoot } from './artifact-root.mjs'

export class DevLoopController {
  constructor({ store, bridge, executor, evidenceCollector, gitAdapter, preflight, projectRoot, sessionId, mode = 'legacy', maxFixes = 1, runIdFactory = () => `run-${randomUUID()}` } = {}) {
    if (!['legacy', 'manual-handoff'].includes(mode)) throw new Error(`unsupported dev-loop mode: ${String(mode)}`)
    if (!store || (!bridge && mode !== 'manual-handoff') || !executor || !evidenceCollector) {
      throw new Error('store, the mode-required transport, executor, and evidenceCollector are required')
    }
    this.mode = mode
    this.gitAdapter = gitAdapter ?? evidenceCollector.gitAdapter
    if (typeof this.gitAdapter !== 'function') throw new Error('fixed Git evidence adapter is required')
    this.projectRoot = assertConfiguredProjectRoot(projectRoot ?? evidenceCollector.projectRoot)
    this.artifactRoot = store.root ?? store.configuredRoot
    this.sessionId = sessionId
    if (maxFixes !== 1) throw new Error('phase one requires exactly one automatic NEEDS_FIX budget')
    this.store = store
    this.bridge = bridge
    this.executor = executor
    this.evidenceCollector = evidenceCollector
    this.preflight = preflight ?? createPreflightChecker({
      gitAdapter: this.gitAdapter,
      bridge,
      transport: mode === 'manual-handoff' ? 'manual-handoff' : 'bridge',
    })
    this.maxFixes = maxFixes
    this.runIdFactory = runIdFactory
  }

  async run({ runId: requestedRunId, projectRoot: requestedProjectRoot, artifactRoot: requestedArtifactRoot, problemPackage: requestedProblemPackage, approval = false, approvalSource = 'human', plannerPrompt: requestedPlannerPrompt, reviewerPrompt: requestedReviewerPrompt, executorTask: requestedExecutorTask, testCommand: requestedTestCommand, signal, onProgress, onEvent, resumeFromApproval = false } = {}) {
    if (this.mode !== 'legacy') throw new DevLoopError('MODE_MISMATCH', 'legacy run is unavailable in manual-handoff mode')
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
    if (artifactRoot !== undefined || this.artifactRoot !== undefined) {
      artifactRoot = assertConfiguredArtifactRoot(this.artifactRoot, artifactRoot)
    }
    projectRoot = assertConfiguredProjectRoot(this.projectRoot, projectRoot)
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
          gitAdapter: this.gitAdapter,
          artifactRoot: this.store.root,
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

  async submitExternalPlan({ plan: submittedPlan, signal, onEvent } = {}) {
    this.assertManualHandoffMode()
    const sessionId = assertDshSessionId(this.sessionId)
    const plan = normalizeExternalPlan(submittedPlan)
    const runId = this.runIdFactory()
    const machine = new RunStateMachine({ runId, maxFixes: this.maxFixes })
    const artifacts = []
    const artifactRoot = this.store.root ?? this.store.configuredRoot
    const evidencePath = join(artifactRoot, runId)
    const handoff = {
      mode: 'manual-handoff',
      source: 'manual-chatgpt-web-plan-relay',
      evidencePath,
    }
    const notify = event => {
      const value = { runId, at: new Date().toISOString(), fingerprint: DEV_LOOP_FINGERPRINT, ...event }
      try { onEvent?.(value) } catch {}
    }
    const persistState = () => this.store.writeJson({
      runId,
      stage: 'state',
      name: 'run-state.json',
      value: machine.snapshot(),
      source: 'controller-state',
    })
    const transition = async (next, metadata = {}) => {
      machine.transition(next, metadata)
      await persistState()
      notify({ kind: 'progress', ...publicProgressEvent({ runId, stage: next, metadata: { ...metadata } }) })
    }
    const record = async descriptor => {
      const finalized = descriptor.sha256 ? descriptor : await finalizeArtifact(descriptor)
      upsertArtifact(artifacts, finalized)
      return finalized
    }
    const addJson = async (stage, name, value, source = 'controller') => record(await this.store.writeJson({ runId, stage, name, value, source }))

    await this.store.runRoot(runId)
    await this.store.writeJsonOnce({
      runId,
      stage: 'state',
      name: 'run-state.json',
      value: machine.snapshot(),
      source: 'controller-state',
    })
    notify({ kind: 'started', projectRoot: this.projectRoot, artifactRoot })

    let baseline
    let preflightResult
    let planResult
    let approval
    let diagnostic
    try {
      throwIfAborted(signal)
      await transition('CHECKING_ENVIRONMENT')
      preflightResult = await this.preflight({ projectRoot: this.projectRoot, artifactRoot, signal })
      await addJson('preflight', 'preflight.json', preflightResult, 'preflight')
      await transition('ANALYZING')
      const snapshotRoot = join(evidencePath, '.snapshots')
      baseline = await captureGitSnapshot({
        repoRoot: this.projectRoot,
        gitAdapter: this.gitAdapter,
        artifactRoot,
        snapshotRoot,
        snapshotName: 'baseline',
        signal,
      })
      const observedProject = contextFromSnapshot(baseline)
      assertPlanContextMatches(plan.observedContext, observedProject)
      const baselineArtifact = await addJson('analysis', 'baseline-snapshot.json', persistableBaseline(baseline), 'git-baseline')
      const planRecord = await record(await this.store.writeJsonOnce({
        runId,
        stage: 'plan',
        name: 'plan.json',
        value: {
          schema: 1,
          runId,
          source: 'manual-chatgpt-web-plan-relay',
          receivedAt: new Date().toISOString(),
          plan,
        },
        source: 'manual-chatgpt-web-plan-relay',
      }))
      handoff.planSha256 = planRecord.sha256
      handoff.planPath = join(evidencePath, 'plan.json')
      handoff.projectState = observedProject
      const request = await record(await this.store.writeJsonOnce({
        runId,
        stage: 'request',
        name: 'run-request.json',
        value: {
          schema: 1,
          mode: 'manual-handoff',
          runId,
          source: 'manual-chatgpt-web-plan-relay',
          projectRoot: this.projectRoot,
          artifactRoot,
          sessionId,
          planSha256: planRecord.sha256,
          baselineSha256: baselineArtifact.sha256,
          projectState: observedProject,
        },
        source: 'controller',
      }))
      handoff.requestSha256 = request.sha256
      planResult = {
        schema: 1,
        source: 'manual-chatgpt-web-plan-relay',
        sha256: planRecord.sha256,
        plan,
        artifact: exposeArtifact(planRecord),
      }
      await transition('PLAN_READY', { planSha256: planRecord.sha256 })
      await transition('WAITING_FOR_APPROVAL', { planSha256: planRecord.sha256 })
      approval = await addJson('approval', 'approval.json', {
        runId,
        approved: false,
        approvedAt: null,
        source: 'controller-default-deny',
        planSha256: planRecord.sha256,
      }, 'controller')
    } catch (error) {
      const cancelled = isAbortError(error, signal)
      diagnostic = diagnosticFromError(error, {
        code: cancelled ? 'CANCELLED' : undefined,
        phase: machine.state,
        runId,
        message: '方案接收没有开始修改项目文件。',
      })
      if (!['COMPLETE', 'STOPPED', 'FAILED', 'CANCELLED'].includes(machine.state)) {
        await transition(cancelled ? 'CANCELLED' : 'FAILED', { diagnosticCode: diagnostic.code, reason: diagnostic.technical.message })
      }
      await addJson('diagnostic', 'diagnostic.json', diagnostic, 'controller-diagnostic')
      notify({ kind: 'diagnostic', diagnostic })
    }
    const result = await this.finish({ machine, artifacts, runId, baseline, plan: planResult, approval, diagnostic, preflight: preflightResult, handoff })
    notify({ kind: 'finished', state: result.state, decision: result.decision, summary: result.summary, diagnostic: result.diagnostic })
    return result
  }

  async approveExternalPlan({ runId, planSha256, signal, onEvent } = {}) {
    this.assertManualHandoffMode()
    assertExternalRunId(runId)
    assertSha256(planSha256, 'planSha256')
    const data = await loadManualHandoffData(this.store, runId)
    this.assertStoredSession(data.request)
    if (data.state.state !== 'WAITING_FOR_APPROVAL') {
      throw new DevLoopError('RUN_NOT_APPROVABLE', `run cannot be approved from state ${data.state.state}`)
    }
    if (planSha256 !== data.planDescriptor.sha256 || planSha256 !== data.request.planSha256) {
      throw new DevLoopError('PLAN_HASH_MISMATCH', 'approval does not match the stored plan SHA-256')
    }
    const plan = normalizeExternalPlan(data.planRecord.plan)
    const artifactRoot = this.store.root
    const runRoot = await this.store.runRoot(runId)
    const snapshotRoot = join(runRoot, '.snapshots')
    const baseline = hydrateBaseline(data.baselineSnapshot, snapshotRoot)
    const notify = event => {
      const value = { runId, at: new Date().toISOString(), fingerprint: DEV_LOOP_FINGERPRINT, ...event }
      try { onEvent?.(value) } catch {}
    }
    const artifacts = data.artifacts.map(artifact => ({ ...artifact }))
    const record = async descriptor => {
      const finalized = descriptor.sha256 ? descriptor : await finalizeArtifact(descriptor)
      upsertArtifact(artifacts, finalized)
      return finalized
    }
    const addJson = async (stage, name, value, source = 'controller') => record(await this.store.writeJson({ runId, stage, name, value, source }))

    notify({ kind: 'started', projectRoot: this.projectRoot, artifactRoot, stage: 'EXECUTING' })
    throwIfAborted(signal)
    const preflightResult = await this.preflight({ projectRoot: this.projectRoot, artifactRoot, signal })
    const current = await captureGitSnapshot({
      repoRoot: this.projectRoot,
      gitAdapter: this.gitAdapter,
      artifactRoot,
      snapshotRoot,
      snapshotName: 'approval-check',
      signal,
    })
    if (!sameProjectSnapshot(data.request.projectState, data.baselineSnapshot, current)) {
      return this.stopManualHandoff({
        data,
        reason: 'project Git/worktree context changed after plan submission; a new plan approval is required',
        code: 'PROJECT_CONTEXT_CHANGED',
        onEvent,
      })
    }
    await this.store.writeJsonOnce({
      runId,
      stage: 'approval',
      name: 'approval-claim.json',
      value: {
        runId,
        action: 'approve',
        host: hostname(),
        pid: process.pid,
        planSha256,
        claimedAt: new Date().toISOString(),
        source: 'separate-human-command',
      },
      source: 'controller',
    })
    await record(await this.store.writeJsonOnce({
      runId,
      stage: 'execution',
      name: 'execution-owner.json',
      value: { schema: 1, runId, host: hostname(), pid: process.pid, planSha256, startedAt: new Date().toISOString() },
      source: 'controller-execution-owner',
    }))
    const latestState = await this.store.readJson({ runId, name: 'run-state.json' })
    if (latestState.state !== 'WAITING_FOR_APPROVAL') {
      throw new DevLoopError('RUN_NOT_APPROVABLE', `run cannot be approved from state ${latestState.state}`)
    }
    const machine = new RunStateMachine({ runId, maxFixes: this.maxFixes, initialSnapshot: latestState })
    let approval
    let evidenceSummary
    let review
    let diagnostic
    let handoff = { ...data.manifest.handoff }
    const transition = async (next, metadata = {}) => {
      machine.transition(next, metadata)
      await this.store.writeJson({ runId, stage: 'state', name: 'run-state.json', value: machine.snapshot(), source: 'controller-state' })
      notify({ kind: 'progress', ...publicProgressEvent({ runId, stage: next, metadata }) })
    }
    try {
      approval = await record(await this.store.writeJsonOnce({
        runId,
        stage: 'approval',
        name: 'approval-approved.json',
        value: {
          runId,
          approved: true,
          approvedAt: new Date().toISOString(),
          source: 'separate-human-command',
          planSha256,
          contextSha256: data.request.projectState.filesSha256,
        },
        source: 'separate-human-command',
      }))
      await addJson('preflight', 'preflight-approval.json', preflightResult, 'preflight')
      await transition('EXECUTING', { planSha256, approvalSha256: approval.sha256 })
      throwIfAborted(signal)
      const executorReport = await this.executor.execute({
        runId,
        cwd: this.projectRoot,
        task: externalExecutionTask(plan),
        signal,
        onProgress: status => notify({ kind: 'progress', ...publicProgressEvent({ runId, stage: machine.state, metadata: { executor: status.status } }) }),
      })
      assertSuccessfulExecutorTurn(executorReport)
      await transition('COLLECTING_EVIDENCE')
      const evidence = await this.evidenceCollector.collect({
        runId,
        round: 0,
        repoRoot: this.projectRoot,
        executorReport,
        baseline,
        signal,
      })
      evidenceSummary = evidence.summary
      const evidenceArtifacts = []
      for (const artifact of evidence.artifacts) evidenceArtifacts.push(await record(artifact))
      assertExternalExecutionScope(plan.scope, baseline, evidence)
      const projectState = contextFromSnapshot(evidence.after)
      const evidenceManifest = await record(await this.store.writeJsonOnce({
        runId,
        stage: 'evidence',
        name: 'evidence-manifest.json',
        value: {
          schema: 1,
          runId,
          source: 'controller-evidence-collector',
          planSha256,
          createdAt: new Date().toISOString(),
          projectState,
          test: evidenceSummary.test,
          artifacts: evidenceArtifacts.map(exposeArtifact),
        },
        source: 'controller-evidence-manifest',
      }))
      const reviewReceipt = randomBytes(16).toString('base64url')
      await record(await this.store.writeJsonOnce({
        runId,
        stage: 'review-receipt',
        name: 'review-receipt.json',
        value: {
          schema: 1,
          runId,
          receipt: reviewReceipt,
          planSha256,
          evidenceSha256: evidenceManifest.sha256,
          projectState,
          issuedAt: new Date().toISOString(),
        },
        source: 'controller-review-receipt',
      }))
      handoff = {
        ...handoff,
        evidenceSha256: evidenceManifest.sha256,
        reviewReceipt,
        evidencePath: join(artifactRoot, runId),
        evidenceManifestPath: join(artifactRoot, runId, 'evidence-manifest.json'),
        evidenceFiles: evidenceArtifacts.map(artifact => artifact.name),
        projectState,
        test: evidenceSummary.test,
      }
      await transition('REVIEWING', { evidenceSha256: evidenceManifest.sha256 })
    } catch (error) {
      const cancelled = isAbortError(error, signal)
      diagnostic = diagnosticFromError(error, {
        code: cancelled ? 'CANCELLED' : undefined,
        phase: machine.state,
        runId,
        message: 'DSH 执行或取证未成功；没有自动备用执行器。',
      })
      if (!['COMPLETE', 'STOPPED', 'FAILED', 'CANCELLED'].includes(machine.state)) {
        await transition(cancelled ? 'CANCELLED' : 'FAILED', { diagnosticCode: diagnostic.code, reason: diagnostic.technical.message })
      }
      const diagnosticArtifact = await record(await this.store.writeJson({
        runId,
        stage: 'diagnostic',
        name: 'diagnostic.json',
        value: diagnostic,
        source: 'controller-diagnostic',
      }))
      void diagnosticArtifact
      notify({ kind: 'diagnostic', diagnostic })
    }
    const result = await this.finish({
      machine,
      artifacts,
      runId,
      baseline,
      plan: data.manifest.phases.plan,
      approval,
      review,
      diagnostic,
      preflight: preflightResult ?? data.manifest.phases.preflight,
      evidenceSummary,
      handoff,
    })
    const executionOwner = artifacts.find(artifact => artifact.name === 'execution-owner.json')
    if (!executionOwner?.sha256) throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'execution owner artifact is missing after approval finalization')
    await this.store.writeJsonOnce({
      runId,
      stage: 'execution',
      name: 'execution-owner-settled.json',
      value: {
        schema: 1,
        runId,
        planSha256,
        executionOwnerSha256: executionOwner.sha256,
        completedAt: new Date().toISOString(),
      },
      source: 'controller-execution-owner',
    })
    notify({ kind: 'finished', state: result.state, decision: result.decision, summary: result.summary, diagnostic: result.diagnostic })
    return result
  }

  async findExternalRunForSession({ operation } = {}) {
    this.assertManualHandoffMode()
    const sessionId = assertDshSessionId(this.sessionId)
    const operationStates = {
      approve: ['WAITING_FOR_APPROVAL'],
      status: ['CHECKING_ENVIRONMENT', 'ANALYZING', 'PLAN_READY', 'WAITING_FOR_APPROVAL', 'EXECUTING', 'COLLECTING_EVIDENCE', 'REVIEWING'],
      cancel: ['CHECKING_ENVIRONMENT', 'ANALYZING', 'PLAN_READY', 'WAITING_FOR_APPROVAL', 'EXECUTING', 'COLLECTING_EVIDENCE', 'REVIEWING'],
      review: ['REVIEWING'],
    }
    const states = operationStates[operation]
    if (!states) throw new Error('unsupported current-session operation')
    const candidates = []
    for (const runId of await this.store.listRunIds()) {
      const manifest = await this.store.readJson({ runId, name: 'run-manifest.json' })
      if (!manifest || manifest.runId !== runId) {
        throw new DevLoopError('RUN_RECORD_MISMATCH', `persisted manifest does not match run ${runId}`)
      }
      if (manifest.handoff?.mode !== 'manual-handoff') continue
      const data = await loadManualHandoffData(this.store, runId)
      const storedSessionId = assertDshSessionId(data.request.sessionId)
      if (storedSessionId !== sessionId) continue
      this.assertStoredRoots(data.request)
      if (states.includes(data.state.state)) {
        candidates.push({ runId, state: data.state.state, planSha256: data.planDescriptor.sha256 })
      }
    }
    if (candidates.length === 0) {
      throw new DevLoopError('RUN_SESSION_CANDIDATE_MISSING', `当前 DSH session 没有可执行此操作的任务：${operation}`)
    }
    if (candidates.length > 1) {
      throw new DevLoopError('RUN_SESSION_CANDIDATE_AMBIGUOUS', `当前 DSH session 有多个可执行此操作的任务：${operation}`)
    }
    return candidates[0]
  }

  async submitExternalReview({ runId, receipt, decision: requestedDecision, summary = '', findings = [] } = {}) {
    this.assertManualHandoffMode()
    assertExternalRunId(runId)
    if (typeof receipt !== 'string' || receipt.trim() === '') {
      throw new DevLoopError('REVIEW_RECEIPT_REQUIRED', 'reviewer receipt is required')
    }
    const decision = assertDecision(requestedDecision)
    if (typeof summary !== 'string' || summary.trim() === '') throw new Error('Reviewer summary must be a non-empty string')
    if (!Array.isArray(findings) || findings.some(finding => typeof finding !== 'string' || finding.trim() === '')) {
      throw new Error('Reviewer findings must be an array of non-empty strings')
    }
    const data = await loadManualHandoffData(this.store, runId)
    this.assertStoredSession(data.request)
    if (data.state.state !== 'REVIEWING') {
      throw new DevLoopError('RUN_NOT_REVIEWABLE', `run cannot accept an external review from state ${data.state.state}`)
    }
    await this.#assertExecutionSettled(runId, data.manifest)
    const planSha256 = data.planDescriptor.sha256
    if (planSha256 !== data.request.planSha256) {
      throw new DevLoopError('PLAN_HASH_MISMATCH', 'review does not match the stored plan SHA-256')
    }
    const evidenceDescriptor = findArtifact(data.manifest, 'evidence-manifest.json')
    const evidenceSha256 = evidenceDescriptor.sha256
    if (evidenceSha256 !== data.manifest.handoff.evidenceSha256) {
      throw new DevLoopError('EVIDENCE_HASH_MISMATCH', 'review does not match the stored evidence SHA-256')
    }
    const evidence = await this.store.verifyJson({ runId, name: evidenceDescriptor.name, sha256: evidenceSha256 })
    if (evidence.runId !== runId || evidence.planSha256 !== planSha256) throw new DevLoopError('EVIDENCE_RUN_MISMATCH', 'evidence is not bound to this run and plan')
    const receiptDescriptor = findArtifact(data.manifest, 'review-receipt.json')
    const receiptRecord = await this.store.verifyJson({ runId, name: receiptDescriptor.name, sha256: receiptDescriptor.sha256 })
    if (
      receiptRecord.schema !== 1
      || receiptRecord.runId !== runId
      || receiptRecord.receipt !== receipt
      || receiptRecord.planSha256 !== planSha256
      || receiptRecord.evidenceSha256 !== evidenceSha256
      || !sameReviewerProject(receiptRecord.projectState, evidence.projectState)
    ) {
      throw new DevLoopError('REVIEW_RECEIPT_MISMATCH', 'reviewer receipt does not match the current run, plan, evidence, and project state')
    }
    for (const artifact of evidence.artifacts ?? []) {
      await this.store.verifyArtifact({ runId, name: artifact.name, sha256: artifact.sha256 })
    }
    if (decision === 'ACCEPTED' && evidence.test?.ok !== true) {
      throw new DevLoopError('REVIEW_TEST_NOT_PASSED', 'ACCEPTED requires passing DSH-authorized test evidence in the M2 handoff')
    }
    const afterDescriptor = findArtifact(data.manifest, 'after-snapshot.json')
    const afterSnapshot = await this.store.verifyJson({ runId, name: afterDescriptor.name, sha256: afterDescriptor.sha256 })
    const runRoot = await this.store.runRoot(runId)
    const current = await captureGitSnapshot({
      repoRoot: this.projectRoot,
      gitAdapter: this.gitAdapter,
      artifactRoot: this.store.root,
      snapshotRoot: join(runRoot, '.snapshots'),
      snapshotName: 'reviewer-current',
    })
    const evidenceStale = !sameProjectSnapshot(evidence.projectState, afterSnapshot, current)
    await this.#claimExternalReviewResolution({ runId, action: 'review', planSha256, evidenceSha256 })
    const latestState = await this.store.readJson({ runId, name: 'run-state.json' })
    if (!sameRunStateSnapshot(data.state, latestState)) {
      throw new DevLoopError('RUN_STATE_CHANGED', `run state changed from ${data.state.state} to ${latestState.state}; review was not recorded`)
    }
    if (evidenceStale) {
      return this.stopManualHandoff({
        data,
        reason: 'project Git/worktree context changed after evidence collection; the review evidence is stale',
        code: 'EVIDENCE_STALE',
      })
    }
    const review = {
      schema: 1,
      runId,
      planSha256,
      evidenceSha256,
      receipt,
      decision,
      summary,
      findings,
      source: 'manual-chatgpt-web-review-relay',
      receivedAt: new Date().toISOString(),
    }
    const artifacts = data.artifacts.map(artifact => ({ ...artifact }))
    const reviewArtifact = await finalizeArtifact(await this.store.writeJsonOnce({
      runId,
      stage: 'review',
      name: 'review.json',
      value: review,
      source: 'manual-chatgpt-web-review-relay',
    }))
    upsertArtifact(artifacts, reviewArtifact)
    const machine = new RunStateMachine({ runId, maxFixes: this.maxFixes, initialSnapshot: data.state })
    if (decision === 'ACCEPTED') {
      machine.applyDecision('ACCEPTED', { planSha256, evidenceSha256, reviewSource: review.source })
    } else {
      machine.transition('STOPPED', {
        decision,
        planSha256,
        evidenceSha256,
        reason: 'automatic execution after an external review is disabled until reauthorization rules are approved',
        reviewSource: review.source,
      })
    }
    await this.store.writeJson({ runId, stage: 'state', name: 'run-state.json', value: machine.snapshot(), source: 'controller-state' })
    const handoff = {
      ...data.manifest.handoff,
      reviewSource: review.source,
      reviewerDecision: decision,
      reviewSha256: reviewArtifact.sha256,
    }
    const result = await this.finish({
      machine,
      artifacts,
      runId,
      baseline: data.baselineSnapshot,
      plan: data.manifest.phases.plan,
      approval: data.manifest.phases.approval,
      review,
      preflight: data.manifest.phases.preflight,
      evidenceSummary: data.manifest.phases.evidenceSummary,
      handoff,
    })
    return result
  }

  async getExternalRunStatus({ runId } = {}) {
    this.assertManualHandoffMode()
    assertExternalRunId(runId)
    const data = await loadManualHandoffData(this.store, runId)
    this.assertStoredSession(data.request)
    const summary = await this.store.readJson({ runId, name: 'run-summary.json' }).catch(() => null)
    return {
      runId,
      state: data.state.state,
      decision: summary?.decision ?? null,
      summary,
      handoff: data.manifest.handoff,
      artifacts: data.artifacts.map(exposeArtifact),
    }
  }

  assertStoredRoots(request) {
    if (request.projectRoot !== this.projectRoot) throw new DevLoopError('PROJECT_ROOT_CHANGED', 'stored run projectRoot does not match the trusted Host projectRoot')
    if (request.artifactRoot !== this.store.root) throw new DevLoopError('ARTIFACT_ROOT_CHANGED', 'stored run artifactRoot does not match the trusted Host artifactRoot')
  }

  assertStoredSession(request) {
    const sessionId = assertDshSessionId(this.sessionId)
    if (request.sessionId !== sessionId) {
      throw new DevLoopError('RUN_SESSION_MISMATCH', 'stored run belongs to a different DSH session')
    }
    this.assertStoredRoots(request)
  }

  async #assertExecutionSettled(runId, manifest, { allowIncompleteStop = false } = {}) {
    const ownerArtifact = (manifest.artifacts ?? []).find(artifact => artifact.name === 'execution-owner.json')
    if (!ownerArtifact?.sha256) {
      let owner
      try {
        owner = await this.store.readJson({ runId, name: 'execution-owner.json' })
      } catch (error) {
        throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'execution owner cannot be verified from the incomplete manifest', { cause: error })
      }
      if (owner.schema !== 1 || owner.runId !== runId || !/^[a-f0-9]{64}$/i.test(owner.planSha256)
        || (manifest.handoff?.planSha256 && owner.planSha256 !== manifest.handoff.planSha256)) {
        throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'execution owner does not match this run and plan')
      }
      assertExecutionOwnerStopped(owner, runId)
      if (allowIncompleteStop) return { incomplete: true }
      throw new DevLoopError('RUN_EXECUTION_FINALIZATION_INCOMPLETE', 'the approval process exited before its execution owner was recorded in the review manifest')
    }
    let owner
    try {
      owner = await this.store.verifyJson({ runId, name: ownerArtifact.name, sha256: ownerArtifact.sha256 })
    } catch (error) {
      throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'execution owner artifact cannot be verified; review resolution was not recorded', { cause: error })
    }
    const planSha256 = manifest.handoff?.planSha256
    if (owner.runId !== runId || owner.planSha256 !== planSha256) {
      throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'execution owner does not match this run and plan')
    }
    let settled
    try {
      settled = await this.store.readJson({ runId, name: 'execution-owner-settled.json' })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        assertExecutionOwnerStopped(owner, runId)
        if (!await hasCompleteExecutionFinalization(this.store, runId, manifest, ownerArtifact, planSha256)) {
          if (allowIncompleteStop) return { incomplete: true }
          throw new DevLoopError('RUN_EXECUTION_FINALIZATION_INCOMPLETE', 'the approval process exited before its review evidence was fully persisted')
        }
        try {
          await this.store.writeJsonOnce({
            runId,
            stage: 'execution',
            name: 'execution-owner-settled.json',
            value: {
              schema: 1,
              runId,
              planSha256,
              executionOwnerSha256: ownerArtifact.sha256,
              completedAt: new Date().toISOString(),
              recovered: true,
            },
            source: 'controller-execution-owner-recovery',
          })
        } catch (writeError) {
          if (writeError?.code !== 'ARTIFACT_ALREADY_EXISTS') {
            throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'execution settlement could not be recovered safely', { cause: writeError })
          }
        }
        try {
          settled = await this.store.readJson({ runId, name: 'execution-owner-settled.json' })
        } catch (readError) {
          throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'recovered execution settlement cannot be verified', { cause: readError })
        }
      } else if (allowIncompleteStop && error instanceof SyntaxError) {
        assertExecutionOwnerStopped(owner, runId)
        return { incomplete: true }
      } else {
        throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'execution owner settlement cannot be verified; review resolution was not recorded', { cause: error })
      }
    }
    if (settled?.schema !== 1 || settled.runId !== runId || settled.planSha256 !== planSha256
      || settled.executionOwnerSha256 !== ownerArtifact.sha256) {
      if (allowIncompleteStop) {
        assertExecutionOwnerStopped(owner, runId)
        return { incomplete: true }
      }
      throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'execution owner settlement does not match this run and plan')
    }
    return { incomplete: false }
  }

  async #claimExternalReviewResolution({ runId, action, planSha256, evidenceSha256 } = {}) {
    try {
      await this.store.writeJsonOnce({
        runId,
        stage: 'review',
        name: 'review-resolution-claim.json',
        value: createReviewResolutionClaim({ runId, action, planSha256, evidenceSha256 }),
        source: 'controller',
      })
    } catch (error) {
      if (error?.code !== 'ARTIFACT_ALREADY_EXISTS' || action !== 'cancel') throw error
      const existing = await this.store.readJson({ runId, name: 'review-resolution-claim.json' })
      if (!['review', 'cancel'].includes(existing.action)) {
        throw new DevLoopError('RUN_REVIEW_OWNER_UNKNOWN', 'review resolution owner cannot be verified; no terminal state was written')
      }
      assertReviewResolutionOwnerStopped(existing, runId)
      await this.store.writeJson({
        runId,
        stage: 'review',
        name: 'review-resolution-claim.json',
        value: createReviewResolutionClaim({ runId, action, planSha256, evidenceSha256 }),
        source: 'controller',
      })
    }
  }

  async stopManualHandoff({ data, reason, code, onEvent } = {}) {
    const runId = data.state.runId
    if (data.state.state === 'WAITING_FOR_APPROVAL') {
      try {
        await this.store.writeJsonOnce({
          runId,
          stage: 'approval',
          name: 'approval-claim.json',
          value: {
            runId,
            action: 'stop-context',
            host: hostname(),
            pid: process.pid,
            claimedAt: new Date().toISOString(),
            source: 'controller-context-check',
          },
          source: 'controller',
        })
      } catch (error) {
        if (error?.code !== 'ARTIFACT_ALREADY_EXISTS') throw error
        const claim = await this.store.readJson({ runId, name: 'approval-claim.json' })
        throw new DevLoopError('RUN_APPROVAL_CLAIMED', `approval or cancellation already claimed this run: ${claim.action}`)
      }
    }
    const latestState = await this.store.readJson({ runId, name: 'run-state.json' })
    if (!sameRunStateSnapshot(data.state, latestState)) {
      if (['COMPLETE', 'STOPPED', 'FAILED', 'CANCELLED'].includes(latestState.state)) {
        throw new DevLoopError('RUN_ALREADY_TERMINAL', `run is already terminal: ${latestState.state}`)
      }
      throw new DevLoopError('RUN_STATE_CHANGED', `run state changed from ${data.state.state} to ${latestState.state}; stop was not recorded`)
    }
    const machine = new RunStateMachine({ runId: data.state.runId, maxFixes: this.maxFixes, initialSnapshot: data.state })
    machine.transition('STOPPED', { diagnosticCode: code, reason })
    const diagnostic = diagnosticFromError(new Error(reason), {
      code,
      phase: data.state.state,
      runId: data.state.runId,
      message: '项目上下文或证据已变化；本次运行已停止，需要重新确认。',
    })
    const artifacts = data.artifacts.map(artifact => ({ ...artifact }))
    const diagnosticArtifact = await finalizeArtifact(await this.store.writeJson({
      runId: data.state.runId,
      stage: 'diagnostic',
      name: 'diagnostic.json',
      value: diagnostic,
      source: 'controller-diagnostic',
    }))
    upsertArtifact(artifacts, diagnosticArtifact)
    const result = await this.finish({
      machine,
      artifacts,
      runId: data.state.runId,
      baseline: data.baselineSnapshot,
      plan: data.manifest.phases.plan,
      approval: data.manifest.phases.approval,
      review: data.manifest.phases.review,
      diagnostic,
      preflight: data.manifest.phases.preflight,
      evidenceSummary: data.manifest.phases.evidenceSummary,
      handoff: data.manifest.handoff,
    })
    try { onEvent?.({ runId: data.state.runId, at: new Date().toISOString(), fingerprint: DEV_LOOP_FINGERPRINT, kind: 'finished', state: result.state, diagnostic }) } catch {}
    return result
  }

  assertManualHandoffMode() {
    if (this.mode !== 'manual-handoff') throw new DevLoopError('MODE_MISMATCH', 'manual handoff action is unavailable in legacy mode')
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
    let manifest
    if (this.mode === 'manual-handoff') {
      assertExternalRunId(runId)
      const data = await loadManualHandoffData(this.store, runId)
      this.assertStoredSession(data.request)
      state = data.state
      manifest = data.manifest
    } else {
      try {
        state = await this.store.readJson({ runId, name: 'run-state.json' })
      } catch (error) {
        throw new DevLoopError('RUN_NOT_FOUND', `run state is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      manifest = await this.store.readJson({ runId, name: 'run-manifest.json' }).catch(() => ({ artifacts: [], phases: {} }))
    }
    if (['COMPLETE', 'STOPPED', 'FAILED', 'CANCELLED'].includes(state.state)) {
      throw new DevLoopError('RUN_ALREADY_TERMINAL', `run is already terminal: ${state.state}`)
    }
    if (this.mode === 'manual-handoff' && state.state === 'WAITING_FOR_APPROVAL') {
      try {
        await this.store.writeJsonOnce({
          runId,
          stage: 'approval',
          name: 'approval-claim.json',
          value: {
            runId,
            action: 'cancel',
            host: hostname(),
            pid: process.pid,
            claimedAt: new Date().toISOString(),
            source: 'separate-human-command',
          },
          source: 'controller',
        })
      } catch (error) {
        if (error?.code !== 'ARTIFACT_ALREADY_EXISTS') throw error
        const claim = await this.store.readJson({ runId, name: 'approval-claim.json' })
        if (!['approve', 'cancel', 'stop-context'].includes(claim.action)) {
          throw new DevLoopError('RUN_APPROVAL_OWNER_UNKNOWN', 'approval or cancellation owner cannot be verified; no terminal state was written')
        }
        assertExecutionOwnerStopped(claim, runId)
      }
    }
    if (this.mode === 'manual-handoff' && (['EXECUTING', 'COLLECTING_EVIDENCE'].includes(state.state) || state.state === 'WAITING_FOR_APPROVAL')) {
      const owner = await this.store.readJson({ runId, name: 'execution-owner.json' }).catch(error => {
        if (error?.code === 'ENOENT') return undefined
        throw error
      })
      if (['EXECUTING', 'COLLECTING_EVIDENCE'].includes(state.state) && !owner) {
        throw new DevLoopError('RUN_EXECUTION_OWNER_UNKNOWN', 'cannot cancel an active DSH run without verified execution ownership')
      }
      if (owner) assertExecutionOwnerStopped(owner, runId)
    }
    let executionSettlement
    if (this.mode === 'manual-handoff' && state.state === 'REVIEWING') {
      executionSettlement = await this.#assertExecutionSettled(runId, manifest, { allowIncompleteStop: true })
      await this.#claimExternalReviewResolution({ runId, action: 'cancel' })
    }
    if (this.mode === 'manual-handoff') {
      const latestState = await this.store.readJson({ runId, name: 'run-state.json' })
      if (!sameRunStateSnapshot(state, latestState)) {
        if (['COMPLETE', 'STOPPED', 'FAILED', 'CANCELLED'].includes(latestState.state)) {
          throw new DevLoopError('RUN_ALREADY_TERMINAL', `run is already terminal: ${latestState.state}`)
        }
        throw new DevLoopError('RUN_STATE_CHANGED', `run state changed from ${state.state} to ${latestState.state}; cancellation was not recorded`)
      }
      state = latestState
    }
    const machine = new RunStateMachine({ runId, maxFixes: this.maxFixes, initialSnapshot: state })
    machine.transition('CANCELLED', {
      reason,
      cancellationSource: 'human',
      ...(executionSettlement?.incomplete ? { executionFinalizationIncomplete: true } : {}),
    })
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
      handoff: manifest.handoff,
    })
  }

  async finish({ machine, artifacts, runId, baseline, problem, plan, approval, review, diagnostic, preflight, evidenceSummary, handoff } = {}) {
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
    if (handoff) summaryValue.handoff = handoff
    const summaryArtifact = await finalizeArtifact(await this.store.writeJson({
      runId,
      stage: 'summary',
      name: 'run-summary.json',
      value: summaryValue,
      source: 'controller-summary',
    }))
    upsertArtifact(artifacts, summaryArtifact)
    const manifestValue = {
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
    }
    if (handoff) manifestValue.handoff = handoff
    const manifest = await this.store.writeJson({
      runId,
      stage: 'manifest',
      name: 'run-manifest.json',
      value: manifestValue,
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
      ...(handoff ? { handoff } : {}),
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

function createReviewResolutionClaim({ runId, action, planSha256, evidenceSha256 } = {}) {
  return {
    schema: 1,
    runId,
    action,
    host: hostname(),
    pid: process.pid,
    planSha256,
    evidenceSha256,
    claimedAt: new Date().toISOString(),
    source: 'separate-human-command',
  }
}

function assertExecutionOwnerStopped(owner, runId) {
  assertControllerOwnerStopped(owner, runId, {
    unknownCode: 'RUN_EXECUTION_OWNER_UNKNOWN',
    activeCode: 'RUN_EXECUTION_STILL_ACTIVE',
    ownerLabel: 'execution owner',
    activeMessage: 'the DSH execution owner is still running; cancel through the owning DSH command',
  })
}

function assertReviewResolutionOwnerStopped(owner, runId) {
  assertControllerOwnerStopped(owner, runId, {
    unknownCode: 'RUN_REVIEW_OWNER_UNKNOWN',
    activeCode: 'RUN_REVIEW_RESOLUTION_ACTIVE',
    ownerLabel: 'review resolution owner',
    activeMessage: 'an external review or cancellation is already being recorded',
  })
}

function assertControllerOwnerStopped(owner, runId, { unknownCode, activeCode, ownerLabel, activeMessage }) {
  const unknownMessage = `${ownerLabel} cannot be verified on this host; cancellation was not recorded`
  if (owner?.runId !== runId || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) {
    throw new DevLoopError(unknownCode, unknownMessage)
  }
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    if (error?.code === 'ESRCH') return
    if (error?.code !== 'EPERM') {
      throw new DevLoopError(unknownCode, `${ownerLabel} liveness could not be verified; cancellation was not recorded`, { cause: error })
    }
  }
  throw new DevLoopError(activeCode, activeMessage)
}

function normalizeExternalPlan(value) {
  const plan = assertPlainObject(value, 'external plan')
  rejectUnknownKeys(plan, ['schema', 'summary', 'scope', 'executionRequirements', 'contextSources', 'observedContext', 'executorTask', 'acceptanceCriteria'], 'external plan')
  if (plan.schema !== 1) throw new Error('external plan schema must be 1')
  const scope = assertPlainObject(plan.scope, 'external plan scope')
  rejectUnknownKeys(scope, ['includedPaths', 'excludedPaths', 'nonGoals'], 'external plan scope')
  const observedContext = assertPlainObject(plan.observedContext, 'external plan observedContext')
  rejectUnknownKeys(observedContext, ['branch', 'commit'], 'external plan observedContext')
  const normalized = {
    schema: 1,
    summary: requiredString(plan.summary, 'external plan summary'),
    scope: {
      includedPaths: normalizeRepositoryPaths(requiredStringArray(scope.includedPaths, 'external plan scope.includedPaths'), 'external plan scope.includedPaths'),
      excludedPaths: normalizeRepositoryPaths(optionalStringArray(scope.excludedPaths, 'external plan scope.excludedPaths'), 'external plan scope.excludedPaths'),
      nonGoals: optionalStringArray(scope.nonGoals, 'external plan scope.nonGoals'),
    },
    executionRequirements: requiredStringArray(plan.executionRequirements, 'external plan executionRequirements'),
    contextSources: requiredStringArray(plan.contextSources, 'external plan contextSources'),
    observedContext: {
      branch: requiredString(observedContext.branch, 'external plan observedContext.branch'),
      commit: requiredString(observedContext.commit, 'external plan observedContext.commit'),
    },
    executorTask: requiredString(plan.executorTask, 'external plan executorTask'),
  }
  if (normalized.observedContext.branch.includes('\n')) throw new Error('external plan observedContext.branch must be one line')
  if (!/^[a-f0-9]{40,64}$/i.test(normalized.observedContext.commit)) throw new Error('external plan observedContext.commit must be a Git commit SHA')
  if (plan.acceptanceCriteria !== undefined) normalized.acceptanceCriteria = requiredStringArray(plan.acceptanceCriteria, 'external plan acceptanceCriteria')
  return normalized
}

function contextFromSnapshot(snapshot) {
  const fileHashes = Object.fromEntries(Object.entries(snapshot.fileHashes ?? {}).sort(([left], [right]) => left.localeCompare(right)))
  return {
    branch: branchFromStatus(snapshot.status),
    commit: snapshot.commit,
    dirty: Boolean(snapshot.dirty),
    statusSha256: sha256Text(snapshot.status ?? ''),
    diffSha256: sha256Text(snapshot.diff ?? ''),
    filesSha256: sha256Text(JSON.stringify(fileHashes)),
  }
}

function branchFromStatus(status) {
  const line = String(status ?? '').split('\n', 1)[0]
  if (!line.startsWith('## ')) throw new Error('Git status did not report the current branch')
  const value = line.slice(3)
  if (value === 'HEAD (no branch)') return 'HEAD'
  const branch = value.split('...', 1)[0].split(' ', 1)[0]
  if (!branch) throw new Error('Git status reported an empty branch name')
  return branch
}

function assertPlanContextMatches(observed, actual) {
  if (observed.branch !== actual.branch || observed.commit.toLowerCase() !== actual.commit.toLowerCase()) {
    throw new DevLoopError('PLAN_CONTEXT_MISMATCH', '外部方案观察到的分支或 commit 与当前项目不一致')
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function requiredStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${label} must be a non-empty array of strings`)
  }
  return value.map(item => item.trim())
}

function optionalStringArray(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${label} must be an array of strings`)
  }
  return value.map(item => item.trim())
}

function normalizeRepositoryPaths(paths, label) {
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
      throw new Error(`${label} entries must be safe repository-relative paths`)
    }
    return path
  })
}

async function loadManualHandoffData(store, runId) {
  const [state, manifest] = await Promise.all([
    store.readJson({ runId, name: 'run-state.json' }),
    store.readJson({ runId, name: 'run-manifest.json' }),
  ])
  if (manifest.handoff?.mode !== 'manual-handoff') {
    throw new DevLoopError('RUN_NOT_MANUAL_HANDOFF', 'run is not a persisted manual M2 handoff')
  }
  if (state.runId !== runId || manifest.runId !== runId) {
    throw new DevLoopError('RUN_RECORD_MISMATCH', 'persisted state and manifest do not match runId')
  }
  if (!STATES.includes(state.state)) throw new DevLoopError('RUN_STATE_INVALID', `persisted run state is invalid: ${String(state.state)}`)
  const manifestLagsActiveExecution = manifest.state === 'WAITING_FOR_APPROVAL'
    && ['EXECUTING', 'COLLECTING_EVIDENCE', 'REVIEWING'].includes(state.state)
  if (manifest.state !== state.state && !manifestLagsActiveExecution) {
    throw new DevLoopError('RUN_RECORD_MISMATCH', 'persisted run state is inconsistent with its manifest')
  }
  if (!Array.isArray(manifest.artifacts)) throw new DevLoopError('RUN_RECORD_MISMATCH', 'persisted handoff manifest has no artifact list')
  const requestDescriptor = findArtifact(manifest, 'run-request.json')
  const planDescriptor = findArtifact(manifest, 'plan.json')
  const baselineDescriptor = findArtifact(manifest, 'baseline-snapshot.json')
  const [request, planRecord, baselineSnapshot] = await Promise.all([
    store.verifyJson({ runId, name: requestDescriptor.name, sha256: requestDescriptor.sha256 }),
    store.verifyJson({ runId, name: planDescriptor.name, sha256: planDescriptor.sha256 }),
    store.verifyJson({ runId, name: baselineDescriptor.name, sha256: baselineDescriptor.sha256 }),
  ])
  if (request.mode !== 'manual-handoff' || request.runId !== runId || planRecord.runId !== runId) {
    throw new DevLoopError('RUN_RECORD_MISMATCH', 'persisted handoff records do not match runId or mode')
  }
  assertDshSessionId(request.sessionId)
  if (request.planSha256 !== planDescriptor.sha256 || planRecord.source !== 'manual-chatgpt-web-plan-relay') {
    throw new DevLoopError('PLAN_RECORD_MISMATCH', 'persisted plan source or digest does not match its run request')
  }
  if (request.baselineSha256 !== baselineDescriptor.sha256) {
    throw new DevLoopError('BASELINE_HASH_MISMATCH', 'persisted baseline digest does not match its run request')
  }
  try {
    new RunStateMachine({ runId, maxFixes: 1, initialSnapshot: state })
  } catch (error) {
    throw new DevLoopError('RUN_STATE_INVALID', 'persisted manual handoff state is invalid', { cause: error })
  }
  return {
    state,
    manifest,
    artifacts: manifest.artifacts ?? [],
    request,
    planDescriptor,
    planRecord,
    baselineSnapshot,
  }
}

function findArtifact(manifest, name) {
  const descriptor = manifest.artifacts?.find(artifact => artifact.name === name)
  if (!descriptor?.sha256) throw new DevLoopError('RUN_ARTIFACT_MISSING', `persisted run is missing verified artifact ${name}`)
  return descriptor
}

function assertExternalRunId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('runId contains unsupported characters')
}

function assertDshSessionId(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512 || value.includes('\0')) {
    throw new DevLoopError('DSH_SESSION_ID_UNAVAILABLE', 'a valid DSH invocation session ID is required')
  }
  return value
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`)
}

function sameProjectSnapshot(expectedContext, expectedSnapshot, current) {
  const actualContext = contextFromSnapshot(current)
  return expectedContext.branch === actualContext.branch
    && expectedContext.commit === actualContext.commit
    && expectedContext.statusSha256 === actualContext.statusSha256
    && expectedContext.diffSha256 === actualContext.diffSha256
    && expectedContext.filesSha256 === actualContext.filesSha256
    && expectedSnapshot.status === current.status
    && expectedSnapshot.dirty === current.dirty
    && equalFileHashes(expectedSnapshot.fileHashes, current.fileHashes)
}

function sameRunStateSnapshot(left, right) {
  return left?.runId === right?.runId
    && left?.state === right?.state
    && left?.fixCount === right?.fixCount
    && left?.maxFixes === right?.maxFixes
    && JSON.stringify(left?.audit) === JSON.stringify(right?.audit)
}

async function hasCompleteExecutionFinalization(store, runId, manifest, ownerArtifact, planSha256) {
  try {
    if (manifest.runId !== runId || manifest.state !== 'REVIEWING'
      || manifest.handoff?.mode !== 'manual-handoff'
      || manifest.handoff.planSha256 !== planSha256) return false
    const state = await store.readJson({ runId, name: 'run-state.json' })
    const summaryArtifact = findArtifact(manifest, 'run-summary.json')
    const planArtifact = findArtifact(manifest, 'plan.json')
    const evidenceArtifact = findArtifact(manifest, 'evidence-manifest.json')
    if (findArtifact(manifest, 'execution-owner.json').sha256 !== ownerArtifact.sha256
      || evidenceArtifact.sha256 !== manifest.handoff.evidenceSha256) return false
    const [summary, planRecord, evidence, audit] = await Promise.all([
      store.verifyJson({ runId, name: summaryArtifact.name, sha256: summaryArtifact.sha256 }),
      store.verifyJson({ runId, name: planArtifact.name, sha256: planArtifact.sha256 }),
      store.verifyJson({ runId, name: evidenceArtifact.name, sha256: evidenceArtifact.sha256 }),
      store.readJson({ runId, name: 'audit-trace.json' }),
    ])
    if (state.state !== 'REVIEWING' || summary.runId !== runId || summary.state !== 'REVIEWING'
      || !sameRunStateSnapshot(state, audit)
      || planRecord.runId !== runId || planRecord.source !== 'manual-chatgpt-web-plan-relay'
      || evidence.runId !== runId || evidence.planSha256 !== planSha256
      || summary.handoff?.planSha256 !== planSha256
      || summary.handoff?.evidenceSha256 !== evidenceArtifact.sha256
      || evidence.projectState?.branch !== manifest.handoff.projectState?.branch
      || evidence.projectState?.commit !== manifest.handoff.projectState?.commit
      || evidence.projectState?.statusSha256 !== manifest.handoff.projectState?.statusSha256
      || evidence.projectState?.diffSha256 !== manifest.handoff.projectState?.diffSha256
      || evidence.projectState?.filesSha256 !== manifest.handoff.projectState?.filesSha256
      || JSON.stringify(evidence.test) !== JSON.stringify(summary.test)) return false
    const audited = new Map((audit.artifacts ?? []).map(artifact => [artifact.name, artifact]))
    for (const artifact of manifest.artifacts ?? []) {
      if (audited.get(artifact.name)?.sha256 !== artifact.sha256) return false
      await store.verifyArtifact({ runId, name: artifact.name, sha256: artifact.sha256 })
    }
    const manifestDescriptor = audited.get('run-manifest.json')
    if (!manifestDescriptor?.sha256) return false
    await store.verifyArtifact({ runId, name: manifestDescriptor.name, sha256: manifestDescriptor.sha256 })
    return true
  } catch {
    return false
  }
}

function equalFileHashes(left = {}, right = {}) {
  const sorted = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
  return sorted(left) === sorted(right)
}

function sameReviewerProject(reported, expected) {
  if (!reported || typeof reported !== 'object' || Array.isArray(reported)) return false
  return reported.branch === expected.branch
    && reported.commit === expected.commit
    && reported.dirty === expected.dirty
    && reported.statusSha256 === expected.statusSha256
    && reported.diffSha256 === expected.diffSha256
    && reported.filesSha256 === expected.filesSha256
}

function assertSuccessfulExecutorTurn(result) {
  if (result?.stopReason?.kind !== 'completed') {
    throw new DevLoopError('DSH_EXECUTION_INCOMPLETE', `DSH Agent turn did not complete: ${result?.stopReason?.kind ?? 'unknown'}`)
  }
  const events = result.events ?? []
  const approvals = events.filter(event => event.type === 'approval/asked')
  const decisions = events.filter(event => event.type === 'approval/decided')
  const unmatchedApproval = approvals.some(approval => {
    const decision = decisions.find(event => event.data?.id === approval.data?.id)
    return !decision || !String(decision.data?.outcome ?? '').startsWith('allowed')
  })
  const unmatchedDecision = decisions.some(decision => !approvals.some(approval => approval.data?.id === decision.data?.id))
  if (unmatchedApproval || unmatchedDecision) {
    throw new DevLoopError('DSH_TOOL_APPROVAL_FAILED', 'DSH native tool approval was rejected, unavailable, or cancelled')
  }
}

function externalExecutionTask(plan) {
  return [
    'Execute only the approved M2 plan below in the Host-configured project root.',
    `Included repository paths: ${JSON.stringify(plan.scope.includedPaths)}.`,
    `Excluded repository paths: ${JSON.stringify(plan.scope.excludedPaths)}.`,
    `Non-goals: ${JSON.stringify(plan.scope.nonGoals)}.`,
    `Execution requirements: ${JSON.stringify(plan.executionRequirements)}.`,
    'Do not modify files outside the included paths or any excluded path. Do not commit, push, merge, reset, or clean. Do not run tests; the Host runs the configured test command through DSH with native approval.',
    `Approved plan JSON:\n${JSON.stringify(plan)}`,
  ].join('\n')
}

function assertExternalExecutionScope(scope, baseline, evidence) {
  if (evidence.after?.commit !== baseline?.commit) {
    throw new DevLoopError('PROJECT_COMMIT_CHANGED', 'DSH Agent changed the project commit during the approved run')
  }
  const outOfScope = (evidence.summary?.changedFileNames ?? []).filter(file => {
    const included = scope.includedPaths.some(path => containsRepositoryPath(path, file))
    const excluded = scope.excludedPaths.some(path => containsRepositoryPath(path, file))
    return !included || excluded
  })
  if (outOfScope.length > 0) {
    throw new DevLoopError('EXECUTION_SCOPE_VIOLATION', `DSH Agent changed paths outside the approved scope: ${outOfScope.join(', ')}`)
  }
}

function containsRepositoryPath(scopePath, file) {
  return scopePath === '.' || file === scopePath || file.startsWith(`${scopePath}/`)
}
