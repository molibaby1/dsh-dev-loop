import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '../src/artifacts.mjs'
import { DevLoopController } from '../src/controller.mjs'
import { createEvidenceCollector, createGitEvidenceAdapter } from '../src/evidence.mjs'
import { createDshDevLoopController } from '../src/host.mjs'
import { createPreflightChecker } from '../src/preflight.mjs'
import { apply } from '../src/plugin.mjs'
import { apply as applyLivePlugin } from '../src/live-plugin.mjs'
import { parseDevLoopM2Input } from '../src/command.mjs'
import { claimStagedM2Review } from '../src/plan-inbox.mjs'

const fixedPlannerText = `目标：绑定当前仓库的提交失败反馈
修改范围：
- src/submit.mjs
排除路径：
- src/generated.mjs
非目标：
- 不改变权限配置
验收条件：
- 提交失败时显示错误信息
执行要求：
- 先核对当前实现和测试
上下文来源：
- GitHub dev 和本地工作区
Planner 观察到的分支：
dev
Planner 观察到的 commit：
0123456789abcdef0123456789abcdef01234567
DSH Agent 执行任务：
增加提交失败提示并运行验收测试。`

test('plugin registers a separate manual M2 handoff command', () => {
  const commands = []
  const ctx = {
    agents: {},
    provide() {},
    inject(_dependencies, callback) {
      callback({ commands: { register: command => commands.push(command) } })
    },
  }

  apply(ctx, { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts' })

  assert.deepEqual(commands.map(command => command.name), ['dev-loop', 'dev-loop-m2'])
  assert.match(commands[1].input.hint, /领取待审方案/u)
  assert.match(commands[1].input.hint, /领取复审结果/u)
})

test('live plugin advertises the staged JSON claim command and text compatibility route', () => {
  const commands = []
  const ctx = {
    inject(_dependencies, callback) {
      callback({ commands: { register: command => commands.push(command) } })
    },
  }

  applyLivePlugin(ctx)

  assert.equal(commands[1].name, 'dev-loop-m2')
  assert.match(commands[1].input.hint, /领取待审方案/u)
  assert.match(commands[1].input.hint, /领取复审结果/u)
  assert.match(commands[1].input.hint, /粘贴固定标题方案/u)
})

test('M2 handoff text cannot inline approval or override trusted Host settings', () => {
  assert.throws(() => parseDevLoopM2Input(fixedPlannerText.replace('非目标：', '批准：true\n非目标：')), /不支持的标题/)
  assert.throws(() => parseDevLoopM2Input(fixedPlannerText.replace('上下文来源：', 'projectRoot：/tmp/other\n上下文来源：')), /不支持的标题/)
})

test('M2 plan rejects repository paths that escape the trusted project root', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()
  const plan = { ...fixture.plan, scope: { ...fixture.plan.scope, includedPaths: ['../outside.txt'] } }

  await assert.rejects(() => controller.submitExternalPlan({ plan }), /safe repository-relative paths/)
  assert.equal(fixture.calls.executor, 0)
})

test('manual M2 Controller does not construct or require the legacy Bridge client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-host-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  await mkdir(projectRoot)
  await mkdir(artifactRoot)

  const controller = await createDshDevLoopController({
    ctx: { agents: {} },
    config: { mode: 'manual-handoff', projectRoot, artifactRoot },
  })

  assert.equal(controller.mode, 'manual-handoff')
  assert.equal(controller.bridge, undefined)
})

test('external plan relay persists for separate approval without ZIP, Bridge, or DSH execution', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()

  const result = await controller.submitExternalPlan({ plan: fixture.plan })

  assert.equal(result.state, 'WAITING_FOR_APPROVAL')
  assert.equal(fixture.calls.executor, 0)
  assert.equal(fixture.calls.test, 0)
  assert.equal(fixture.calls.zip, 0)
  assert.equal(fixture.calls.bridge, 0)
  assert.equal(result.handoff.source, 'manual-chatgpt-web-plan-relay')
  assert.match(result.handoff.planSha256, /^[a-f0-9]{64}$/)
  assert.equal((await fixture.store.readJson({ runId: result.runId, name: 'run-state.json' })).state, 'WAITING_FOR_APPROVAL')
  const files = await readdir(join(fixture.artifactRoot, result.runId))
  assert.ok(!files.some(file => file.endsWith('.zip')))
  const planRecord = await fixture.store.verifyJson({ runId: result.runId, name: 'plan.json', sha256: result.handoff.planSha256 })
  assert.equal(planRecord.source, 'manual-chatgpt-web-plan-relay')
})

test('a staged plan is claimed once and bound to the trusted DSH session', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController({ sessionId: 'trusted-session-from-invocation' })
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  await mkdir(inbox)
  await writeFile(join(inbox, 'plan.json'), `${JSON.stringify(fixture.plan)}\n`)

  const result = await controller.submitPendingExternalPlan()

  assert.equal(result.state, 'WAITING_FOR_APPROVAL')
  assert.equal(fixture.calls.executor, 0)
  assert.equal(fixture.calls.test, 0)
  const request = await fixture.store.readJson({ runId: result.runId, name: 'run-request.json' })
  assert.equal(request.sessionId, 'trusted-session-from-invocation')
  assert.equal((await fixture.store.readJson({ runId: result.runId, name: 'run-state.json' })).state, 'WAITING_FOR_APPROVAL')
  assert.ok((await readdir(inbox)).some(name => /^claimed-[a-f0-9-]+\.json$/u.test(name)))
  await assert.rejects(() => controller.submitPendingExternalPlan(), /没有待领取方案/u)
  assert.equal((await fixture.store.listRunIds()).length, 1)
  assert.equal(fixture.calls.executor, 0)
  const nextPlan = `${JSON.stringify(fixture.plan)}\n`
  await writeFile(join(inbox, 'plan.json'), nextPlan)
  await assert.rejects(() => controller.submitPendingExternalPlan(), /已有未结束的 M2 任务/u)
  assert.equal(await readFile(join(inbox, 'plan.json'), 'utf8'), nextPlan)
  assert.equal((await fixture.store.listRunIds()).length, 1)
})

test('an empty claim creates only the fixed Host inbox and reports where to stage the file', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()
  const inbox = join(fixture.artifactRoot, '.m2-inbox')

  await assert.rejects(() => controller.submitPendingExternalPlan(), error => {
    assert.match(error.message, /没有待领取方案/u)
    assert.ok(error.message.includes(inbox))
    assert.match(error.message, /plan\.partial\.json/u)
    return true
  })

  assert.deepEqual(await readdir(fixture.artifactRoot), ['.m2-inbox'])
  assert.equal((await fixture.store.listRunIds()).length, 0)
})

test('a staged plan with stale Git context is retained as a failed Controller run without execution', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController({ sessionId: 'stale-session' })
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  await mkdir(inbox)
  await writeFile(join(inbox, 'plan.json'), `${JSON.stringify({
    ...fixture.plan,
    observedContext: { ...fixture.plan.observedContext, commit: '0'.repeat(40) },
  })}\n`)

  const result = await controller.submitPendingExternalPlan()

  assert.equal(result.state, 'FAILED')
  assert.equal(result.diagnostic.code, 'PLAN_CONTEXT_MISMATCH')
  assert.equal(fixture.calls.executor, 0)
  assert.equal(fixture.calls.test, 0)
  assert.equal((await fixture.store.readJson({ runId: result.runId, name: 'run-state.json' })).state, 'FAILED')
  assert.ok((await readdir(inbox)).some(name => name.startsWith('claimed-')))
})

test('a staged plan rejects unsafe repository paths while preserving the input', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  await mkdir(inbox)
  const unsafePlan = {
    ...fixture.plan,
    scope: { ...fixture.plan.scope, includedPaths: ['../outside.txt'] },
  }
  await writeFile(join(inbox, 'plan.json'), `${JSON.stringify(unsafePlan)}\n`)

  await assert.rejects(() => controller.submitPendingExternalPlan(), /safe repository-relative paths/u)

  assert.equal(fixture.calls.executor, 0)
  assert.equal((await fixture.store.listRunIds()).length, 0)
  const claimedFile = (await readdir(inbox)).find(name => name.startsWith('claimed-'))
  assert.ok(claimedFile)
  assert.deepEqual(JSON.parse(await readFile(join(inbox, claimedFile), 'utf8')), unsafePlan)
})

test('a staged plan cannot select Host roots, Session, permissions, or approval', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  await mkdir(inbox)
  const untrustedPlan = {
    ...fixture.plan,
    projectRoot: '/tmp/untrusted-project',
    sessionId: 'forged-session',
    permissionPreset: 'danger-full-access',
    approve: true,
  }
  await writeFile(join(inbox, 'plan.json'), `${JSON.stringify(untrustedPlan)}\n`)

  await assert.rejects(() => controller.submitPendingExternalPlan(), /unsupported fields/u)

  assert.equal(fixture.calls.executor, 0)
  assert.equal((await fixture.store.listRunIds()).length, 0)
  const claimedFile = (await readdir(inbox)).find(name => name.startsWith('claimed-'))
  assert.ok(claimedFile)
  assert.deepEqual(JSON.parse(await readFile(join(inbox, claimedFile), 'utf8')), untrustedPlan)
})

test('a symlinked staged plan is rejected without reading its target', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  const outside = join(fixture.root, 'outside-plan.json')
  await mkdir(inbox)
  await writeFile(outside, `${JSON.stringify(fixture.plan)}\n`)
  await symlink(outside, join(inbox, 'plan.json'))

  await assert.rejects(() => controller.submitPendingExternalPlan(), /regular file/u)

  assert.equal((await readFile(outside, 'utf8')), `${JSON.stringify(fixture.plan)}\n`)
  assert.deepEqual(await readdir(inbox), ['plan.json'])
  assert.equal((await fixture.store.listRunIds()).length, 0)
  assert.equal(fixture.calls.executor, 0)
})

test('a symlinked inbox directory cannot redirect the Host plan intake outside artifact storage', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  const outside = join(fixture.root, 'outside-inbox')
  await mkdir(outside)
  await writeFile(join(outside, 'plan.json'), `${JSON.stringify(fixture.plan)}\n`)
  await symlink(outside, inbox)

  await assert.rejects(() => controller.submitPendingExternalPlan(), /regular directory/u)

  assert.deepEqual(await readdir(outside), ['plan.json'])
  assert.equal((await fixture.store.listRunIds()).length, 0)
  assert.equal(fixture.calls.executor, 0)
})

test('malformed JSON is claimed once and retained for diagnosis', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  await mkdir(inbox)
  await writeFile(join(inbox, 'plan.json'), '{ malformed')

  await assert.rejects(() => controller.submitPendingExternalPlan(), /已领取方案无效/u)

  const claimedFile = (await readdir(inbox)).find(name => name.startsWith('claimed-'))
  assert.ok(claimedFile)
  assert.equal(await readFile(join(inbox, claimedFile), 'utf8'), '{ malformed')
  assert.equal((await fixture.store.listRunIds()).length, 0)
  assert.equal(fixture.calls.executor, 0)
})

test('a partial staged plan is not readable or claimable', async t => {
  const fixture = await createFixture(t)
  const controller = await fixture.createController()
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  await mkdir(inbox)
  await writeFile(join(inbox, 'plan.partial.json'), `${JSON.stringify(fixture.plan)}\n`)

  await assert.rejects(() => controller.submitPendingExternalPlan(), /没有待领取方案/u)

  assert.deepEqual(await readdir(inbox), ['plan.partial.json'])
  assert.equal((await fixture.store.listRunIds()).length, 0)
  assert.equal(fixture.calls.executor, 0)
})

test('a staged Reviewer result uses the current Session REVIEWING run and existing review validation', async t => {
  const fixture = await createFixture(t)
  const { submitted, approved } = await createReviewingRun(fixture)
  const input = stagedReview(approved.handoff.reviewReceipt)
  const inbox = await stageReviewFile(fixture, input)
  const callsBeforeReview = { ...fixture.calls }

  const result = await (await fixture.createController()).submitPendingExternalReview()

  assert.equal(result.state, 'COMPLETE')
  assert.equal(result.runId, submitted.runId)
  assert.equal(result.decision, 'ACCEPTED')
  assert.equal(result.handoff.reviewSource, 'manual-chatgpt-web-review-relay')
  assert.equal(fixture.calls.executor, callsBeforeReview.executor, 'receiving a review must not invoke the DSH Agent')
  assert.equal(fixture.calls.test, callsBeforeReview.test)
  assert.ok(result.stagedReviewPath.endsWith('.json'))
  assert.deepEqual((await readdir(inbox)).filter(name => name.startsWith('claimed-review-')).length, 1)
  const review = await fixture.store.readJson({ runId: submitted.runId, name: 'review.json' })
  assert.deepEqual({ receipt: review.receipt, decision: review.decision, summary: review.summary, findings: review.findings }, {
    receipt: input.receipt,
    decision: input.decision,
    summary: input.summary,
    findings: input.findings,
  })

  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    /没有待领取复审结果/u,
  )
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-summary.json' })).decision, 'ACCEPTED')
})

test('a Reviewer result cannot select a Run from another DSH Session or a non-REVIEWING Run', async t => {
  const fixture = await createFixture(t)
  const { submitted, approved } = await createReviewingRun(fixture, { sessionId: 'session-a' })
  const inbox = await stageReviewFile(fixture, stagedReview(approved.handoff.reviewReceipt))

  await assert.rejects(
    () => fixture.createController({ sessionId: 'session-b' }).then(controller => controller.submitPendingExternalReview()),
    error => error.code === 'RUN_SESSION_CANDIDATE_MISSING',
  )
  assert.ok((await readdir(inbox)).includes('review.json'), 'wrong-session lookup leaves the staged result available')
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'REVIEWING')

  const waiting = await (await fixture.createController({ sessionId: 'session-c' })).submitExternalPlan({ plan: fixture.plan })
  await rm(join(inbox, 'review.json'))
  await writeFile(join(inbox, 'review.json'), `${JSON.stringify(stagedReview('unused-receipt'))}\n`)
  await assert.rejects(
    () => fixture.createController({ sessionId: 'session-c' }).then(controller => controller.submitPendingExternalReview()),
    error => error.code === 'RUN_SESSION_CANDIDATE_MISSING',
  )
  assert.equal((await fixture.store.readJson({ runId: waiting.runId, name: 'run-state.json' })).state, 'WAITING_FOR_APPROVAL')
  assert.ok((await readdir(inbox)).includes('review.json'))
  assert.equal(fixture.calls.executor, 1)
})

test('a staged Reviewer result with the wrong receipt is rejected by the existing Controller checks', async t => {
  const fixture = await createFixture(t)
  const { submitted, approved } = await createReviewingRun(fixture)
  const inbox = await stageReviewFile(fixture, stagedReview('0'.repeat(22)))
  const callsBeforeReview = { ...fixture.calls }

  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    error => error.code === 'REVIEW_RECEIPT_MISMATCH',
  )

  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'REVIEWING')
  assert.equal(fixture.calls.executor, callsBeforeReview.executor)
  assert.ok((await readdir(inbox)).some(name => name.startsWith('claimed-review-')))
  assert.notEqual(approved.handoff.reviewReceipt, '0'.repeat(22))
})

test('a staged Reviewer result is stopped when its evidence is stale', async t => {
  const fixture = await createFixture(t)
  const { submitted, approved } = await createReviewingRun(fixture)
  const inbox = await stageReviewFile(fixture, stagedReview(approved.handoff.reviewReceipt))
  await writeFile(join(fixture.projectRoot, 'reviewer-stale.txt'), 'changed after evidence\n')
  runGit(fixture.projectRoot, ['add', 'reviewer-stale.txt'])
  runGit(fixture.projectRoot, ['commit', '--quiet', '-m', 'change after evidence'])
  const callsBeforeReview = { ...fixture.calls }

  const result = await (await fixture.createController()).submitPendingExternalReview()

  assert.equal(result.state, 'STOPPED')
  assert.equal(result.diagnostic.code, 'EVIDENCE_STALE')
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'STOPPED')
  assert.equal(fixture.calls.executor, callsBeforeReview.executor)
  assert.ok((await readdir(inbox)).some(name => name.startsWith('claimed-review-')))
})

test('staged Reviewer input ignores partial files and retains malformed or unsupported input after claiming', async t => {
  const fixture = await createFixture(t)
  await createReviewingRun(fixture)
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  await mkdir(inbox)
  await writeFile(join(inbox, 'review.partial.json'), `${JSON.stringify(stagedReview('receipt'))}\n`)
  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    /没有待领取复审结果/u,
  )
  assert.deepEqual(await readdir(inbox), ['review.partial.json'])

  await writeFile(join(inbox, 'review.json'), '{ malformed')
  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    /已领取复审结果无效/u,
  )
  const malformed = (await readdir(inbox)).find(name => name.startsWith('claimed-review-'))
  assert.equal(await readFile(join(inbox, malformed), 'utf8'), '{ malformed')

  await writeFile(join(inbox, 'review.json'), `${JSON.stringify({
    ...stagedReview('receipt'),
    runId: 'forged-run',
    sessionId: 'forged-session',
    projectRoot: '/untrusted/project',
    artifactRoot: '/untrusted/artifacts',
    permissions: 'danger-full-access',
    approve: true,
    path: '/untrusted/review.json',
  })}\n`)
  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    /unsupported fields: runId, sessionId, projectRoot, artifactRoot, permissions, approve, path/u,
  )
  await writeFile(join(inbox, 'review.json'), `${JSON.stringify({ schema: 1, receipt: 'receipt' })}\n`)
  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    /must contain exactly schema, receipt, decision, summary, and findings/u,
  )
  await writeFile(join(inbox, 'review.json'), `${JSON.stringify(stagedReview('receipt', { decision: 'ACCEPT' }))}\n`)
  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    /invalid review decision: ACCEPT/u,
  )
  assert.equal((await fixture.store.listRunIds()).length, 1)
  assert.equal(fixture.calls.executor, 1)
})

test('staged Reviewer inbox rejects symlinked directories and result files', async t => {
  const fixture = await createFixture(t)
  await createReviewingRun(fixture)
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  const outside = join(fixture.root, 'outside-review.json')
  await writeFile(outside, `${JSON.stringify(stagedReview('outside-receipt'))}\n`)
  await symlink(outside, inbox)

  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    /regular directory/u,
  )
  assert.equal(await readFile(outside, 'utf8'), `${JSON.stringify(stagedReview('outside-receipt'))}\n`)
  await rm(inbox)
  await mkdir(inbox)
  await symlink(outside, join(inbox, 'review.json'))
  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitPendingExternalReview()),
    /regular file/u,
  )
  assert.equal(await readFile(outside, 'utf8'), `${JSON.stringify(stagedReview('outside-receipt'))}\n`)
  assert.equal(fixture.calls.executor, 1)
})

test('concurrent staged Reviewer claims record at most one decision', async t => {
  const fixture = await createFixture(t)
  const { submitted, approved } = await createReviewingRun(fixture)
  const inbox = await stageReviewFile(fixture, stagedReview(approved.handoff.reviewReceipt))
  const controllers = await Promise.all([fixture.createController(), fixture.createController()])

  const claims = await Promise.allSettled(controllers.map(controller => controller.submitPendingExternalReview()))

  assert.equal(claims.filter(claim => claim.status === 'fulfilled').length, 1)
  assert.equal(claims.filter(claim => claim.status === 'rejected').length, 1)
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-summary.json' })).decision, 'ACCEPTED')
  assert.equal((await readdir(inbox)).filter(name => name.startsWith('claimed-review-')).length, 1)
  assert.equal(fixture.calls.executor, 1)
})

test('the shared file claim primitive atomically moves a staged Reviewer input once', async t => {
  const fixture = await createFixture(t)
  const input = stagedReview('fixture-receipt')
  const inbox = await stageReviewFile(fixture, input)

  const claims = await Promise.allSettled([
    claimStagedM2Review(fixture.artifactRoot),
    claimStagedM2Review(fixture.artifactRoot),
  ])

  assert.equal(claims.filter(claim => claim.status === 'fulfilled').length, 1)
  assert.equal(claims.filter(claim => claim.status === 'rejected').length, 1)
  assert.deepEqual(claims.find(claim => claim.status === 'fulfilled').value.review, input)
  assert.equal((await readdir(inbox)).filter(name => name.startsWith('claimed-review-')).length, 1)
  assert.ok(!(await readdir(inbox)).includes('review.json'))
})

test('a staged non-ACCEPTED Reviewer decision follows the existing stop strategy', async t => {
  const fixture = await createFixture(t)
  const { approved } = await createReviewingRun(fixture)
  await stageReviewFile(fixture, stagedReview(approved.handoff.reviewReceipt, { decision: 'NEEDS_FIX' }))
  const stopped = await (await fixture.createController()).submitPendingExternalReview()
  assert.equal(stopped.state, 'STOPPED')
  assert.equal(stopped.decision, 'NEEDS_FIX')
  assert.equal(fixture.calls.executor, 1)
})

async function createReviewingRun(fixture, { sessionId = 'fixture-session' } = {}) {
  const submitted = await (await fixture.createController({ sessionId })).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController({ sessionId })).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })
  return { submitted, approved }
}

function stagedReview(receipt, overrides = {}) {
  return {
    schema: 1,
    receipt,
    decision: 'ACCEPTED',
    summary: '核对了当前 Run 的差异、测试和审核证据。',
    findings: [],
    ...overrides,
  }
}

async function stageReviewFile(fixture, review) {
  const inbox = join(fixture.artifactRoot, '.m2-inbox')
  await mkdir(inbox, { recursive: true })
  const partial = join(inbox, 'review.partial.json')
  await writeFile(partial, `${JSON.stringify(review)}\n`)
  await rename(partial, join(inbox, 'review.json'))
  return inbox
}

test('manual plan ownership is persisted by trusted DSH session and restored by a new Controller', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const request = await fixture.store.readJson({ runId: submitted.runId, name: 'run-request.json' })
  assert.equal(request.sessionId, 'fixture-session')

  const restored = await fixture.createController()
  const candidate = await restored.findExternalRunForSession({ operation: 'approve' })
  assert.deepEqual(candidate, {
    runId: submitted.runId,
    state: 'WAITING_FOR_APPROVAL',
    planSha256: submitted.handoff.planSha256,
  })
  await assert.rejects(
    () => fixture.createController({ sessionId: 'another-session' }).then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    error => error.code === 'RUN_SESSION_CANDIDATE_MISSING',
  )
  await assert.rejects(
    () => fixture.createController({ sessionId: 'another-session' }).then(controller => controller.approveExternalPlan({
      runId: submitted.runId,
      planSha256: submitted.handoff.planSha256,
    })),
    error => error.code === 'RUN_SESSION_MISMATCH',
  )
})

test('session operations reject zero and multiple matching candidates', async t => {
  const fixture = await createFixture(t)
  const empty = await fixture.createController()
  await assert.rejects(
    () => empty.findExternalRunForSession({ operation: 'status' }),
    error => error.code === 'RUN_SESSION_CANDIDATE_MISSING',
  )

  const first = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const second = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  assert.notEqual(first.runId, second.runId)
  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    error => error.code === 'RUN_SESSION_CANDIDATE_AMBIGUOUS',
  )
})

test('session candidate lookup rejects unsafe run symlinks and damaged persisted state', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const outside = join(fixture.root, 'outside-run')
  await mkdir(outside)
  await symlink(outside, join(fixture.artifactRoot, 'unsafe-run'))
  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    /symlink|symbolic link|unsafe run/u,
  )
  await rm(join(fixture.artifactRoot, 'unsafe-run'))
  await fixture.store.writeJson({
    runId: submitted.runId,
    stage: 'state',
    name: 'run-state.json',
    value: { runId: 'other-run', state: 'WAITING_FOR_APPROVAL' },
  })
  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    /runId|state|corrupt/u,
  )
})

test('session candidate lookup rejects an incompatible persisted manifest state', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const manifest = await fixture.store.readJson({ runId: submitted.runId, name: 'run-manifest.json' })
  manifest.state = 'REVIEWING'
  await fixture.store.writeJson({ runId: submitted.runId, stage: 'manifest', name: 'run-manifest.json', value: manifest })

  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    error => error.code === 'RUN_RECORD_MISMATCH',
  )
})

test('a settled early failed submission does not block later plans in the same or another session', async t => {
  const fixture = await createFixture(t)
  const stalePlan = {
    ...fixture.plan,
    observedContext: { ...fixture.plan.observedContext, commit: '0'.repeat(40) },
  }
  const failed = await (await fixture.createController({ sessionId: 'session-a' })).submitExternalPlan({ plan: stalePlan })
  assert.equal(failed.state, 'FAILED')
  assert.equal(failed.summary.hasModifiedProject, false)
  assert.equal(fixture.calls.executor, 0)
  assert.equal((await fixture.store.readJson({ runId: failed.runId, name: 'run-state.json' })).state, 'FAILED')
  await assert.rejects(
    fixture.store.readJson({ runId: failed.runId, name: 'run-request.json' }),
    { code: 'ENOENT' },
  )

  const sameSessionPlan = await (await fixture.createController({ sessionId: 'session-a' })).submitExternalPlan({ plan: fixture.plan })
  assert.equal(sameSessionPlan.state, 'WAITING_FOR_APPROVAL')
  const sameSessionCandidate = await (await fixture.createController({ sessionId: 'session-a' })).findExternalRunForSession({ operation: 'approve' })
  assert.deepEqual(sameSessionCandidate, {
    runId: sameSessionPlan.runId,
    state: 'WAITING_FOR_APPROVAL',
    planSha256: sameSessionPlan.handoff.planSha256,
  })
  assert.equal(fixture.calls.executor, 0, 'candidate lookup must not approve or execute the plan')

  const otherSessionPlan = await (await fixture.createController({ sessionId: 'session-b' })).submitExternalPlan({ plan: fixture.plan })
  const otherSessionCandidate = await (await fixture.createController({ sessionId: 'session-b' })).findExternalRunForSession({ operation: 'approve' })
  assert.deepEqual(otherSessionCandidate, {
    runId: otherSessionPlan.runId,
    state: 'WAITING_FOR_APPROVAL',
    planSha256: otherSessionPlan.handoff.planSha256,
  })
  assert.equal(fixture.calls.executor, 0, 'another session must be able to discover its own plan without executing it')

  const approved = await (await fixture.createController({ sessionId: 'session-a' })).approveExternalPlan({
    runId: sameSessionCandidate.runId,
    planSha256: sameSessionCandidate.planSha256,
  })
  assert.equal(approved.state, 'REVIEWING')
  assert.equal(fixture.calls.executor, 1, 'execution starts only after explicit approval')
})

test('terminal early failures are skipped only when their finalization records agree', async t => {
  const fixture = await createFixture(t)
  const failed = await (await fixture.createController()).submitExternalPlan({
    plan: { ...fixture.plan, observedContext: { ...fixture.plan.observedContext, commit: '0'.repeat(40) } },
  })
  assert.equal(failed.state, 'FAILED')
  const manifest = await fixture.store.readJson({ runId: failed.runId, name: 'run-manifest.json' })
  const summaryDescriptor = manifest.artifacts.find(artifact => artifact.name === 'run-summary.json')
  assert.ok(summaryDescriptor)
  assert.ok(manifest.artifacts.some(artifact => artifact.name === 'diagnostic.json'))

  manifest.state = 'CANCELLED'
  await fixture.store.writeJson({ runId: failed.runId, stage: 'manifest', name: 'run-manifest.json', value: manifest })
  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    error => error.code === 'RUN_RECORD_MISMATCH',
  )
})

test('terminal runs without settled execution and audit records are not skipped during candidate lookup', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController()).approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
  const stopped = await (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'NEEDS_FIX',
    summary: 'Record a terminal review without scheduling another execution.',
    findings: ['The fixture review requests a follow-up.'],
  })
  assert.equal(stopped.state, 'STOPPED')

  const active = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const settledPath = join(fixture.artifactRoot, stopped.runId, 'execution-owner-settled.json')
  const settledBytes = await readFile(settledPath)
  await rm(settledPath)
  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    { code: 'ENOENT' },
  )
  await writeFile(settledPath, settledBytes)

  const candidate = await (await fixture.createController()).findExternalRunForSession({ operation: 'approve' })
  assert.equal(candidate.runId, active.runId)
  await rm(join(fixture.artifactRoot, stopped.runId, 'audit-trace.json'))
  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    { code: 'ENOENT' },
  )
  assert.equal(active.state, 'WAITING_FOR_APPROVAL')
  assert.equal(fixture.calls.executor, 1, 'candidate lookup must not start the active plan')
})

test('terminal candidate lookup rejects summary that contradicts the verified execution audit', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController()).approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
  const stopped = await (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'NEEDS_FIX',
    summary: 'The terminal fixture really did execute before stopping.',
    findings: ['Follow-up is recorded without another execution.'],
  })
  assert.equal(stopped.state, 'STOPPED')
  const active = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const runRoot = join(fixture.artifactRoot, stopped.runId)
  const manifest = await fixture.store.readJson({ runId: stopped.runId, name: 'run-manifest.json' })
  const audit = await fixture.store.readJson({ runId: stopped.runId, name: 'audit-trace.json' })
  const summary = await fixture.store.readJson({ runId: stopped.runId, name: 'run-summary.json' })
  const state = await fixture.store.readJson({ runId: stopped.runId, name: 'run-state.json' })
  assert.ok(state.audit.some(entry => entry.to === 'EXECUTING'))
  assert.equal(summary.hasModifiedProject, true)

  summary.hasModifiedProject = false
  const summaryBytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(join(runRoot, 'run-summary.json'), summaryBytes)
  const refreshDescriptor = (artifacts, name, bytes) => {
    const descriptor = artifacts.find(artifact => artifact.name === name)
    assert.ok(descriptor, `${name} descriptor must be present`)
    descriptor.bytes = bytes.byteLength
    descriptor.sha256 = createHash('sha256').update(bytes).digest('hex')
    return descriptor
  }
  refreshDescriptor(manifest.artifacts, 'run-summary.json', summaryBytes)
  refreshDescriptor(audit.artifacts, 'run-summary.json', summaryBytes)

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(runRoot, 'run-manifest.json'), manifestBytes)
  const manifestDescriptor = refreshDescriptor(audit.artifacts, 'run-manifest.json', manifestBytes)
  await writeFile(join(runRoot, 'audit-trace.json'), `${JSON.stringify(audit, null, 2)}\n`)
  assert.equal(await fixture.store.verifyJson({
    runId: stopped.runId,
    name: 'run-summary.json',
    sha256: manifest.artifacts.find(artifact => artifact.name === 'run-summary.json').sha256,
  }).then(record => record.hasModifiedProject), false)
  assert.equal(await fixture.store.verifyArtifact({ runId: stopped.runId, name: 'run-manifest.json', sha256: manifestDescriptor.sha256 }), true)

  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    error => error.code === 'RUN_RECORD_MISMATCH',
  )
  assert.equal(active.state, 'WAITING_FOR_APPROVAL')
  assert.equal(fixture.calls.executor, 1, 'contradictory terminal history must not trigger another execution')
})

test('active session candidates still require both request and plan artifacts', async t => {
  for (const name of ['run-request.json', 'plan.json']) {
    await t.test(name, async subtest => {
      const fixture = await createFixture(subtest)
      const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
      await rm(join(fixture.artifactRoot, submitted.runId, name))

      await assert.rejects(
        () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
        { code: 'ENOENT' },
      )
      assert.equal(fixture.calls.executor, 0)
    })
  }
})

test('manual approval executes once, persists evidence for a new Controller, then accepts correlated review', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  assert.equal(approved.state, 'REVIEWING', JSON.stringify(approved.diagnostic))
  assert.equal(fixture.calls.executor, 1)
  assert.equal(fixture.calls.test, 1)
  assert.equal(fixture.calls.zip, 0)
  assert.equal(fixture.calls.bridge, 0)
  assert.equal(await readFile(join(fixture.projectRoot, 'result.txt'), 'utf8'), 'fixture change\n')
  assert.match(approved.handoff.evidenceSha256, /^[a-f0-9]{64}$/)
  assert.match(approved.handoff.reviewReceipt, /^[A-Za-z0-9_-]{22}$/)
  const approvedManifest = await fixture.store.readJson({ runId: submitted.runId, name: 'run-manifest.json' })
  const receiptDescriptor = approvedManifest.artifacts.find(artifact => artifact.name === 'review-receipt.json')
  const receiptRecord = await fixture.store.verifyJson({ runId: submitted.runId, name: 'review-receipt.json', sha256: receiptDescriptor.sha256 })
  assert.equal(receiptRecord.receipt, approved.handoff.reviewReceipt)
  assert.equal(receiptRecord.runId, submitted.runId)
  assert.equal(receiptRecord.planSha256, submitted.handoff.planSha256)
  assert.equal(receiptRecord.evidenceSha256, approved.handoff.evidenceSha256)
  const evidence = await fixture.store.verifyJson({
    runId: submitted.runId,
    name: 'evidence-manifest.json',
    sha256: approved.handoff.evidenceSha256,
  })
  assert.deepEqual(receiptRecord.projectState, evidence.projectState)
  assert.equal(evidence.test.ok, true)
  assert.ok(evidence.artifacts.some(artifact => artifact.name === 'executor-report.md'))
  assert.ok(evidence.artifacts.some(artifact => artifact.name === 'git-diff.patch'))
  assert.ok(evidence.artifacts.some(artifact => artifact.name === 'test-result.json'))

  await assert.rejects(() => (async () => {
    const controller = await fixture.createController()
    return controller.submitExternalReview({
      runId: submitted.runId,
      receipt: '0'.repeat(22),
      decision: 'ACCEPTED',
      summary: 'Incorrect receipt.',
      findings: [],
    })
  })(), error => error.code === 'REVIEW_RECEIPT_MISMATCH')

  const completed = await (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'ACCEPTED',
    summary: 'Reviewed the matching report and project state.',
    findings: [],
  })

  assert.equal(completed.state, 'COMPLETE')
  assert.equal(completed.decision, 'ACCEPTED')
  assert.equal(completed.handoff.reviewSource, 'manual-chatgpt-web-review-relay')
  assert.equal(completed.summary.changedFiles, 1)
  assert.deepEqual(completed.summary.changedFileNames, ['result.txt'])
  assert.equal(fixture.calls.executor, 1)
  assert.equal(fixture.calls.test, 1)
  await assert.rejects(() => (async () => {
    const controller = await fixture.createController()
    return controller.submitExternalReview({
      runId: submitted.runId,
      receipt: approved.handoff.reviewReceipt,
      decision: 'ACCEPTED',
      summary: 'duplicate',
      findings: [],
    })
  })(), /cannot accept an external review from state COMPLETE/)
  assert.equal(fixture.calls.executor, 1)
  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    { code: 'RUN_SESSION_CANDIDATE_MISSING' },
  )
})

test('an external review claim prevents a concurrent cancellation from overwriting its result', async t => {
  const reviewClaimWritten = Promise.withResolvers()
  const reviewClaimGate = Promise.withResolvers()
  const fixture = await createFixture(t, { reviewClaimWritten, reviewClaimGate: reviewClaimGate.promise })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })
  const reviewing = (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'ACCEPTED',
    summary: 'Review claim wins before cancellation.',
    findings: [],
  })

  try {
    await reviewClaimWritten.promise
    assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'review-resolution-claim.json' })).action, 'review')
    await assert.rejects(
      () => (async () => (await fixture.createController()).cancelRun({ runId: submitted.runId }))(),
      error => error.code === 'RUN_REVIEW_RESOLUTION_ACTIVE',
    )
    assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'REVIEWING')
  } finally {
    reviewClaimGate.resolve()
  }

  assert.equal((await reviewing).state, 'COMPLETE')
  assert.equal(fixture.calls.executor, 1)
})

test('reviewer receipts are required, unique, and bound to the run evidence', async t => {
  const fixture = await createFixture(t)
  const first = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const firstApproved = await (await fixture.createController()).approveExternalPlan({ runId: first.runId, planSha256: first.handoff.planSha256 })

  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitExternalReview({
      runId: first.runId,
      decision: 'ACCEPTED',
      summary: 'Missing receipt.',
      findings: [],
    })),
    error => error.code === 'REVIEW_RECEIPT_REQUIRED',
  )
  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitExternalReview({
      runId: first.runId,
      receipt: '0'.repeat(22),
      decision: 'ACCEPTED',
      summary: 'Incorrect receipt.',
      findings: [],
    })),
    error => error.code === 'REVIEW_RECEIPT_MISMATCH',
  )

  const second = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const secondApproved = await (await fixture.createController()).approveExternalPlan({ runId: second.runId, planSha256: second.handoff.planSha256 })
  assert.notEqual(firstApproved.handoff.reviewReceipt, secondApproved.handoff.reviewReceipt)
  await assert.rejects(
    () => fixture.createController().then(controller => controller.submitExternalReview({
      runId: second.runId,
      receipt: firstApproved.handoff.reviewReceipt,
      decision: 'ACCEPTED',
      summary: 'Receipt belongs to an older run.',
      findings: [],
    })),
    error => error.code === 'REVIEW_RECEIPT_MISMATCH',
  )
  assert.equal(fixture.calls.executor, 2)
})

test('M2 approval rejects a changed plan artifact before calling DSH', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  await writeFile(join(fixture.artifactRoot, submitted.runId, 'plan.json'), 'tampered\n')

  await assert.rejects(() => (async () => {
    const controller = await fixture.createController()
    return controller.approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
  })(), /artifact hash changed: plan.json/)
  assert.equal(fixture.calls.executor, 0)
  assert.equal(fixture.calls.test, 0)
})

test('M2 approval stops when project context changes after plan submission', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  await writeFile(join(fixture.projectRoot, 'unexpected.txt'), 'changed after plan\n')

  const stopped = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  assert.equal(stopped.state, 'STOPPED')
  assert.equal(stopped.diagnostic.code, 'PROJECT_CONTEXT_CHANGED')
  assert.equal(fixture.calls.executor, 0)
})

test('M2 external review stops if the project changed after evidence collection', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController()).approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
  await writeFile(join(fixture.projectRoot, 'reviewer-stale.txt'), 'changed after evidence\n')
  runGit(fixture.projectRoot, ['add', 'reviewer-stale.txt'])
  runGit(fixture.projectRoot, ['commit', '--quiet', '-m', 'change after evidence'])

  const stopped = await (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'ACCEPTED',
    summary: 'The previously observed evidence is stale.',
    findings: [],
  })

  assert.equal(stopped.state, 'STOPPED')
  assert.equal(stopped.diagnostic.code, 'EVIDENCE_STALE')
  assert.equal(fixture.calls.executor, 1)
})

test('M2 ACCEPTED review rejects failed DSH test evidence', async t => {
  const fixture = await createFixture(t, { testOk: false })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController()).approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })

  await assert.rejects(() => (async () => {
    const controller = await fixture.createController()
    return controller.submitExternalReview({
      runId: submitted.runId,
      receipt: approved.handoff.reviewReceipt,
      decision: 'ACCEPTED',
      summary: 'Cannot accept failed tests.',
      findings: [],
    })
  })(), error => error.code === 'REVIEW_TEST_NOT_PASSED')
  assert.equal(fixture.calls.executor, 1)
})

test('persisted WAITING_FOR_APPROVAL can be explicitly cancelled by a new Controller', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })

  const cancelled = await (await fixture.createController()).cancelRun({ runId: submitted.runId })

  assert.equal(cancelled.state, 'CANCELLED')
  assert.equal(cancelled.summary.hasModifiedProject, false)
  assert.equal(fixture.calls.executor, 0)
})

test('context-change stop claims approval before it can race with cancellation', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  await writeFile(join(fixture.projectRoot, 'README.md'), 'context changed after plan approval\n')

  const stopWriteStarted = Promise.withResolvers()
  const stopWriteGate = Promise.withResolvers()
  const controller = await fixture.createController()
  const writeJson = controller.store.writeJson.bind(controller.store)
  controller.store.writeJson = async options => {
    if (options.name === 'diagnostic.json' && options.source === 'controller-diagnostic') {
      stopWriteStarted.resolve()
      await stopWriteGate.promise
    }
    return writeJson(options)
  }
  const stopping = controller.approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
  let cancellationError
  try {
    await stopWriteStarted.promise
    try {
      await (await fixture.createController()).cancelRun({ runId: submitted.runId })
    } catch (error) {
      cancellationError = error
    }
  } finally {
    stopWriteGate.resolve()
  }

  const stopped = await stopping
  assert.equal(cancellationError?.code, 'RUN_EXECUTION_STILL_ACTIVE')
  assert.equal(stopped.state, 'STOPPED')
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'approval-claim.json' })).action, 'stop-context')
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'STOPPED')
  assert.equal(fixture.calls.executor, 0)
})

test('cancellation cannot overwrite approval finalization after REVIEWING is published', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approvalFinishWriteStarted = Promise.withResolvers()
  const approvalFinishWriteGate = Promise.withResolvers()
  const approvalController = await fixture.createController()
  const writeJson = approvalController.store.writeJson.bind(approvalController.store)
  let reviewingStateWrites = 0
  approvalController.store.writeJson = async options => {
    if (options.name === 'run-state.json' && options.value?.state === 'REVIEWING' && ++reviewingStateWrites === 2) {
      approvalFinishWriteStarted.resolve()
      await approvalFinishWriteGate.promise
    }
    return writeJson(options)
  }
  const approving = approvalController.approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })
  let cancellationError

  try {
    await approvalFinishWriteStarted.promise
    try {
      await (await fixture.createController()).cancelRun({ runId: submitted.runId })
    } catch (error) {
      cancellationError = error
    }
  } finally {
    approvalFinishWriteGate.resolve()
  }

  const approved = await approving
  assert.equal(cancellationError?.code, 'RUN_EXECUTION_STILL_ACTIVE')
  assert.equal(approved.state, 'REVIEWING')
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'REVIEWING')
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'execution-owner-settled.json' })).runId, submitted.runId)
  assert.equal(fixture.calls.executor, 1)
})

test('external Reviewer cannot resolve the run before the execution owner is released', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const finishAuditStarted = Promise.withResolvers()
  const finishAuditGate = Promise.withResolvers()
  const approvalController = await fixture.createController()
  const writeJson = approvalController.store.writeJson.bind(approvalController.store)
  approvalController.store.writeJson = async options => {
    if (options.name === 'audit-trace.json' && options.source === 'controller') {
      finishAuditStarted.resolve()
      await finishAuditGate.promise
    }
    return writeJson(options)
  }
  const approving = approvalController.approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
  let reviewError

  try {
    await finishAuditStarted.promise
    const manifest = await fixture.store.readJson({ runId: submitted.runId, name: 'run-manifest.json' })
    const evidenceDescriptor = manifest.artifacts.find(artifact => artifact.name === 'evidence-manifest.json')
    const receiptRecord = await fixture.store.readJson({ runId: submitted.runId, name: 'review-receipt.json' })
    try {
      await (await fixture.createController()).submitExternalReview({
        runId: submitted.runId,
        receipt: receiptRecord.receipt,
        decision: 'ACCEPTED',
        summary: 'The execution owner must release before external review.',
        findings: [],
      })
    } catch (error) {
      reviewError = error
    }
  } finally {
    finishAuditGate.resolve()
  }

  const approved = await approving
  assert.equal(reviewError?.code, 'RUN_EXECUTION_STILL_ACTIVE')
  assert.equal(approved.state, 'REVIEWING')
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'REVIEWING')
  const manifest = await fixture.store.readJson({ runId: submitted.runId, name: 'run-manifest.json' })
  const evidenceDescriptor = manifest.artifacts.find(artifact => artifact.name === 'evidence-manifest.json')
  const completed = await (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'ACCEPTED',
    summary: 'The released execution can now accept the reviewer result.',
    findings: [],
  })
  assert.equal(completed.state, 'COMPLETE')
})

test('a new Controller restores a missing settlement marker after complete execution finalization', async t => {
  const fixture = await createFixture(t, { executionOwnerPid: exitedProcessPid() })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController()).approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
  const settledPath = join(fixture.artifactRoot, submitted.runId, 'execution-owner-settled.json')
  await rm(settledPath)

  const completed = await (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'ACCEPTED',
    summary: 'The persisted finalization is consistent after the approval process exited.',
    findings: [],
  })

  assert.equal(completed.state, 'COMPLETE')
  const settled = await fixture.store.readJson({ runId: submitted.runId, name: 'execution-owner-settled.json' })
  assert.equal(settled.runId, submitted.runId)
  assert.equal(settled.planSha256, submitted.handoff.planSha256)
  assert.equal(settled.executionOwnerSha256, (await fixture.store.readJson({ runId: submitted.runId, name: 'run-manifest.json' })).artifacts.find(artifact => artifact.name === 'execution-owner.json').sha256)
  assert.equal(fixture.calls.executor, 1)
})

test('an exited owner with incomplete finalization cannot be reviewed but can be safely stopped', async t => {
  const fixture = await createFixture(t, { executionOwnerPid: exitedProcessPid() })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const submittedManifest = await fixture.store.readJson({ runId: submitted.runId, name: 'run-manifest.json' })
  const approved = await (await fixture.createController()).approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
  await rm(join(fixture.artifactRoot, submitted.runId, 'execution-owner-settled.json'))
  await fixture.store.writeJson({ runId: submitted.runId, stage: 'test-crash-state', name: 'run-manifest.json', value: submittedManifest, source: 'test-crash-state' })

  await assert.rejects(
    () => (async () => (await fixture.createController()).submitExternalReview({
      runId: submitted.runId,
      receipt: approved.handoff.reviewReceipt,
      decision: 'ACCEPTED',
      summary: 'Incomplete approval finalization must stay fail-closed.',
      findings: [],
    }))(),
    error => error.code === 'RUN_EXECUTION_FINALIZATION_INCOMPLETE',
  )
  await assert.rejects(fixture.store.readJson({ runId: submitted.runId, name: 'review-resolution-claim.json' }), { code: 'ENOENT' })

  const stopped = await (await fixture.createController()).cancelRun({ runId: submitted.runId, reason: '审批进程已退出，但最终取证记录不完整；安全停止。' })
  assert.equal(stopped.state, 'CANCELLED')
  assert.equal(stopped.decision, null)
  assert.equal(stopped.audit.audit.at(-1).executionFinalizationIncomplete, true)
  assert.equal(fixture.calls.executor, 1)

  const nextPlan = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const candidate = await (await fixture.createController()).findExternalRunForSession({ operation: 'approve' })
  assert.equal(candidate.runId, nextPlan.runId)
  assert.equal(fixture.calls.executor, 1, 'terminal cancellation lookup must not execute another plan')
})

for (const [label, settledValue] of [
  ['truncated', '{'],
  ['mismatched', JSON.stringify({ schema: 1, runId: 'another-run', planSha256: '0'.repeat(64) })],
  ['null-shaped', 'null'],
]) {
  test(`an exited owner with a ${label} settlement marker cannot be reviewed but can be safely stopped`, async t => {
    const fixture = await createFixture(t, { executionOwnerPid: exitedProcessPid() })
    const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
    const approved = await (await fixture.createController()).approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })
    await writeFile(join(fixture.artifactRoot, submitted.runId, 'execution-owner-settled.json'), settledValue)

    await assert.rejects(
      () => (async () => (await fixture.createController()).submitExternalReview({
        runId: submitted.runId,
        receipt: approved.handoff.reviewReceipt,
        decision: 'ACCEPTED',
        summary: 'A damaged settlement marker must not authorize external review.',
        findings: [],
      }))(),
      error => error.code === 'RUN_EXECUTION_OWNER_UNKNOWN',
    )
    await assert.rejects(fixture.store.readJson({ runId: submitted.runId, name: 'review-resolution-claim.json' }), { code: 'ENOENT' })

    const stopped = await (await fixture.createController()).cancelRun({ runId: submitted.runId, reason: '执行已退出，但结算标记不完整；安全停止。' })
    assert.equal(stopped.state, 'CANCELLED')
    assert.equal(stopped.decision, null)
    assert.equal(stopped.audit.audit.at(-1).executionFinalizationIncomplete, true)
    assert.equal(fixture.calls.executor, 1)
  })
}

test('a fresh Controller cannot overwrite a terminal state read after its cancellation snapshot', async t => {
  const cancelStateRead = Promise.withResolvers()
  const cancelStateGate = Promise.withResolvers()
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const cancelController = await fixture.createController()
  const readJson = cancelController.store.readJson.bind(cancelController.store)
  let pauseInitialState = true
  cancelController.store.readJson = async options => {
    const value = await readJson(options)
    if (pauseInitialState && options.name === 'run-state.json') {
      pauseInitialState = false
      cancelStateRead.resolve()
      await cancelStateGate.promise
    }
    return value
  }
  const cancelling = cancelController.cancelRun({ runId: submitted.runId })

  try {
    await cancelStateRead.promise
    const approved = await (await fixture.createController()).approveExternalPlan({
      runId: submitted.runId,
      planSha256: submitted.handoff.planSha256,
    })
    const completed = await (await fixture.createController()).submitExternalReview({
      runId: submitted.runId,
      receipt: approved.handoff.reviewReceipt,
      decision: 'ACCEPTED',
      summary: 'The completed run must not be replaced by a stale cancellation.',
      findings: [],
    })
    assert.equal(completed.state, 'COMPLETE')

    const stoppedPid = spawnSync(process.execPath, ['-e', '']).pid
    assert.ok(Number.isSafeInteger(stoppedPid))
    assert.throws(() => process.kill(stoppedPid, 0), { code: 'ESRCH' })
    for (const name of ['approval-claim.json', 'execution-owner.json']) {
      const claim = await fixture.store.readJson({ runId: submitted.runId, name })
      await fixture.store.writeJson({ runId: submitted.runId, stage: 'test', name, value: { ...claim, pid: stoppedPid }, source: 'test' })
    }

    cancelStateGate.resolve()
    await assert.rejects(cancelling, error => ['RUN_ALREADY_TERMINAL', 'RUN_STATE_CHANGED'].includes(error.code))
    assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'COMPLETE')
  } finally {
    cancelStateGate.resolve()
  }
})

test('a fresh Controller cannot cancel after approval claims the plan but before execution ownership is persisted', async t => {
  const approvalClaimWritten = Promise.withResolvers()
  const approvalClaimGate = Promise.withResolvers()
  const fixture = await createFixture(t, { approvalClaimWritten, approvalClaimGate: approvalClaimGate.promise })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approving = (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  await approvalClaimWritten.promise
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'approval-claim.json' })).action, 'approve')
  await assert.rejects(
    fixture.store.readJson({ runId: submitted.runId, name: 'execution-owner.json' }),
    error => error.code === 'ENOENT',
  )
  try {
    await assert.rejects(
      () => (async () => (await fixture.createController()).cancelRun({ runId: submitted.runId }))(),
      error => error.code === 'RUN_EXECUTION_STILL_ACTIVE',
    )
    assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'WAITING_FOR_APPROVAL')
    assert.equal(fixture.calls.executor, 0)
  } finally {
    approvalClaimGate.resolve()
  }

  assert.equal((await approving).state, 'REVIEWING')
  assert.equal(fixture.calls.executor, 1)
})

test('a fresh Controller cannot report an active DSH execution cancelled while its owner is still alive', async t => {
  const executorStarted = Promise.withResolvers()
  const executorGate = Promise.withResolvers()
  const fixture = await createFixture(t, { executorStarted, executorGate: executorGate.promise })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const signal = new AbortController()
  const running = (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
    signal: signal.signal,
  })
  await executorStarted.promise
  const activeState = await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })
  assert.equal(activeState.state, 'EXECUTING')

  await assert.rejects(
    () => (async () => (await fixture.createController()).cancelRun({ runId: submitted.runId }))(),
    error => error.code === 'RUN_EXECUTION_STILL_ACTIVE',
  )
  assert.equal((await fixture.store.readJson({ runId: submitted.runId, name: 'run-state.json' })).state, 'EXECUTING')
  assert.equal(fixture.calls.test, 0)

  signal.abort()
  executorGate.resolve()
  const cancelled = await running
  assert.equal(cancelled.state, 'CANCELLED')
  assert.equal(fixture.calls.test, 0)
  await assert.rejects(readFile(join(fixture.projectRoot, 'result.txt'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(
    () => fixture.createController().then(controller => controller.findExternalRunForSession({ operation: 'approve' })),
    { code: 'RUN_SESSION_CANDIDATE_MISSING' },
  )
})

test('M2 execution stops when DSH changes a path outside the approved scope', async t => {
  const fixture = await createFixture(t, { writeOutsideScope: true })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })

  const stopped = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  assert.equal(stopped.state, 'FAILED')
  assert.equal(stopped.diagnostic.code, 'EXECUTION_SCOPE_VIOLATION')
  assert.deepEqual(stopped.summary.changedFileNames, ['outside.txt', 'result.txt'])
  assert.equal(fixture.calls.executor, 1)
})

test('M2 execution allows an in-scope commit and reviews its history without losing prior dirty files', async t => {
  const fixture = await createFixture(t, { createCommit: true, preexistingFile: true })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })

  const approved = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  assert.equal(approved.state, 'REVIEWING', JSON.stringify(approved.diagnostic))
  assert.equal(approved.diagnostic, null)
  assert.equal(fixture.calls.executor, 1)
  assert.deepEqual(approved.summary.changedFileNames, ['result.txt'])
  assert.equal(await readFile(join(fixture.projectRoot, 'outside.txt'), 'utf8'), 'pre-existing uncommitted work\n')

  const baseline = await fixture.store.readJson({ runId: submitted.runId, name: 'baseline-snapshot.json' })
  assert.match(baseline.fileHashes['outside.txt'], /^[a-f0-9]{64}$/u)
  const after = await fixture.store.readJson({ runId: submitted.runId, name: 'after-snapshot.json' })
  assert.notEqual(after.commit, baseline.commit)
  assert.equal(baseline.dirty, true)
  assert.equal(after.dirty, true)
  assert.equal(after.fileHashes['outside.txt'], baseline.fileHashes['outside.txt'])

  const manifest = await fixture.store.readJson({ runId: submitted.runId, name: 'evidence-manifest.json' })
  assert.ok(manifest.artifacts.some(artifact => artifact.name === 'git-history.patch'))
  const history = await readFile(join(fixture.artifactRoot, submitted.runId, 'git-history.patch'), 'utf8')
  assert.match(history, /unexpected agent commit/)
  assert.match(history, /result\.txt/)
  const delta = await readFile(join(fixture.artifactRoot, submitted.runId, 'git-diff.patch'), 'utf8')
  assert.match(delta, /result\.txt/)
  assert.doesNotMatch(delta, /outside\.txt/)

  const completed = await (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'ACCEPTED',
    summary: 'The committed code, history and final Git state match the approved scope.',
    findings: [],
  })
  assert.equal(completed.state, 'COMPLETE')
  assert.deepEqual(completed.summary.changedFileNames, ['result.txt'])
})

test('M2 rejects a commit that captures pre-existing changes outside the approved scope', async t => {
  const fixture = await createFixture(t, { createCommit: true, preexistingFile: true, stageAll: true })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })

  const stopped = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  assert.equal(stopped.state, 'FAILED')
  assert.equal(stopped.diagnostic.code, 'EXECUTION_SCOPE_VIOLATION')
  assert.deepEqual(stopped.summary.changedFileNames, ['outside.txt', 'result.txt'])
  assert.equal(await readFile(join(fixture.projectRoot, 'outside.txt'), 'utf8'), 'pre-existing uncommitted work\n')
  const baseline = await fixture.store.readJson({ runId: submitted.runId, name: 'baseline-snapshot.json' })
  assert.match(baseline.fileHashes['outside.txt'], /^[a-f0-9]{64}$/u)
  assert.equal(await readFile(join(fixture.artifactRoot, submitted.runId, '.snapshots', 'baseline', 'outside.txt'), 'utf8'), 'pre-existing uncommitted work\n')
  assert.match(await readFile(join(fixture.artifactRoot, submitted.runId, 'git-history.patch'), 'utf8'), /outside\.txt/)
})

test('M2 permits git clean but rejects deleting a pre-existing file outside the approved scope', async t => {
  const fixture = await createFixture(t, { preexistingFile: true, cleanPreexistingOutside: true })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })

  const stopped = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  assert.equal(stopped.state, 'FAILED')
  assert.equal(stopped.diagnostic.code, 'EXECUTION_SCOPE_VIOLATION')
  assert.deepEqual(stopped.summary.changedFileNames, ['outside.txt', 'result.txt'])
  await assert.rejects(readFile(join(fixture.projectRoot, 'outside.txt')), { code: 'ENOENT' })
  const baseline = await fixture.store.readJson({ runId: submitted.runId, name: 'baseline-snapshot.json' })
  assert.equal(await readFile(join(fixture.artifactRoot, submitted.runId, '.snapshots', 'baseline', 'outside.txt'), 'utf8'), 'pre-existing uncommitted work\n')
  assert.match(baseline.fileHashes['outside.txt'], /^[a-f0-9]{64}$/u)
})

test('M2 scope validation sees out-of-scope paths committed and reverted during execution', async t => {
  const fixture = await createFixture(t, { writeOutsideScope: true, createCommit: true, stageAll: true, revertCommit: true })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })

  const stopped = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  assert.equal(stopped.state, 'FAILED')
  assert.equal(stopped.diagnostic.code, 'EXECUTION_SCOPE_VIOLATION')
  assert.deepEqual(stopped.summary.changedFileNames, ['outside.txt', 'result.txt'])
  await assert.rejects(readFile(join(fixture.projectRoot, 'outside.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(fixture.projectRoot, 'result.txt')), { code: 'ENOENT' })
  const history = await readFile(join(fixture.artifactRoot, submitted.runId, 'git-history.patch'), 'utf8')
  assert.match(history, /unexpected agent commit/)
  assert.match(history, /Revert "unexpected agent commit"/)
})

test('unpaired DSH tool approval cannot produce REVIEWING evidence', async t => {
  const fixture = await createFixture(t, {
    writeResult: false,
    executorEvents: [{ type: 'approval/asked', data: { id: 'missing-decision', toolName: 'bash' } }],
  })
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })

  const failed = await (await fixture.createController()).approveExternalPlan({
    runId: submitted.runId,
    planSha256: submitted.handoff.planSha256,
  })

  assert.equal(failed.state, 'FAILED')
  assert.equal(failed.diagnostic.code, 'DSH_TOOL_APPROVAL_FAILED')
  assert.equal(fixture.calls.test, 0)
})

test('non-ACCEPTED external review stops without another DSH execution', async t => {
  const fixture = await createFixture(t)
  const submitted = await (await fixture.createController()).submitExternalPlan({ plan: fixture.plan })
  const approved = await (await fixture.createController()).approveExternalPlan({ runId: submitted.runId, planSha256: submitted.handoff.planSha256 })

  const stopped = await (await fixture.createController()).submitExternalReview({
    runId: submitted.runId,
    receipt: approved.handoff.reviewReceipt,
    decision: 'NEEDS_FIX',
    summary: 'A new explicit authorization is required before any change.',
    findings: ['Do not rerun automatically.'],
  })

  assert.equal(stopped.state, 'STOPPED')
  assert.equal(stopped.decision, 'NEEDS_FIX')
  assert.equal(fixture.calls.executor, 1)
})

async function createFixture(t, { testOk = true, writeOutsideScope = false, createCommit = false, preexistingFile = false, cleanPreexistingOutside = false, stageAll = false, revertCommit = false, writeResult = true, executorEvents, executorStarted, executorGate, executionOwnerPid, approvalClaimWritten, approvalClaimGate, reviewClaimWritten, reviewClaimGate, } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  await mkdir(projectRoot)
  await writeFile(join(projectRoot, 'README.md'), 'fixture project\n')
  runGit(projectRoot, ['init', '--quiet', '--initial-branch=fixture'])
  runGit(projectRoot, ['config', 'user.name', 'M2 Fixture'])
  runGit(projectRoot, ['config', 'user.email', 'm2-fixture@example.invalid'])
  runGit(projectRoot, ['add', 'README.md'])
  runGit(projectRoot, ['commit', '--quiet', '-m', 'fixture baseline'])
  if (preexistingFile) await writeFile(join(projectRoot, 'outside.txt'), 'pre-existing uncommitted work\n')
  const commit = runGit(projectRoot, ['rev-parse', 'HEAD'])
  const calls = { executor: 0, test: 0, zip: 0, bridge: 0 }
  const executor = {
    async execute({ cwd, task, signal }) {
      calls.executor += 1
      assert.equal(cwd, await realpath(projectRoot))
      assert.match(task, /Approved plan JSON:/)
      assert.match(task, /Included repository paths: \["result.txt"\]/)
      assert.match(task, /Git operations needed to complete the approved task are permitted under DSH native tool permissions/)
      assert.match(task, /Do not modify files outside the included paths or any excluded path/)
      assert.match(task, /Create result\.txt with the approved fixture output\./)
      executorStarted?.resolve()
      if (executorGate) await executorGate
      if (signal?.aborted) throw Object.assign(new Error('fake DSH execution cancelled'), { name: 'AbortError', code: 'CANCELLED' })
      if (writeResult) await writeFile(join(cwd, 'result.txt'), 'fixture change\n')
      if (writeOutsideScope) await writeFile(join(cwd, 'outside.txt'), 'out of scope\n')
      if (cleanPreexistingOutside) runGit(cwd, ['clean', '--force', '--', 'outside.txt'])
      if (createCommit) {
        runGit(cwd, stageAll ? ['add', '--all'] : ['add', 'result.txt'])
        runGit(cwd, ['commit', '--quiet', '-m', 'unexpected agent commit'])
        if (revertCommit) runGit(cwd, ['revert', '--quiet', '--no-edit', 'HEAD'])
      }
      return {
        runId: 'fake-dsh-run',
        provider: 'fake-dsh',
        model: 'offline-fixture',
        output: 'FAKE_DSH_EXECUTED',
        stopReason: { kind: 'completed' },
        events: executorEvents ?? [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
      }
    },
    async executeTest({ runId, round, cwd, command, args }) {
      calls.test += 1
      assert.equal(cwd, await realpath(projectRoot))
      return {
        source: 'dsh-tool-result',
        requestId: `${runId}:round-${round}:test`,
        runId,
        round,
        provider: 'fake-dsh',
        model: 'offline-fixture',
        authorizedCallId: 'fixture-test-call',
        approvalEvents: [
          { type: 'approval/asked', data: { callId: 'fixture-test-call', toolName: 'bash' } },
          { type: 'approval/decided', data: { callId: 'fixture-test-call', outcome: 'allowed-once' } },
        ],
        command: [command, ...args],
        commandResult: { kind: 'foreground', exitCode: testOk ? 0 : 1, sandbox: { mode: 'workspace-write', denied: false } },
        exitCode: testOk ? 0 : 1,
        timedOut: false,
        aborted: false,
        errorCode: testOk ? null : 'TEST_COMMAND_NONZERO_EXIT',
        ok: testOk,
      }
    },
  }
  let nextRunId = 0
  const createController = async ({ sessionId = 'fixture-session' } = {}) => {
    const store = await new ArtifactStore({ root: artifactRoot }).init()
    const writeJsonOnce = store.writeJsonOnce.bind(store)
    store.writeJsonOnce = async options => {
      const writeOptions = options.name === 'execution-owner.json' && executionOwnerPid !== undefined
        ? { ...options, value: { ...options.value, pid: executionOwnerPid } }
        : options
      const descriptor = await writeJsonOnce(writeOptions)
      if (options.name === 'approval-claim.json' && options.value.action === 'approve') {
        approvalClaimWritten?.resolve()
        if (approvalClaimGate) await approvalClaimGate
      }
      if (options.name === 'review-resolution-claim.json' && options.value.action === 'review') {
        reviewClaimWritten?.resolve()
        if (reviewClaimGate) await reviewClaimGate
      }
      return descriptor
    }
    const gitAdapter = createGitEvidenceAdapter({ projectRoot, artifactRoot: store.root })
    const preflight = createPreflightChecker({
      gitAdapter,
      transport: 'manual-handoff',
      checkZip: async () => { calls.zip += 1; return { exitCode: 0 } },
      bridge: { probe: async () => { calls.bridge += 1; return { ok: true, checked: true } } },
      runtime: { agents: true, agentPresets: true, permissionPresets: true },
    })
    const evidenceCollector = createEvidenceCollector({
      store,
      gitAdapter,
      artifactRoot: store.root,
      testExecutor: request => executor.executeTest(request),
      testCommand: ['npm', ['test']],
    })
    return new DevLoopController({
      store,
      executor,
      evidenceCollector,
      gitAdapter,
      projectRoot,
      preflight,
      mode: 'manual-handoff',
      sessionId,
      runIdFactory: () => `m2-offline-run-${++nextRunId}`,
    })
  }
  return {
    root,
    projectRoot,
    artifactRoot,
    calls,
    store: await new ArtifactStore({ root: artifactRoot }).init(),
    plan: {
      schema: 1,
      summary: 'Create a small fixture output file.',
      scope: { includedPaths: ['result.txt'], excludedPaths: [], nonGoals: [] },
      executionRequirements: ['Use only the configured project root.'],
      contextSources: ['GitHub molibaby1/dsh-dev-loop@fixture commit', 'manual local worktree observation'],
      observedContext: { branch: 'fixture', commit },
      executorTask: 'Create result.txt with the approved fixture output.',
      acceptanceCriteria: ['result.txt contains fixture change'],
    },
    createController,
  }
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function exitedProcessPid() {
  const result = spawnSync(process.execPath, ['-e', ''])
  assert.equal(result.status, 0)
  assert.ok(Number.isSafeInteger(result.pid))
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' })
  return result.pid
}
