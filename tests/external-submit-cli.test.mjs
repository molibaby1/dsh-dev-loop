import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeM2ExternalSubmitInput } from '../src/m2-request.mjs'

test('m2 submit follows the DSH Remote wire contract for the selected Web Session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = await realpath(root)
  const tokenFile = await writeStartupTokenFile(t)
  const requestFile = join(root, 'm2-request.json')
  const request = validRequest()
  await writeFile(requestFile, `${JSON.stringify(request)}\n`)

  const requests = []
  const hostErrors = []
  const server = createServer(async (incoming, outgoing) => {
    if (respondToConnect(incoming, outgoing, requests)) return
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ path: new URL(incoming.url, 'http://dsh.test').pathname, body })
    try {
      assert.equal(incoming.headers['content-type'], 'application/json')
      assert.equal(incoming.headers.cookie, 'dsh-api=fixture-cookie')
      assert.equal(body.type, 'client-request')
      const value = await dispatchFakeWebHost(body, { projectRoot, requests })
      outgoing.writeHead(200, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }))
    } catch (error) {
      hostErrors.push(error)
      outgoing.writeHead(500, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ error: error.message }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await runCli([
    'm2', 'submit',
    '--profile', 'web',
    '--project-root', projectRoot,
    '--session-id', 'existing-web-session',
    '--request-file', requestFile,
    '--token-file', tokenFile,
    '--port', String(address.port),
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    runId: 'm2-fixture-run',
    requestId: request.requestId,
    sessionId: 'existing-web-session',
    state: 'WAITING_FOR_APPROVAL',
    projectRoot,
    planSha256: 'a'.repeat(64),
    deduplicated: false,
  })
  // DSH 0.2.1-rc.2's generated commands Remote uses slash endpoints and `agentId` on the wire.
  assert.deepEqual(requests.map(item => item.path), [
    '/connect',
    '/api/session/list',
    '/api/commands/list',
    '/api/commands/execute',
  ])
  assert.equal(requests[0].token, 'valid-startup-token')
  assert.equal(requests[0].interactions, 'none')
  assert.deepEqual(requests[1].body.payload.args, { _request: {} })
  const commandArgs = requests[3].body.payload.args
  assert.deepEqual(Object.keys(commandArgs).sort(), ['agentId', 'line', 'submittedAttachments'])
  assert.equal(commandArgs.agentId, 'existing-web-session')
  assert.equal(Object.hasOwn(commandArgs, 'sessionId'), false)
  assert.deepEqual(commandArgs.submittedAttachments, [])
  assert.equal(Object.hasOwn(commandArgs, 'images'), false)
  assert.match(commandArgs.line, /^\/dev-loop-m2 提交外部方案文件 /u)
  assert.deepEqual(decodeM2ExternalSubmitInput(commandArgs.line.split(' ').at(-1)), {
    requestFile,
    projectRoot,
    requestFileSha256: (await sha256(await readFile(requestFile))),
  })
  assert.deepEqual(hostErrors, [])
})

test('m2 submit rejects a Session absent from the matching Host workspace before command dispatch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-cli-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = await realpath(root)
  const tokenFile = await writeStartupTokenFile(t)
  const requestFile = join(root, 'm2-request.json')
  await writeFile(requestFile, JSON.stringify(validRequest()))
  const requests = []
  const server = createServer(async (incoming, outgoing) => {
    if (respondToConnect(incoming, outgoing, requests)) return
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ path: new URL(incoming.url, 'http://dsh.test').pathname, body })
    assert.equal(incoming.headers.cookie, 'dsh-api=fixture-cookie')
    outgoing.writeHead(200, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { items: [] } },
    }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await runCli([
    'm2', 'submit', '--profile', 'web', '--project-root', projectRoot,
    '--session-id', 'missing-session', '--request-file', requestFile,
    '--token-file', tokenFile, '--port', String(address.port),
  ])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /DSH Session.*project/u)
  assert.deepEqual(requests.map(request => request.path), ['/connect', '/api/session/list'])
})

test('m2 submit rejects a Session whose Host cwd differs from project-root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-cli-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = await realpath(root)
  const otherRoot = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-cli-other-project-'))
  t.after(() => rm(otherRoot, { recursive: true, force: true }))
  const otherProjectRoot = await realpath(otherRoot)
  const tokenFile = await writeStartupTokenFile(t)
  const requestFile = join(root, 'm2-request.json')
  await writeFile(requestFile, JSON.stringify(validRequest()))
  const requests = []
  const server = createServer(async (incoming, outgoing) => {
    if (respondToConnect(incoming, outgoing, requests)) return
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ path: new URL(incoming.url, 'http://dsh.test').pathname, body })
    assert.equal(incoming.headers.cookie, 'dsh-api=fixture-cookie')
    outgoing.writeHead(200, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { items: [{ sessionId: 'existing-web-session', cwd: otherProjectRoot }] } },
    }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await runCli([
    'm2', 'submit', '--profile', 'web', '--project-root', projectRoot,
    '--session-id', 'existing-web-session', '--request-file', requestFile,
    '--token-file', tokenFile, '--port', String(address.port),
  ])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /DSH Session.*project/u)
  assert.deepEqual(requests.map(request => request.path), ['/connect', '/api/session/list'])
})

test('m2 submit rejects a stale startup token before making API requests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-cli-token-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = await realpath(root)
  const tokenFile = await writeStartupTokenFile(t, 'stale-startup-token')
  const requestFile = join(root, 'm2-request.json')
  await writeFile(requestFile, JSON.stringify(validRequest()))
  const requests = []
  const server = createServer(async (incoming, outgoing) => {
    if (respondToConnect(incoming, outgoing, requests)) return
    requests.push({ path: new URL(incoming.url, 'http://dsh.test').pathname })
    outgoing.writeHead(500)
    outgoing.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await runCli([
    'm2', 'submit', '--profile', 'web', '--project-root', projectRoot,
    '--session-id', 'existing-web-session', '--request-file', requestFile,
    '--token-file', tokenFile, '--port', String(address.port),
  ])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /startup token.*expired|Host restarted/u)
  assert.deepEqual(requests.map(request => request.path), ['/connect'])
})

test('m2 submit refuses a startup-token file readable by other users', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-cli-token-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = await realpath(root)
  const tokenFile = await writeStartupTokenFile(t, 'valid-startup-token', 0o644)
  const requestFile = join(root, 'm2-request.json')
  await writeFile(requestFile, JSON.stringify(validRequest()))
  const requests = []
  const server = createServer((incoming, outgoing) => {
    requests.push(incoming.url)
    outgoing.writeHead(500)
    outgoing.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await runCli([
    'm2', 'submit', '--profile', 'web', '--project-root', projectRoot,
    '--session-id', 'existing-web-session', '--request-file', requestFile,
    '--token-file', tokenFile, '--port', String(address.port),
  ])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /owner-only permissions/u)
  assert.deepEqual(requests, [])
})

test('m2 submit refuses to read a startup-token file from the target project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-cli-token-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = await realpath(root)
  const tokenFile = join(root, 'web-startup-token')
  await writeFile(tokenFile, 'valid-startup-token\n', { mode: 0o600 })
  const requestFile = join(root, 'm2-request.json')
  await writeFile(requestFile, JSON.stringify(validRequest()))
  const requests = []
  const server = createServer((incoming, outgoing) => {
    requests.push(incoming.url)
    outgoing.writeHead(500)
    outgoing.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await runCli([
    'm2', 'submit', '--profile', 'web', '--project-root', projectRoot,
    '--session-id', 'existing-web-session', '--request-file', requestFile,
    '--token-file', tokenFile, '--port', String(address.port),
  ])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /token-file must be stored outside project-root/u)
  assert.deepEqual(requests, [])
})

test('m2 submit rejects missing commands, unmatched commands, Host failures, bad RPC envelopes, and invalid receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-cli-rejections-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = await realpath(root)
  const tokenFile = await writeStartupTokenFile(t)
  const requestFile = join(root, 'm2-request.json')
  await writeFile(requestFile, JSON.stringify(validRequest()))
  const requests = []
  let scenario = 'missing-command'
  const server = createServer(async (incoming, outgoing) => {
    if (respondToConnect(incoming, outgoing, requests)) return
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push({ path: new URL(incoming.url, 'http://dsh.test').pathname, body })
    try {
      assert.equal(incoming.headers.cookie, 'dsh-api=fixture-cookie')
      if (scenario === 'api-unauthorized') {
        outgoing.writeHead(401)
        outgoing.end()
        return
      }
      const value = await dispatchFakeWebHost(body, { projectRoot, scenario })
      if (scenario === 'host-rpc-error') {
        outgoing.writeHead(200, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: false, error: { code: 'session-not-found', message: 'missing session', details: { sessionId: 'existing-web-session' } } },
        }))
        return
      }
      const rpcId = scenario === 'bad-rpc-envelope' ? 'wrong-rpc-id' : body.rpcId
      outgoing.writeHead(200, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
    } catch (error) {
      outgoing.writeHead(500, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ error: error.message }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const cases = [
    { scenario: 'missing-command', path: ['/connect', '/api/session/list', '/api/commands/list'], message: /no registered \/dev-loop-m2/u },
    { scenario: 'unmatched-command', path: ['/connect', '/api/session/list', '/api/commands/list', '/api/commands/execute'], message: /did not resolve \/dev-loop-m2/u },
    { scenario: 'execution-error', path: ['/connect', '/api/session/list', '/api/commands/list', '/api/commands/execute'], message: /simulated Host command failure/u },
    { scenario: 'api-unauthorized', path: ['/connect', '/api/session/list'], message: /rejected the API cookie/u },
    { scenario: 'bad-rpc-envelope', path: ['/connect', '/api/session/list'], message: /invalid RPC envelope/u },
    { scenario: 'host-rpc-error', path: ['/connect', '/api/session/list'], message: /session-not-found/u },
    ...['runId', 'requestId', 'sessionId', 'projectRoot', 'state', 'planSha256'].map(field => ({
      scenario: `invalid-${field}`,
      path: ['/connect', '/api/session/list', '/api/commands/list', '/api/commands/execute'],
      message: /receipt does not match/u,
    })),
    { scenario: 'missing-command-id', path: ['/connect', '/api/session/list', '/api/commands/list', '/api/commands/execute'], message: /did not resolve \/dev-loop-m2/u },
  ]
  for (const item of cases) {
    scenario = item.scenario
    requests.length = 0
    const result = await runCli([
      'm2', 'submit', '--profile', 'web', '--project-root', projectRoot,
      '--session-id', 'existing-web-session', '--request-file', requestFile,
      '--token-file', tokenFile, '--port', String(address.port),
    ])
    assert.equal(result.status, 2, item.scenario)
    assert.match(result.stderr, item.message, item.scenario)
    assert.deepEqual(requests.map(request => request.path), item.path, item.scenario)
  }
})

async function dispatchFakeWebHost(body, { projectRoot, scenario = 'success' }) {
  if (body.method === 'session/list') {
    assert.deepEqual(body.payload.args, { _request: {} })
    return { items: [{ sessionId: 'existing-web-session', cwd: projectRoot }] }
  }
  if (body.method === 'commands/list') {
    assert.deepEqual(body.payload.args, { agentId: 'existing-web-session' })
    return scenario === 'missing-command' ? [] : [{ name: 'dev-loop-m2', description: 'M2 handoff' }]
  }
  if (body.method === 'commands/execute') {
    const args = body.payload.args
    assert.deepEqual(Object.keys(args).sort(), ['agentId', 'line', 'submittedAttachments'])
    assert.equal(args.agentId, 'existing-web-session')
    assert.equal(Object.hasOwn(args, 'sessionId'), false)
    assert.deepEqual(args.submittedAttachments, [])
    assert.equal(Object.hasOwn(args, 'images'), false)
    if (scenario === 'unmatched-command') return undefined
    if (scenario === 'execution-error') {
      return { commandId: 'command-error', result: { kind: 'error', text: 'simulated Host command failure' } }
    }
    const encoded = args.line.split(' ').at(-1)
    const requestInput = decodeM2ExternalSubmitInput(encoded)
    assert.equal(requestInput.projectRoot, projectRoot)
    const source = JSON.parse(await requestFileJson(requestInput.requestFile))
    const receipt = {
      runId: scenario === 'invalid-runId' ? '' : 'm2-fixture-run',
      requestId: source.requestId,
      sessionId: args.agentId,
      state: 'WAITING_FOR_APPROVAL',
      projectRoot,
      planSha256: 'a'.repeat(64),
      deduplicated: false,
    }
    if (scenario === 'invalid-requestId') receipt.requestId = 'wrong-request-id'
    if (scenario === 'invalid-sessionId') receipt.sessionId = 'wrong-session-id'
    if (scenario === 'invalid-projectRoot') receipt.projectRoot = '/wrong/project'
    if (scenario === 'invalid-state') receipt.state = 'COMPLETE'
    if (scenario === 'invalid-planSha256') receipt.planSha256 = 'not-a-sha256'
    if (scenario === 'missing-command-id') return { result: { kind: 'success', text: JSON.stringify(receipt) } }
    return { commandId: 'command-1', result: { kind: 'success', text: JSON.stringify(receipt) } }
  }
  throw new Error(`unexpected DSH Remote method ${body.method}`)
}

function requestFileJson(path) {
  return readFile(path, 'utf8')
}

async function writeStartupTokenFile(t, token = 'valid-startup-token', mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-loop-m2-token-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'web-startup-token')
  await writeFile(path, `${token}\n`, { mode })
  return path
}

function respondToConnect(incoming, outgoing, requests) {
  const url = new URL(incoming.url, 'http://dsh.test')
  if (url.pathname !== '/connect') return false
  const token = url.searchParams.get('token')
  const interactions = url.searchParams.get('interactions')
  requests.push({ path: url.pathname, token, interactions })
  if (incoming.method !== 'GET' || token !== 'valid-startup-token' || interactions !== 'none') {
    outgoing.writeHead(401, { 'content-type': 'text/plain' })
    outgoing.end('unauthorized')
    return true
  }
  outgoing.writeHead(302, {
    location: './api/remote.mux',
    'set-cookie': 'dsh-api=fixture-cookie; Path=/; HttpOnly; SameSite=Strict',
  })
  outgoing.end()
  return true
}

function sha256(bytes) {
  return import('node:crypto').then(({ createHash }) => createHash('sha256').update(bytes).digest('hex'))
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../bin/dsh-dev-loop.mjs', import.meta.url).pathname, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
}

function validRequest() {
  return {
    schema: 1,
    requestId: 'cli-request-1',
    source: { type: 'chatgpt-web', conversationUrl: 'https://chatgpt.com/c/example' },
    plan: {
      schema: 1,
      summary: 'Add one bounded behavior.',
      scope: { includedPaths: ['src/example.mjs'], excludedPaths: [], nonGoals: [] },
      acceptanceCriteria: ['The behavior is present.'],
      executionRequirements: ['Run the focused check.'],
      contextSources: ['Current local Web Host workspace.'],
      observedContext: { branch: 'dev', commit: 'b'.repeat(40) },
      executorTask: 'Use the full task body supplied in the request file.\nKeep its second line.',
    },
  }
}
