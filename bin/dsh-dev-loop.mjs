#!/usr/bin/env node
import { readFile, mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ArtifactStore, createProjectZip, exposeArtifact } from '../src/artifacts.mjs'
import { BridgeClient } from '../src/bridge-client.mjs'
import { DevLoopController } from '../src/controller.mjs'
import { createEvidenceCollector, createGitEvidenceAdapter } from '../src/evidence.mjs'

const [command, ...args] = process.argv.slice(2)

if (command === 'package') {
  await packageCommand(args)
} else if (command === 'run') {
  await runCommand(args)
} else {
  fail('usage: dsh-dev-loop package|run ...')
}

async function packageCommand(values) {
  const project = option(values, '--project')
  const output = option(values, '--output')
  if (!project || !output) fail('package requires --project and --output')
  const runId = option(values, '--run-id') ?? `package-${Date.now()}`
  await mkdir(output, { recursive: true })
  const store = await new ArtifactStore({ root: output }).init()
  const result = await createProjectZip(store, { runId, projectRoot: project, stage: 'planner' })
  console.log(JSON.stringify({ runId, artifact: exposeArtifact(result.artifact), files: result.files.length }, null, 2))
}

async function runCommand(values) {
  const projectRoot = option(values, '--project')
  const artifactRoot = option(values, '--output')
  const executorModule = option(values, '--executor-module')
  const problemPackage = await readProblem(values)
  if (!projectRoot || !artifactRoot) fail('run requires --project and --output')
  if (!executorModule) fail('run requires --executor-module; standalone subscription APIs are intentionally unsupported')
  const store = await new ArtifactStore({ root: artifactRoot }).init()
  const gitAdapter = createGitEvidenceAdapter({ projectRoot: resolve(projectRoot), artifactRoot: store.root })
  const trustedProjectRoot = gitAdapter.projectRoot
  const executor = await loadExecutor(executorModule, { projectRoot: trustedProjectRoot, artifactRoot: store.root })
  if (typeof executor.executeTest !== 'function') fail('executor module must provide executeTest() wired to DSH Agent tools; local test runners are unsupported')
  const bridge = new BridgeClient({
    baseUrl: option(values, '--bridge-url') ?? process.env.DSH_BRIDGE_URL ?? 'http://127.0.0.1:7688',
    token: option(values, '--bridge-token') ?? process.env.DSH_BRIDGE_TOKEN ?? '',
    timeoutMs: Number(option(values, '--bridge-timeout-ms') ?? 300_000),
  })
  const testCommand = parseTestCommand(option(values, '--test-command'))
  const evidenceCollector = createEvidenceCollector({
    store,
    gitAdapter,
    testExecutor: request => executor.executeTest(request),
    testCommand,
  })
  const controller = new DevLoopController({
    store,
    bridge,
    executor,
    evidenceCollector,
    gitAdapter,
    projectRoot: trustedProjectRoot,
    runIdFactory: () => option(values, '--run-id') ?? `run-${Date.now()}`,
  })
  const result = await controller.run({
    projectRoot: trustedProjectRoot,
    problemPackage,
    approval: values.includes('--approve'),
    executorTask: option(values, '--task'),
    plannerPrompt: option(values, '--planner-prompt'),
    reviewerPrompt: option(values, '--reviewer-prompt'),
    testCommand,
  })
  console.log(JSON.stringify(result, null, 2))
}

async function loadExecutor(modulePath, options) {
  const url = pathToFileURL(isAbsolute(modulePath) ? modulePath : resolve(modulePath)).href
  const module = await import(url)
  if (typeof module.createExecutor === 'function') return module.createExecutor(options)
  if (typeof module.default?.createExecutor === 'function') return module.default.createExecutor(options)
  if (typeof module.execute === 'function') return { execute: module.execute, executeTest: module.executeTest }
  if (typeof module.default?.execute === 'function') return { execute: module.default.execute, executeTest: module.default.executeTest }
  throw new Error('executor module must export createExecutor() or execute()')
}

async function readProblem(values) {
  const file = option(values, '--problem-file')
  const inline = option(values, '--problem-json')
  if (!file && !inline) fail('run requires --problem-file or --problem-json')
  const value = JSON.parse(file ? await readFile(file, 'utf8') : inline)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('problem package must be a JSON object')
  return value
}

function parseTestCommand(value) {
  if (!value) return ['npm', ['run', 'verify:quick']]
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.some(item => typeof item !== 'string')) fail('--test-command must be a JSON array of strings')
  return [parsed[0], parsed.slice(1)]
}

function option(values, name) {
  const index = values.indexOf(name)
  return index >= 0 ? values[index + 1] : undefined
}

function fail(message) {
  console.error(message)
  process.exit(2)
}
