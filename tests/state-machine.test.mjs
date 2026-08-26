import assert from 'node:assert/strict'
import test from 'node:test'
import { RunStateMachine } from '../src/contracts.mjs'

test('state machine routes accepted and one bounded fix', () => {
  const machine = new RunStateMachine({ runId: 'run-state', maxFixes: 1 })
  machine.transition('ANALYZING')
  machine.transition('PLAN_READY')
  machine.transition('WAITING_FOR_APPROVAL')
  machine.transition('EXECUTING')
  machine.transition('COLLECTING_EVIDENCE')
  machine.transition('REVIEWING')
  assert.equal(machine.applyDecision('NEEDS_FIX'), 'EXECUTING')
  machine.transition('COLLECTING_EVIDENCE')
  machine.transition('REVIEWING')
  assert.equal(machine.applyDecision('NEEDS_FIX'), 'STOPPED')
  assert.equal(machine.fixCount, 1)
  assert.match(machine.snapshot().audit.at(-1).reason, /budget/)
})

test('invalid transitions and decisions fail closed', () => {
  const machine = new RunStateMachine({ runId: 'run-invalid', maxFixes: 1 })
  assert.throws(() => machine.transition('REVIEWING'), /invalid transition/)
  machine.transition('ANALYZING')
  assert.throws(() => machine.applyDecision('ACCEPTED'), /not valid/)
  assert.throws(() => machine.transition('NOT_A_STATE'), /unknown state/)
})
