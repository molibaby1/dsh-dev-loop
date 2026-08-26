import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { assertDecision, assertPlainObject, RunStateMachine } from './contracts.mjs'
import { createProjectZip, exposeArtifact, finalizeArtifact } from './artifacts.mjs'
import { captureGitSnapshot } from './evidence.mjs'

export class DevLoopController {
  constructor({ store, bridge, executor, evidenceCollector, maxFixes = 1, runIdFactory = () => `run-${randomUUID()}` } = {}) {
    if (!store || !bridge || !executor || !evidenceCollector) throw new Error('store, bridge, executor, and evidenceCollector are required')
    if (typeof evidenceCollector.runCommand !== 'function') throw new Error('evidenceCollector.runCommand is required')
    if (maxFixes !== 1) throw new Error('phase one requires exactly one automatic NEEDS_FIX budget')
    this.store = store
    this.bridge = bridge
    this.executor = executor
    this.evidenceCollector = evidenceCollector
    this.maxFixes = maxFixes
    this.runIdFactory = runIdFactory
  }

  async run({ projectRoot, problemPackage, approval = false, plannerPrompt, reviewerPrompt, executorTask, testCommand, signal } = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) throw new Error('projectRoot is required')
    if (!problemPackage || typeof problemPackage !== 'object' || Array.isArray(problemPackage)) throw new Error('problemPackage is required')
    const runId = this.runIdFactory()
    const machine = new RunStateMachine({ runId, maxFixes: this.maxFixes })
    const runRoot = await this.store.runRoot(runId)
    const snapshotRoot = join(runRoot, '.snapshots')
    const artifacts = []
    const persistState = async () => {
      await this.store.writeJson({
        runId,
        stage: 'state',
        name: 'run-state.json',
        value: machine.snapshot(),
        source: 'controller-state',
      })
    }
    const transition = async (next, metadata) => {
      machine.transition(next, metadata)
      await persistState()
    }
    const applyDecision = async (decision, metadata) => {
      machine.applyDecision(decision, metadata)
      await persistState()
    }
    const record = async descriptor => {
      const finalized = descriptor.sha256 ? descriptor : await finalizeArtifact(descriptor)
      artifacts.push(finalized)
      return finalized
    }
    const addJson = async (stage, name, value, source = 'controller') => record(await this.store.writeJson({ runId, stage, name, value, source }))
    const addText = async (stage, name, text, mime, source) => record(await this.store.writeText({ runId, stage, name, text, mime, source }))

    await transition('ANALYZING')
    const baseline = await captureGitSnapshot({
      repoRoot: projectRoot,
      runCommand: this.evidenceCollector.runCommand,
      snapshotRoot,
      snapshotName: 'baseline',
    })
    const problem = await addJson('problem', 'problem-package.json', {
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
    const plannerZip = await createProjectZip(this.store, { runId, projectRoot, stage: 'planner', source: 'wuxia-life' })
    const plannerArtifact = await record(plannerZip.artifact)
    const planner = await this.bridge.submit({
      runId,
      stage: 'planner',
      prompt: plannerPrompt ?? defaultPlannerPrompt(problemPackage),
      artifacts: [plannerArtifact],
      idempotencyKey: `${runId}:planner:${plannerArtifact.sha256}`,
    })
    const plannerResult = normalizePlannerResult(planner)
    await transition('PLAN_READY')
    const planArtifact = await addJson('plan', 'plan.json', plannerResult, 'planner')
    await transition('WAITING_FOR_APPROVAL')
    const approvalArtifact = await addJson('approval', 'approval.json', {
      runId,
      approved: Boolean(approval),
      approvedAt: approval ? new Date().toISOString() : null,
      source: approval ? 'human' : 'controller-default-deny',
      planSha256: planArtifact.sha256,
    }, 'human')
    if (!approval) return await this.finish({ machine, artifacts, runId, baseline, problem, plan: plannerResult, approval: approvalArtifact })

    let task = executorTask ?? plannerResult.executorTask
    if (typeof task !== 'string' || task.trim() === '') throw new Error('Planner result must contain executorTask or caller must provide executorTask')
    let round = 0
    while (true) {
      if (machine.state !== 'EXECUTING') await transition('EXECUTING', { round })
      const executorResult = await this.executor.execute({ runId, cwd: projectRoot, task, signal })
      await transition('COLLECTING_EVIDENCE', { round })
      const evidence = await this.evidenceCollector.collect({
        runId,
        round,
        repoRoot: projectRoot,
        executorReport: executorResult,
        baseline,
        signal,
        testCommand,
      })
      const finalizedEvidence = new Map()
      for (const artifact of evidence.artifacts) finalizedEvidence.set(artifact, await record(artifact))
      const evidenceArtifacts = (evidence.reviewArtifacts ?? evidence.artifacts)
        .map(artifact => finalizedEvidence.get(artifact))
        .filter(Boolean)
      const latestZip = await createProjectZip(this.store, {
        runId,
        projectRoot,
        stage: `reviewer-${round}`,
        source: 'wuxia-life',
        round,
      })
      const latestArtifact = await record(latestZip.artifact)
      await transition('REVIEWING', { round })
      const review = normalizeReviewResult(await this.bridge.submit({
        runId,
        stage: `reviewer-${round}`,
        prompt: reviewerPrompt ?? defaultReviewerPrompt(problemPackage),
        artifacts: [...evidenceArtifacts, latestArtifact],
        idempotencyKey: `${runId}:reviewer:${round}:${evidenceArtifacts.map(item => item.sha256).join(',')}:${latestArtifact.sha256}`,
      }))
      const reviewArtifactName = round === 0 ? 'review.json' : `review-round-${round}.json`
      const reviewArtifact = await addJson(`review-${round}`, reviewArtifactName, review, 'reviewer')
      await applyDecision(review.decision, { round, reviewSha256: reviewArtifact.sha256 })
      if (machine.state !== 'EXECUTING') {
        return await this.finish({ machine, artifacts, runId, baseline, problem, plan: plannerResult, approval: approvalArtifact, review })
      }
      round += 1
      task = review.nextTask ?? task
    }
  }

  async finish({ machine, artifacts, runId, baseline, problem, plan, approval, review } = {}) {
    await this.store.writeJson({
      runId,
      stage: 'state',
      name: 'run-state.json',
      value: machine.snapshot(),
      source: 'controller-state',
    })
    const manifest = await this.store.writeJson({
      runId,
      stage: 'manifest',
      name: 'run-manifest.json',
      value: {
        runId,
        state: machine.state,
        fixCount: machine.fixCount,
        baseline: {
          commit: baseline.commit,
          dirty: baseline.dirty,
          status: baseline.status,
        },
        artifacts: artifacts.map(exposeArtifact),
        phases: { problem: exposeArtifact(problem), plan, approval, review: review ?? null },
      },
      source: 'controller',
    })
    const manifestArtifact = await finalizeArtifact(manifest)
    artifacts.push(manifestArtifact)
    const audit = await this.store.writeJson({
      runId,
      stage: 'audit',
      name: 'audit-trace.json',
      value: {
        ...machine.snapshot(),
        artifacts: artifacts.map(exposeArtifact),
      },
      source: 'controller',
    })
    const auditArtifact = await finalizeArtifact(audit)
    artifacts.push(auditArtifact)
    return {
      runId,
      state: machine.state,
      decision: review?.decision ?? null,
      fixCount: machine.fixCount,
      artifacts: artifacts.map(exposeArtifact),
      audit: machine.snapshot(),
    }
  }
}

function normalizePlannerResult(response) {
  const value = response?.result ?? response
  const result = assertPlainObject(value, 'Planner result')
  rejectUnknownKeys(result, ['type', 'plan', 'executorTask', 'constraints', 'tests', 'risks'], 'Planner result')
  if (result.type !== undefined && result.type !== 'plan') throw new Error('Planner result type must be plan')
  const plan = result.plan && typeof result.plan === 'object' && !Array.isArray(result.plan) ? result.plan : result
  const executorTask = result.executorTask ?? plan.executorTask
  if (typeof executorTask !== 'string' || executorTask.trim() === '') throw new Error('Planner result executorTask must be non-empty')
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
  return `You are Reviewer only. Return strict JSON with decision in ACCEPTED, NEEDS_FIX, NEEDS_REPLAN, DEFER, ESCALATE. Do not execute tools. Problem package:\n${JSON.stringify(problemPackage)}`
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
