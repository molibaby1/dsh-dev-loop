import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('CLI run rejects executors without a DSH test-tool adapter before workflow submission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loop-cli-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  const output = join(root, 'artifacts')
  const executorModule = join(root, 'executor.mjs')
  await mkdir(project)
  await writeFile(executorModule, 'export async function execute() { return {} }\n')

  const result = spawnSync(process.execPath, [
    new URL('../bin/dsh-dev-loop.mjs', import.meta.url).pathname,
    'run', '--project', project, '--output', output, '--problem-json', '{}', '--executor-module', executorModule,
  ], { encoding: 'utf8' })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /executeTest\(\) wired to DSH Agent tools/)
  assert.doesNotMatch(result.stderr, /fetch|Bridge|test command started/)
})
