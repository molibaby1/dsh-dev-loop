import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as plugin from '../src/plugin.mjs'
import * as livePlugin from '../src/live-plugin.mjs'

test('plugin entry preserves Cordis injection metadata', () => {
  assert.equal('default' in plugin, false)
  assert.equal(plugin.name, 'dev-loop')
  assert.deepEqual(plugin.inject, ['agents', 'agentPresets', 'commands', 'permissionPresets'])
  assert.equal(typeof plugin.apply, 'function')
})

test('live plugin entry preserves Cordis injection metadata', () => {
  assert.equal('default' in livePlugin, false)
  assert.equal(livePlugin.name, 'dev-loop-live')
  assert.deepEqual(livePlugin.inject, ['agents', 'agentPresets', 'commands', 'permissionPresets'])
  assert.equal(typeof livePlugin.apply, 'function')
})

test('Web patch uses the workspace-write DSH permission preset by default', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /permissionPreset: 'workspace-write'/)
  assert.doesNotMatch(patch, /permissionPreset: 'danger-full-access'/)
})
