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

test('approved plan can execute without entering the approval wait state', () => {
  const machine = new RunStateMachine({ runId: 'run-auto-approved', maxFixes: 1 })
  machine.transition('ANALYZING')
  machine.transition('PLAN_READY')
  assert.equal(machine.transition('EXECUTING'), 'EXECUTING')
})

test('active states can terminate as failed or cancelled', () => {
  for (const terminal of ['FAILED', 'CANCELLED']) {
    const machine = new RunStateMachine({ runId: `run-${terminal.toLowerCase()}`, maxFixes: 1 })
    machine.transition('CHECKING_ENVIRONMENT')
    assert.equal(machine.transition(terminal, { diagnosticCode: terminal }), terminal)
    assert.throws(() => machine.transition('ANALYZING'), /invalid transition/)
  }
})

test('state machine restores approval state and audit history', () => {
  const source = new RunStateMachine({ runId: 'run-restore' })
  source.transition('CHECKING_ENVIRONMENT')
  source.transition('ANALYZING')
  source.transition('PLAN_READY')
  source.transition('WAITING_FOR_APPROVAL')
  const restored = new RunStateMachine({ runId: 'run-restore', initialSnapshot: source.snapshot() })
  assert.equal(restored.state, 'WAITING_FOR_APPROVAL')
  assert.equal(restored.audit.length, source.audit.length)
  restored.transition('EXECUTING')
  assert.equal(restored.state, 'EXECUTING')
})

test('invalid transitions and decisions fail closed', () => {
  const machine = new RunStateMachine({ runId: 'run-invalid', maxFixes: 1 })
  assert.throws(() => machine.transition('REVIEWING'), /invalid transition/)
  machine.transition('ANALYZING')
  assert.throws(() => machine.applyDecision('ACCEPTED'), /not valid/)
  assert.throws(() => machine.transition('NOT_A_STATE'), /unknown state/)
})
