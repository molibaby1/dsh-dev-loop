import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { executeDevLoopCommand, createDevLoopCommand, parseDevLoopInput } from '../src/command.mjs'

test('dev-loop command defaults to waiting for human approval', () => {
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    executorTask: 'bounded task',
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts' })
  assert.equal(parsed.projectRoot, '/tmp/project')
  assert.equal(parsed.artifactRoot, '/tmp/dsh-artifacts')
  assert.equal(parsed.approval, false)
  assert.equal(parsed.approvalSource, 'waiting-for-human')
})

test('dev-loop command can explicitly opt into automatic approval', () => {
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts', autoApprove: true })
  assert.equal(parsed.approval, true)
  assert.equal(parsed.approvalSource, 'dev-loop-auto')
})

test('dev-loop command can restore approval gate and rejects artifact roots inside project', () => {
  const gated = parseDevLoopInput(JSON.stringify({ problemPackage: { id: 'x' } }), {
    projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts', autoApprove: false,
  })
  assert.equal(gated.approval, false)
  assert.throws(() => parseDevLoopInput(JSON.stringify({ problemPackage: { id: 'x' }, approve: true }), {
    projectRoot: '/tmp/project', artifactRoot: '/tmp/project/artifacts',
  }), /outside projectRoot/)
})

test('dev-loop command accepts a natural-language task with configured roots', () => {
  const parsed = parseDevLoopInput('修复登录页提交后没有反应的问题', {
    projectRoot: '/tmp/project',
    artifactRoot: '/tmp/dsh-artifacts',
  })
  assert.equal(parsed.problemPackage.summary, '修复登录页提交后没有反应的问题')
  assert.equal(parsed.problemPackage.source, 'human')
  assert.equal(parsed.approval, false)
})

test('task JSON cannot select a DSH permission preset', () => {
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    permissionPreset: 'danger-full-access',
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts' })
  assert.equal(Object.hasOwn(parsed, 'permissionPreset'), false)
})

test('dev-loop command parses approval and cancellation controls', async () => {
  const { parseDevLoopControl } = await import('../src/command.mjs')
  assert.deepEqual(parseDevLoopControl('approve run-123'), { kind: 'approve', runId: 'run-123' })
  assert.deepEqual(parseDevLoopControl('取消 run-123'), { kind: 'cancel', runId: 'run-123' })
  assert.equal(parseDevLoopControl('approve ../escape'), undefined)
})

test('dev-loop command rejects unsafe run identifiers before storage', () => {
  assert.throws(() => parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'x' },
    runId: '../escape',
  }), { projectRoot: '/tmp/project', artifactRoot: '/tmp/dsh-artifacts' }), /runId/)
})

test('request cannot replace the host project root with another path or symlink alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-root-boundary-'))
  const configuredRoot = join(root, 'configured')
  const alternateRoot = join(root, 'alternate')
  const alias = join(root, 'alias')
  await mkdir(configuredRoot)
  await mkdir(alternateRoot)
  await symlink(alternateRoot, alias)
  const defaults = { projectRoot: configuredRoot, artifactRoot: join(root, 'artifacts') }

  for (const projectRoot of [alternateRoot, alias]) {
    assert.throws(() => parseDevLoopInput(JSON.stringify({
      problemPackage: { id: 'problem-1' },
      projectRoot,
    }), defaults), /configured projectRoot/)
  }
})

test('request canonical aliases that resolve to the configured project root remain compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-root-canonical-'))
  const configuredRoot = join(root, 'configured')
  const alias = join(root, 'configured-alias')
  await mkdir(configuredRoot)
  await symlink(configuredRoot, alias)
  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    projectRoot: alias,
  }), { projectRoot: configuredRoot, artifactRoot: join(root, 'artifacts') })

  assert.equal(parsed.projectRoot, await realpath(configuredRoot))
})

test('request cannot choose an artifact root other than the Host-configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-artifact-root-boundary-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  const alternateRoot = join(root, 'alternate-artifacts')
  const alias = join(root, 'alternate-alias')
  await mkdir(projectRoot)
  await mkdir(artifactRoot)
  await mkdir(alternateRoot)
  await symlink(alternateRoot, alias)

  for (const requestedRoot of [alternateRoot, alias]) {
    assert.throws(() => parseDevLoopInput(JSON.stringify({
      problemPackage: { id: 'problem-1' },
      artifactRoot: requestedRoot,
    }), { projectRoot, artifactRoot }), /configured artifactRoot/)
  }
  assert.throws(() => parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    artifactRoot: 'relative-artifacts',
  }), { projectRoot, artifactRoot }), /absolute/)
})

test('request canonical aliases of the Host artifact root remain compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-artifact-root-canonical-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  const alias = join(root, 'artifact-alias')
  await mkdir(projectRoot)
  await mkdir(artifactRoot)
  await symlink(artifactRoot, alias)

  const parsed = parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
    artifactRoot: alias,
  }), { projectRoot, artifactRoot })

  assert.equal(parsed.artifactRoot, artifactRoot)
})

test('artifact root must come from Host configuration', () => {
  assert.throws(() => parseDevLoopInput(JSON.stringify({
    problemPackage: { id: 'problem-1' },
  }), { projectRoot: '/tmp/project' }), /configured artifactRoot/)
})

test('command rejects an artifact-root override before Host configuration is merged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-command-artifact-root-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  const requestedRoot = join(root, 'request-artifacts')
  await mkdir(projectRoot)

  const result = await executeDevLoopCommand({
    ctx: { agents: {} },
    config: { projectRoot, artifactRoot },
    invocation: {
      rawInput: JSON.stringify({ problemPackage: { id: 'problem-1' }, artifactRoot: requestedRoot }),
    },
  })

  assert.equal(result.kind, 'error')
  await assert.rejects(import('node:fs/promises').then(module => module.access(requestedRoot)), { code: 'ENOENT' })
})

test('dev-loop command records the entered prompt for display', () => {
  const command = createDevLoopCommand({ ctx: {} })
  assert.equal(command.recordInput, true)
  assert.equal(command.description, '输入一句需求，先生成方案，确认后再修改和验证')
  assert.equal(command.input.hint, '例如：修复登录页提交后没有反应的问题')
})

test('dev-loop command gives a plain-language empty-input hint', () => {
  assert.throws(() => parseDevLoopInput('', {
    projectRoot: '/tmp/project',
    artifactRoot: '/tmp/dsh-artifacts',
  }), /请输入一句要完成的需求/)
})

test('command outcomes remain in Controller storage and restore under the installed DSH session contract', async () => {
  const validateStoredEvents = await loadDshSessionPersistenceValidator()
  const artifactRoot = await mkdtemp(join(tmpdir(), 'dsh-loop-command-session-'))
  const bridge = await createOfflineBridge()
  const session = Session.create('session-command-compatibility')
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'run offline compatibility check' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const ctx = {
    agents: {},
    agentPresets: { mount() {} },
    permissionPresets: { set() {} },
  }
  const config = {
    projectRoot: process.cwd(),
    artifactRoot,
    bridgeBaseUrl: bridge.baseUrl,
    bridgeTimeoutMs: 5000,
  }
  const invoke = rawInput => executeDevLoopCommand({ ctx, config, invocation: { rawInput, agent: { session } } })

  try {
    const waiting = await invoke(JSON.stringify({
      problemPackage: { id: 'command-compatibility', summary: 'offline compatibility check' },
      runId: 'run-compatibility-waiting',
    }))
    assert.equal(waiting.kind, 'success')
    assert.match(waiting.text, /方案已生成，尚未修改代码/)
    assert.equal((await readCommandState(artifactRoot, 'run-compatibility-waiting')).state, 'WAITING_FOR_APPROVAL')
    const waitingManifest = await readCommandManifest(artifactRoot, 'run-compatibility-waiting')
    assert.equal(waitingManifest.state, 'WAITING_FOR_APPROVAL')
    assert.ok(waitingManifest.artifacts.some(artifact => artifact.name === 'plan.json'))
    assert.deepEqual(session.snapshotEvents().map(event => event.type), ['user/message'])

    const cancelled = await invoke('cancel run-compatibility-waiting')
    assert.equal(cancelled.kind, 'error')
    assert.match(cancelled.text, /任务已取消/)
    assert.equal((await readCommandState(artifactRoot, 'run-compatibility-waiting')).state, 'CANCELLED')
    const cancelledManifest = await readCommandManifest(artifactRoot, 'run-compatibility-waiting')
    assert.equal(cancelledManifest.state, 'CANCELLED')
    assert.ok(cancelledManifest.artifacts.some(artifact => artifact.name === 'plan.json'))
    assert.ok(cancelledManifest.artifacts.some(artifact => artifact.name === 'diagnostic.json'))
    assert.deepEqual(session.snapshotEvents().map(event => event.type), ['user/message'])

    bridge.setMode('failure')
    const failed = await invoke(JSON.stringify({
      problemPackage: { id: 'command-compatibility-failure', summary: 'offline bridge failure' },
      runId: 'run-compatibility-failed',
    }))
    assert.equal(failed.kind, 'error')
    assert.match(failed.text, /任务失败/)
    assert.equal((await readCommandState(artifactRoot, 'run-compatibility-failed')).state, 'FAILED')
    const failedManifest = await readCommandManifest(artifactRoot, 'run-compatibility-failed')
    assert.equal(failedManifest.state, 'FAILED')
    assert.ok(failedManifest.artifacts.some(artifact => artifact.name === 'diagnostic.json'))
    assert.deepEqual(session.snapshotEvents().map(event => event.type), ['user/message'])

    bridge.setMode('blocked')
    const active = invoke(JSON.stringify({
      problemPackage: { id: 'command-compatibility-cancel', summary: 'cancel active offline request' },
      runId: 'run-compatibility-active-cancel',
    }))
    await bridge.waitForBlockedRequest()
    await invoke('cancel run-compatibility-active-cancel')
    const activeResult = await active
    assert.equal(activeResult.kind, 'error')
    assert.match(activeResult.text, /任务已取消/)
    assert.equal((await readCommandState(artifactRoot, 'run-compatibility-active-cancel')).state, 'CANCELLED')

    const eventCopy = structuredClone(session.snapshotEvents())
    assert.deepEqual(eventCopy.map(event => event.type), ['user/message'])
    validateStoredEvents(session.header, eventCopy)
    const restored = Session.fromRestore(session.id, eventCopy, session.header, 0, 'shared-frozen')
    assert.deepEqual(restored.snapshotEvents().slice(0, eventCopy.length).map(event => event.type), ['user/message'])
  } finally {
    await bridge.close()
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

async function loadDshSessionPersistenceValidator() {
  const localRequire = createRequire(import.meta.url)
  const sessionPackagePath = await realpath(localRequire.resolve('@deepseek-ai/dsh-session/package.json'))
  const runtimeRequire = createRequire(sessionPackagePath)
  const sessionPersistencePackagePath = runtimeRequire.resolve('@deepseek-ai/dsh-session-persistence/package.json')
  const [sessionPackage, persistencePackage] = await Promise.all([
    readFile(sessionPackagePath, 'utf8').then(JSON.parse),
    readFile(sessionPersistencePackagePath, 'utf8').then(JSON.parse),
  ])
  assert.equal(sessionPackage.version, '0.2.1-rc.2')
  assert.equal(persistencePackage.version, '0.2.1-rc.2')
  const persistence = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-session-persistence')))
  return persistence.validateStoredEvents
}

async function createOfflineBridge() {
  let mode = 'success'
  let notifyBlockedRequest
  let blockedRequestSeen
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }))
    })
  })

  async function handleRequest(request, response) {
    if (request.method === 'HEAD' && request.url === '/') {
      response.writeHead(200).end()
      return
    }
    if (request.method === 'POST' && request.url === '/internal/attachments/requests') {
      const body = await readRequestJson(request)
      if (mode === 'failure') {
        response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'offline bridge failure' }))
        return
      }
      response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ id: body.runId, status: 'pending' }))
      return
    }
    if (request.method === 'GET' && request.url.includes('/wait?')) {
      if (mode === 'blocked') {
        notifyBlockedRequest?.()
        request.once('aborted', () => response.destroy())
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        status: 'completed',
        result: { executorTask: 'bounded offline task' },
      }))
      return
    }
    if (request.method === 'POST' && request.url.endsWith('/cancel')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end('{}')
  }

  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setMode(value) {
      mode = value
      if (mode === 'blocked') {
        blockedRequestSeen = new Promise(resolve => { notifyBlockedRequest = resolve })
      }
    },
    async waitForBlockedRequest() {
      await blockedRequestSeen
    },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

async function readRequestJson(request) {
  let body = ''
  for await (const chunk of request) body += chunk
  return JSON.parse(body)
}

async function readCommandState(artifactRoot, runId) {
  return JSON.parse(await readFile(join(artifactRoot, runId, 'run-state.json'), 'utf8'))
}

async function readCommandManifest(artifactRoot, runId) {
  return JSON.parse(await readFile(join(artifactRoot, runId, 'run-manifest.json'), 'utf8'))
}
