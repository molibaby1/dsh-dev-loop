# AI Dual-Layer Development Loop — Phase 1

## Background

This repository owns a small development-loop Controller for a separate product repository. DeepSeek Harness remains the execution runtime and permission authority. `dsh-codex-subscription` provides the `openai-codex` route and `gpt-5.6-luna` model inside DSH. DSH-Brain-Bridge provides ChatGPT Web reasoning transport for Planner and Reviewer.

## Goal

Implement one bounded, evidence-driven run:

1. Package a small project artifact.
2. Send a Planner request with the artifact through the Bridge attachment transport.
3. Validate the Planner plan and authorize it automatically for the Web command (or wait for explicit approval when `autoApprove: false`).
4. Execute the authorized task through a DSH Agent using `openai-codex` / `gpt-5.6-luna`.
5. Collect report, diff, test result, and a fresh project artifact.
6. Send those artifacts to a Reviewer through the Bridge attachment transport.
7. Route one structured decision to `COMPLETE`, `EXECUTING`, `ANALYZING`, `WAITING`, or `STOPPED`.

## Non-goals

- No changes to the product repository from this Controller implementation.
- No DSH core changes.
- No automatic commit, merge, or push.
- No Workspace MCP restoration.
- No ChatGPT-native Shell, Search, Apps, or file execution plane.
- No unbounded retry loop, multi-project scheduling, management UI, or workflow engine.
- No default real-account smoke test.

## Authority boundaries

- Planner and Reviewer may return data only.
- Controller validates all Planner and Reviewer data before use.
- Executor changes the product only through the DSH Agent and its configured tools.
- All evidence collection uses an explicit DSH execution seam or a read-only local adapter with allowlisted commands.
- Local artifact paths remain inside Controller, Gateway, and Browser Worker protocol; they are never sent to ChatGPT.

## State machine

```text
IDLE
  -> ANALYZING
  -> PLAN_READY
  -> EXECUTING (Web command auto-approval)
  -> WAITING_FOR_APPROVAL (when autoApprove is false)
  -> COLLECTING_EVIDENCE
  -> REVIEWING

ACCEPTED      -> COMPLETE
NEEDS_FIX     -> EXECUTING (at most once)
NEEDS_REPLAN  -> ANALYZING
DEFER         -> WAITING_FOR_APPROVAL
ESCALATE      -> STOPPED
```

## Artifact contract

Every artifact descriptor includes `id`, `runId`, `stage`, `name`, `mime`, `bytes`, `sha256`, and `source`. The first phase uses:

- `run-manifest.json`
- `problem-package.json`
- `plan.json`
- `approval.json`
- `project.zip`
- `executor-report.md`
- `git-diff.patch`
- `test-result.json`
- `review.json`
- `audit-trace.json`

The Controller enforces a configured artifact root, canonical paths, symlink containment, byte limits, SHA-256 verification, idempotency keys, upload timeouts, and cleanup of temporary files.

## Product repository handling

The Controller targets a configured repository root and never resets or cleans it. It records the baseline commit, status, and diff before execution. Existing dirty work is evidence, not permission to discard or overwrite. The existing packaging exclusion rules are treated as input; generated run artifacts are written outside the product tree.

## Acceptance criteria

- A fixture project ZIP is generated with a stable manifest and hash.
- Attachment submission does not send the Planner or Reviewer prompt until all attachments visibly reach the completed state in ChatGPT Web.
- A fixture marker in the ZIP is returned by the fake Bridge test worker.
- `report.md` and `diff.patch` can be uploaded in the same request.
- Failed, timed-out, refreshed, and restarted attachment requests have explicit failure or recovery outcomes.
- Retrying the same request does not create duplicate submission.
- ChatGPT output is consumed as validated data and never executed directly.
- The Executor route is `openai-codex` with model `gpt-5.6-luna`; the session permission mapping is `danger-full-access` with no approval prompt.
- One `NEEDS_FIX` is allowed; a second automatic fix is rejected and stops the run.
- Deterministic tests do not require a production ChatGPT account or paid Codex call.

## Risks and rollback

The ChatGPT Web DOM and upload states are unstable. CDP selectors and completion detection remain isolated in the Bridge worker and fail closed. A real smoke is opt-in, bounded, and stops after one Planner or Reviewer request. The Controller can be rolled back by removing its plugin/CLI entry and deleting only its own run artifact root; it never repairs the product repository by reset or clean.
