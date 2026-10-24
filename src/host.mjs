import { readFile } from 'node:fs/promises'
import { ArtifactStore } from './artifacts.mjs'
import { BridgeClient } from './bridge-client.mjs'
import { DevLoopController } from './controller.mjs'
import { createDshCodexExecutor } from './dsh-executor.mjs'
import { createEvidenceCollector, createGitEvidenceAdapter } from './evidence.mjs'
import { DevLoopError } from './diagnostics.mjs'
import { createPreflightChecker } from './preflight.mjs'
import { assertConfiguredProjectRoot } from './project-root.mjs'

/** Compose the Controller inside an already-mounted DSH host. */
export async function createDshDevLoopController({ ctx, config = {}, sessionId } = {}) {
  if (!ctx) throw new Error('DSH context is required')
  const mode = config.mode ?? 'legacy'
  if (!['legacy', 'manual-handoff'].includes(mode)) throw new Error(`unsupported dev-loop mode: ${String(mode)}`)
  const artifactRoot = config.artifactRoot
  if (!artifactRoot) throw new Error('artifactRoot is required')
  const projectRoot = assertConfiguredProjectRoot(config.projectRoot)
  let store
  try {
    store = await new ArtifactStore({
      root: artifactRoot,
      maxArtifactBytes: config.maxArtifactBytes,
      maxZipBytes: config.maxZipBytes,
    }).init()
  } catch (error) {
    throw new DevLoopError('ARTIFACT_ROOT_INVALID', `artifactRoot initialization failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  const bridge = mode === 'legacy'
    ? new BridgeClient({
      baseUrl: config.bridgeBaseUrl,
      token: await resolveBridgeToken(config),
      timeoutMs: config.bridgeTimeoutMs,
    })
    : undefined
  const executor = createDshCodexExecutor({
    ctx,
    provider: config.provider,
    model: config.model,
    permissionPreset: config.permissionPreset,
  })
  const gitAdapter = createGitEvidenceAdapter({
    projectRoot,
    artifactRoot: store.root,
  })
  const evidenceCollector = createEvidenceCollector({
    store,
    gitAdapter,
    artifactRoot: store.root,
    testExecutor: request => executor.executeTest(request),
    testCommand: config.testCommand,
  })
  const agentPresets = ctx.agentPresets ?? ctx.get?.('agentPresets')
  const preflight = createPreflightChecker({
    gitAdapter,
    bridge,
    transport: mode === 'manual-handoff' ? 'manual-handoff' : 'bridge',
    runtime: {
      agents: Boolean(ctx.agents),
      agentPresets: Boolean(agentPresets?.mount),
      permissionPresets: Boolean(ctx.permissionPresets?.set),
    },
  })
  return new DevLoopController({
    store,
    bridge,
    executor,
    evidenceCollector,
    gitAdapter,
    mode,
    projectRoot: gitAdapter.projectRoot,
    sessionId,
    preflight,
    maxFixes: 1,
  })
}

async function resolveBridgeToken(config) {
  if (typeof config.bridgeToken === 'string' && config.bridgeToken) return config.bridgeToken
  if (!config.bridgeTokenFile) return config.bridgeToken ?? ''
  const raw = await readFile(config.bridgeTokenFile, 'utf8')
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.staticToken === 'string' && parsed.staticToken) return parsed.staticToken
  } catch {}
  const token = raw.trim()
  if (!token) throw new Error('bridgeTokenFile is empty')
  return token
}
