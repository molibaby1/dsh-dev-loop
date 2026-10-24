import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPreflightChecker } from '../src/preflight.mjs'

async function roots() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-preflight-'))
  const projectRoot = join(root, 'project')
  const artifactRoot = join(root, 'artifacts')
  await mkdir(projectRoot)
  await mkdir(artifactRoot)
  return { projectRoot, artifactRoot }
}

test('preflight reports successful read-only dependency checks', async () => {
  const { projectRoot, artifactRoot } = await roots()
  const calls = []
  const gitAdapter = async request => {
    calls.push(request)
    return { exitCode: 0, stdout: request.operation === 'root' ? `${projectRoot}\n` : '', stderr: '' }
  }
  const checker = createPreflightChecker({
    gitAdapter,
    checkZip: async () => ({ exitCode: 0, stderr: '' }),
    bridge: { probe: async () => ({ ok: true, checked: true, status: 404 }) },
    runtime: { agents: true, agentPresets: true, permissionPresets: true },
  })
  const result = await checker({ projectRoot, artifactRoot })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call.operation), ['root'])
  assert.equal(result.bridge.checked, true)
})

test('manual handoff preflight checks project runtime without ZIP or Bridge probes', async () => {
  const { projectRoot, artifactRoot } = await roots()
  let zipChecks = 0
  let bridgeChecks = 0
  const checker = createPreflightChecker({
    gitAdapter: async request => ({ exitCode: 0, stdout: request.operation === 'root' ? `${projectRoot}\n` : '', stderr: '' }),
    checkZip: async () => { zipChecks += 1; return { exitCode: 0, stderr: '' } },
    bridge: { probe: async () => { bridgeChecks += 1; return { ok: true, checked: true } } },
    runtime: { agents: true, agentPresets: true, permissionPresets: true },
    transport: 'manual-handoff',
  })

  const result = await checker({ projectRoot, artifactRoot })

  assert.equal(result.ok, true)
  assert.equal(result.transport, 'manual-handoff')
  assert.equal(result.zip.skipped, true)
  assert.equal(result.bridge.skipped, true)
  assert.equal(zipChecks, 0)
  assert.equal(bridgeChecks, 0)
})

test('preflight rejects an artifact root that is a regular file', async () => {
  const { projectRoot, artifactRoot } = await roots()
  const artifactFile = join(artifactRoot, 'not-a-directory')
  await writeFile(artifactFile, 'fixture')
  const checker = createPreflightChecker({
    gitAdapter: async () => ({ exitCode: 0, stdout: `${projectRoot}\n`, stderr: '' }),
    checkZip: async () => ({ exitCode: 0, stderr: '' }),
  })
  await assert.rejects(checker({ projectRoot, artifactRoot: artifactFile }), error => error.code === 'ARTIFACT_ROOT_INVALID')
})

test('preflight fails before execution when runtime services are missing', async () => {
  const { projectRoot, artifactRoot } = await roots()
  const checker = createPreflightChecker({
    gitAdapter: async () => ({ exitCode: 0, stdout: `${projectRoot}\n`, stderr: '' }),
    checkZip: async () => ({ exitCode: 0, stderr: '' }),
    runtime: { agents: true, agentPresets: false, permissionPresets: true },
  })
  await assert.rejects(checker({ projectRoot, artifactRoot }), error => error.code === 'DSH_RUNTIME_MISSING')
})
