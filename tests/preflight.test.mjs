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
  const checker = createPreflightChecker({
    runCommand: async request => {
      calls.push(request)
      return { exitCode: 0, stdout: request.command === 'git' ? `${projectRoot}\n` : '', stderr: '' }
    },
    bridge: { probe: async () => ({ ok: true, checked: true, status: 404 }) },
    runtime: { agents: true, agentPresets: true, permissionPresets: true },
  })
  const result = await checker({ projectRoot, artifactRoot })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call.command), ['git', 'zip'])
  assert.equal(result.bridge.checked, true)
})

test('preflight rejects an artifact root that is a regular file', async () => {
  const { projectRoot, artifactRoot } = await roots()
  const artifactFile = join(artifactRoot, 'not-a-directory')
  await writeFile(artifactFile, 'fixture')
  const checker = createPreflightChecker({
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  })
  await assert.rejects(checker({ projectRoot, artifactRoot: artifactFile }), error => error.code === 'ARTIFACT_ROOT_INVALID')
})

test('preflight fails before execution when runtime services are missing', async () => {
  const { projectRoot, artifactRoot } = await roots()
  const checker = createPreflightChecker({
    runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runtime: { agents: true, agentPresets: false, permissionPresets: true },
  })
  await assert.rejects(checker({ projectRoot, artifactRoot }), error => error.code === 'DSH_RUNTIME_MISSING')
})
