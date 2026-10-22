export const STATES = Object.freeze([
  'IDLE',
  'CHECKING_ENVIRONMENT',
  'ANALYZING',
  'PLAN_READY',
  'WAITING_FOR_APPROVAL',
  'EXECUTING',
  'COLLECTING_EVIDENCE',
  'REVIEWING',
  'COMPLETE',
  'STOPPED',
  'FAILED',
  'CANCELLED',
])

export const DECISIONS = Object.freeze([
  'ACCEPTED',
  'NEEDS_FIX',
  'NEEDS_REPLAN',
  'DEFER',
  'ESCALATE',
])

const TRANSITIONS = Object.freeze({
  IDLE: new Set(['CHECKING_ENVIRONMENT', 'ANALYZING', 'FAILED', 'CANCELLED']),
  CHECKING_ENVIRONMENT: new Set(['ANALYZING', 'EXECUTING', 'FAILED', 'CANCELLED']),
  ANALYZING: new Set(['PLAN_READY', 'STOPPED', 'FAILED', 'CANCELLED']),
  PLAN_READY: new Set(['WAITING_FOR_APPROVAL', 'EXECUTING', 'STOPPED', 'FAILED', 'CANCELLED']),
  WAITING_FOR_APPROVAL: new Set(['CHECKING_ENVIRONMENT', 'EXECUTING', 'ANALYZING', 'STOPPED', 'FAILED', 'CANCELLED']),
  EXECUTING: new Set(['COLLECTING_EVIDENCE', 'STOPPED', 'FAILED', 'CANCELLED']),
  COLLECTING_EVIDENCE: new Set(['REVIEWING', 'STOPPED', 'FAILED', 'CANCELLED']),
  REVIEWING: new Set(['COMPLETE', 'EXECUTING', 'ANALYZING', 'WAITING_FOR_APPROVAL', 'STOPPED', 'FAILED', 'CANCELLED']),
  COMPLETE: new Set(),
  STOPPED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
})

export class RunStateMachine {
  constructor({ runId, maxFixes = 1, initialSnapshot } = {}) {
    if (typeof runId !== 'string' || runId.trim() === '') throw new Error('runId is required')
    if (!Number.isSafeInteger(maxFixes) || maxFixes < 0) throw new Error('maxFixes must be a non-negative safe integer')
    this.runId = runId
    this.maxFixes = maxFixes
    this.state = 'IDLE'
    this.fixCount = 0
    this.audit = []
    if (initialSnapshot !== undefined) this.restore(initialSnapshot)
  }

  restore(snapshot) {
    if (!snapshot || snapshot.runId !== this.runId || !STATES.includes(snapshot.state)) throw new Error('invalid initial state snapshot')
    if (snapshot.maxFixes !== undefined && snapshot.maxFixes !== this.maxFixes) throw new Error('initial maxFixes does not match controller policy')
    if (!Number.isSafeInteger(snapshot.fixCount) || snapshot.fixCount < 0 || snapshot.fixCount > this.maxFixes) throw new Error('invalid initial fix count')
    if (!Array.isArray(snapshot.audit)) throw new Error('invalid initial audit')
    this.state = snapshot.state
    this.fixCount = snapshot.fixCount
    this.audit = snapshot.audit.map(entry => ({ ...entry }))
    return this
  }

  transition(next, metadata = {}) {
    if (!STATES.includes(next)) throw new Error(`unknown state: ${next}`)
    if (!TRANSITIONS[this.state]?.has(next)) {
      throw new Error(`invalid transition ${this.state} -> ${next}`)
    }
    const previous = this.state
    this.state = next
    this.audit.push({
      at: new Date().toISOString(),
      runId: this.runId,
      from: previous,
      to: next,
      ...metadata,
    })
    return this.state
  }

  applyDecision(decision, metadata = {}) {
    if (!DECISIONS.includes(decision)) throw new Error(`unknown review decision: ${decision}`)
    if (this.state !== 'REVIEWING') throw new Error(`review decision is not valid in ${this.state}`)
    switch (decision) {
      case 'ACCEPTED':
        this.transition('COMPLETE', { decision, ...metadata })
        break
      case 'NEEDS_FIX':
        if (this.fixCount >= this.maxFixes) {
          this.transition('STOPPED', { decision, reason: 'automatic fix budget exhausted', ...metadata })
        } else {
          this.fixCount += 1
          this.transition('EXECUTING', { decision, fixCount: this.fixCount, ...metadata })
        }
        break
      case 'NEEDS_REPLAN':
        this.transition('ANALYZING', { decision, ...metadata })
        break
      case 'DEFER':
        this.transition('WAITING_FOR_APPROVAL', { decision, ...metadata })
        break
      case 'ESCALATE':
        this.transition('STOPPED', { decision, ...metadata })
        break
    }
    return this.state
  }

  snapshot() {
    return {
      runId: this.runId,
      state: this.state,
      fixCount: this.fixCount,
      maxFixes: this.maxFixes,
      audit: this.audit.map(entry => ({ ...entry })),
    }
  }
}

export function assertDecision(value) {
  if (!DECISIONS.includes(value)) throw new Error(`invalid review decision: ${String(value)}`)
  return value
}

export function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}
