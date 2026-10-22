import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

test('client plugin registers a dev-loop conversation definition and card renderer', async () => {
  const source = await readFile(new URL('../client-plugin/lib/client.js', import.meta.url), 'utf8')
  let registration
  const document = {
    head: { appendChild() {} },
    querySelector() { return null },
    createElement() { return { dataset: {}, textContent: '' } },
  }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document,
    Set,
    Object,
    JSON,
  })
  assert.equal(registration.id, 'dsh-dev-loop-ui')
  const React = { memo: component => component, createElement: () => ({}) }
  const plugin = registration.factory(specifier => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })
  let definition
  let slot
  plugin.apply({
    conversationEvents: { register(value) { definition = value } },
    slots: {
      inject(_name, callback) { callback() },
      register(config, component) { slot = { config, component } },
    },
  })
  assert.equal(definition.kind, 'dev-loop-run')
  const match = definition.match({ type: 'dev-loop/run-started', seq: 1, data: { runId: 'run-ui' } })
  assert.equal(match.id, 'run-ui')
  assert.equal(match.role, 'start')
  const state = definition.start({}, { event: { data: {
    runId: 'run-ui',
    at: '2026-08-30T00:00:00.000Z',
    fingerprint: { backend: { buildId: 'backend-test' }, client: { buildId: 'client-test' } },
    projectRoot: '/tmp/project',
  } } })
  assert.equal(state.fingerprint.backend.buildId, 'backend-test')
  const updated = definition.update({ state }, { event: { type: 'dev-loop/progress', data: {
    runId: 'run-ui', stage: 'WAITING_FOR_APPROVAL', fingerprint: state.fingerprint,
  } } })
  assert.equal(updated.fingerprint.client.buildId, 'client-test')
  assert.equal(slot.config.key, 'dev-loop-card')
  assert.equal(typeof slot.component, 'function')
})
