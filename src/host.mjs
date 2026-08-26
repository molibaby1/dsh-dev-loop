import { readFile } from 'node:fs/promises'
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
    token: await resolveBridgeToken(config),
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
