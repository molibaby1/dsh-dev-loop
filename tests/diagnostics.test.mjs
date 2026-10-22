import assert from 'node:assert/strict'
import test from 'node:test'
import { DevLoopError, diagnosticForInput, diagnosticFromError } from '../src/diagnostics.mjs'

test('diagnostics provide stable Chinese guidance and redact credentials', () => {
  const error = new DevLoopError('BRIDGE_UNAUTHORIZED', 'Bridge HTTP 401 Bearer secret-token?token=abc', {
    details: { token: 'secret', status: 401 },
  })
  const diagnostic = diagnosticFromError(error, { phase: 'ANALYZING', runId: 'run-diag' })
  assert.equal(diagnostic.code, 'BRIDGE_UNAUTHORIZED')
  assert.equal(diagnostic.runId, 'run-diag')
  assert.match(diagnostic.title, /认证失败/)
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-token|"secret"/)
  assert.match(diagnostic.technical.message, /REDACTED/)
})

test('input diagnostics distinguish project and artifact configuration', () => {
  assert.equal(diagnosticForInput(new Error('projectRoot is required')).code, 'PROJECT_ROOT_INVALID')
  assert.equal(diagnosticForInput(new Error('artifactRoot must be absolute')).code, 'ARTIFACT_ROOT_INVALID')
})
