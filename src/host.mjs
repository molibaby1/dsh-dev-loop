import { ArtifactStore } from './artifacts.mjs'
import { BridgeClient } from './bridge-client.mjs'
import { DevLoopController } from './controller.mjs'
import { createDshCodexExecutor } from './dsh-executor.mjs'
import { createEvidenceCollector } from './evidence.mjs'

/** Compose the Controller inside an already-mounted DSH host. */
export async function createDshDevLoopController({ ctx, config = {} } = {}) {
  if (!ctx) throw new Error('DSH context is required')
  const artifactRoot = config.artifactRoot
  if (!artifactRoot) throw new Error('artifactRoot is required')
  const store = await new ArtifactStore({
    root: artifactRoot,
    maxArtifactBytes: config.maxArtifactBytes,
    maxZipBytes: config.maxZipBytes,
  }).init()
  const bridge = new BridgeClient({
    baseUrl: config.bridgeBaseUrl,
    token: config.bridgeToken,
    timeoutMs: config.bridgeTimeoutMs,
  })
  const executor = createDshCodexExecutor({
    ctx,
    provider: config.provider,
    model: config.model,
    permissionPreset: config.permissionPreset,
  })
  const evidenceCollector = createEvidenceCollector({
    store,
    testCommand: config.testCommand,
  })
  return new DevLoopController({
    store,
    bridge,
    executor,
    evidenceCollector,
    maxFixes: 1,
  })
}
