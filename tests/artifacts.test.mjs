import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore, createProjectZip, finalizeArtifact } from '../src/artifacts.mjs'

test('artifact store records hash and rejects oversized bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-artifacts-'))
  const store = await new ArtifactStore({ root, maxArtifactBytes: 32, maxZipBytes: 32 }).init()
  const descriptor = await finalizeArtifact(await store.writeText({ runId: 'run-a', stage: 'test', name: 'report.md', mime: 'text/markdown', text: 'marker', source: 'test' }))
  assert.equal(descriptor.bytes, 6)
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/)
  await assert.rejects(
    store.writeBytes({ runId: 'run-a', stage: 'test', name: 'too-large.bin', mime: 'application/octet-stream', bytes: Buffer.alloc(33) }),
    /byte limit/,
  )
})

test('project packaging rejects symlink escape and excludes secrets and generated folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-project-'))
  const project = join(root, 'project')
  const output = join(root, 'artifacts')
  await mkdir(join(project, 'src'), { recursive: true })
  await mkdir(join(project, 'node_modules'), { recursive: true })
  await mkdir(join(project, 'artifacts'), { recursive: true })
  await writeFile(join(project, 'src', 'marker.txt'), 'UNIQUE_FIXTURE_MARKER')
  await writeFile(join(project, '.env'), 'SECRET=do-not-package')
  await writeFile(join(project, '.env.example'), 'SECRET=example')
  await writeFile(join(project, 'node_modules', 'ignored.txt'), 'ignored')
  await writeFile(join(project, 'artifacts', 'ignored.txt'), 'ignored')
  const store = await new ArtifactStore({ root: output, maxArtifactBytes: 1024 * 1024, maxZipBytes: 1024 * 1024 }).init()
  const result = await createProjectZip(store, { runId: 'run-package', projectRoot: project })
  const bytes = await readFile(result.artifact.localPath)
  assert.ok(bytes.length > 0)
  assert.ok(result.files.includes('src/marker.txt'))
  assert.ok(result.files.includes('.env.example'))
  assert.ok(!result.files.includes('.env'))
  assert.ok(!result.files.some(file => file.startsWith('node_modules/')))

  await symlink(join(root, 'outside.txt'), join(project, 'src', 'escape.txt'))
  await assert.rejects(createProjectZip(store, { runId: 'run-package-2', projectRoot: project }), /symbolic link/)
})
