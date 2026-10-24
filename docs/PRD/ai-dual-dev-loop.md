# AI Dual-Layer Development Loop — Current Product Scope

> 2026-10-24 product-direction revision. This document defines the **intended new loop**, not a claim that the existing `dev` runtime already implements it. The previous ZIP/attachment-first Phase 1 design is historical.

## Background and problem

The old first-phase workflow packaged the project into a ZIP and uploaded it through DSH-Brain-Bridge for Planner and Reviewer. That transfer model is **not part of the new development loop**. In ChatGPT Web, the user has connected GitHub (remote repository access) and Remote Desktop Commander (authorized local project access); Codex/DSH execution reports provide another source of execution context. The objective is to use these sources selectively, without bulk-uploading the project.

The production boundary remains: DeepSeek Harness (DSH) is the development execution and permission authority. ChatGPT Web plans and independently reviews, and the Controller validates tasks, approvals, state and audit evidence. A connected ChatGPT app being usable interactively **does not prove** DSH-Brain-Bridge can trigger that app or obtain its data automatically.

## Goals

Deliver one bounded, human-authorized development loop:

1. ChatGPT Web Planner obtains only task-relevant context from the remote repository through GitHub, from unpushed local files through Remote Desktop Commander when needed, and from available execution reports. It identifies the exact source/ref and uncertainty.
2. Planner produces a scoped, structured task proposal with intended changes, acceptance checks, allowed paths and stop conditions; Controller validates the proposal.
3. A human authorizes the workflow plan before execution. This is separate from each applicable DSH native tool approval.
4. **DSH Agent is the sole routine development executor**, using its host-configured tools, project root, execution route and permission policy. The ChatGPT Web Planner/Reviewer do not modify project files as part of their routine roles.
5. The run captures DSH execution/tool outcomes, actual project changes, Git state/diff, test results and an execution report, with source and run correlation.
6. ChatGPT Web Reviewer reads the report and independently checks relevant source files, Git state and available test evidence using the connected apps; it returns a structured review decision.
7. Controller validates and records that decision, the approval chain and evidence, then completes, waits or stops according to the approved state contract.

The initial M2 acceptance target is **one real, bounded, human-in-the-loop run**. Automated ChatGPT-app invocation, cross-system unattended scheduling and fully automatic handoff are not assumed to be available.

## Roles and boundaries

| Role | May do in the new loop | Must not do by default |
| --- | --- | --- |
| ChatGPT Web Planner | Read relevant remote/local context; explain scope; propose structured plan | Mutate local or remote project files; silently approve execution |
| ChatGPT Web Reviewer | Read DSH/Codex report; independently check relevant code, diff and test evidence; provide decision | Fix code as a side effect of review; accept an unverified self-report as proof |
| Controller | Validate structured proposals/decisions, trusted target, authorization and evidence; manage state | Execute arbitrary shell commands, silently raise DSH permissions, commit/push/reset/clean a product project |
| DSH Agent | Execute approved work and tests through DSH native tools and approvals | Change targets outside the trusted workspace or bypass tool approval |
| GitHub and Remote Desktop Commander | Supply scoped context/evidence to ChatGPT Web through user-connected app access | Become an implicit second developer/executor or automatic publish path |

The apps may technically support writes. **Technical ability is not workflow authorization**. A separate explicit request for a direct edit/publish is outside the routine Planner/Reviewer path and must be assessed independently.

### Source selection and currency

- For already-pushed code, read the requested GitHub repository, branch and **observed commit**; never silently switch to the default branch. The currently designated project code source is `molibaby1/dsh-dev-loop`, `dev`.
- For relevant unpushed changes, access the explicitly authorized local workspace through Remote Desktop Commander using the minimum necessary read-only operations; do not reread a pushed copy locally without need.
- Execution reports are evidence inputs, not the code truth. Independently verify claims of completion, changed files and test results using observable sources.
- Distinguish DSH Agent session/tool evidence from a separate Codex run report. Do not assume they describe the same run unless identifiers and outputs correlate.
- Record unavailable sources and consistency limits. Never infer that a remote commit contains local unpushed work.

## Execution authority and approval

The DSH Agent's current default is `openai-codex` / `gpt-6-luna`, with `workspace-write` and DSH native `approval: ask`, subject only to trusted host/profile overrides. Historical `gpt-5.6-luna` and `danger-full-access` defaults remain superseded.

Workflow plan approval (for example, `/dev-loop approve`) and native DSH tool approval are **two separate grants**. Tool rejection or an unavailable approval channel must fail closed. The Controller and ChatGPT model output cannot choose a higher permission preset, move the trusted project root, or execute a host-shell fallback. Product-repository Git operations are read-only for evidence; no automatic commit, merge, push, reset or clean.

## Interaction and evidence contract

The contract is about observable data and boundaries, **not a project-archive transport**:

- **Planner input:** human problem statement, task-relevant file/code references, current branch/commit and relevant local working-tree state, plus material constraints. Context may be read interactively via connected apps. No `project.zip` requirement.
- **Planner output:** structured proposal with the intended executor task, allowed files/scope, validation steps and stop conditions, checked before execution. A plan or user message may not override trusted Host configuration.
- **Execution input:** validated, explicitly authorized task passed to the DSH Agent by a verified handoff; native tool approvals still apply.
- **Evidence output:** correlated DSH Agent/tool records, execution report, Git baseline and delta, test command and observed result, relevant project state, and failures/uncertainty. Tests and repository inspection remain governed by the established permission and read-only boundaries.
- **Reviewer input:** evidence plus direct, scoped access to applicable source-of-truth code through ChatGPT Web connected apps. No mandatory ZIP, attachment-upload or file-return protocol.
- **Reviewer output:** one validated structured decision: `ACCEPTED`, `NEEDS_FIX`, `NEEDS_REPLAN`, `DEFER` or `ESCALATE`, with summary and findings. It is not executable code.
- **Audit:** run ID, context refs, plan and approval, execution identity/results, actual changed files, test evidence, reviewer decision and terminal outcome must be reconstructable. Existing JSON/Markdown artifacts may be retained internally; internal persistence does not imply ChatGPT upload.

The existing `run-manifest.json`, `problem-package.json`, `plan.json`, `approval.json`, `executor-report.md`, `git-diff.patch`, `test-result.json`, `review.json` and `audit-trace.json` remain useful evidence artifacts. `project.zip` and Bridge attachment descriptors are **legacy transport artifacts, not mandatory new-loop inputs, outputs or acceptance criteria**.

Existing Controller state names and Reviewer decisions remain a migration baseline, **not automatic proof of new-loop semantics**. In particular, renewed authorization after `NEEDS_REPLAN`, authorization scope for `NEEDS_FIX`, and any universal rule about test failure preventing `COMPLETE` require explicit contract decisions; the current code must not silently decide these questions.

## User stories and acceptance criteria

### US-1: Task-relevant context without project upload

As the user, I want Planner to inspect the relevant GitHub files and, if necessary, unpushed local files, rather than require me to package the project.

Acceptance: it identifies the actual repository/ref or local source used; retrieves enough context for the bounded task; does not require, generate for transfer, or upload `project.zip`; does not make unauthorized writes.

### US-2: Approved DSH development execution

As the user, I want the approved task performed by DSH Agent under its native permissions.

Acceptance: the plan/scope and a separate workflow authorization are recorded; the DSH Agent runs inside the trusted project root using configured provider/model and `workspace-write` / `approval: ask` defaults; missing/rejected native tool approval cannot be replaced by shell execution or a ChatGPT-app write.

### US-3: Independent evidence-driven review

As the user, I want ChatGPT Web Reviewer to check what really changed, not only repeat the developer's report.

Acceptance: Reviewer receives or accesses a correlated execution report, observed Git delta and test evidence; checks pertinent source through its connected apps; returns a validated structured decision; no ZIP/attachment round-trip is needed.

### US-4: Auditable human-in-the-loop completion

As the user, I want one real, bounded development run whose result can be independently verified.

Acceptance: all phases and actual file/test outcomes are correlated by run; the Controller retains the decision/authorization trace; no unauthorized changes or automatic push occur; a successful demo ends with verified task behavior, the expected files/diff, passing scoped tests and `ACCEPTED` / `COMPLETE`. Mock-only tests are insufficient for M2 acceptance.

## Non-goals

- Project ZIP generation/upload/return as a requirement of the active loop; resurrection of legacy CDP attachment upload criteria.
- ChatGPT Web Planner/Reviewer as routine code-writing agents, or an independent ChatGPT shell execution plane.
- Automatic Git commits/pushes or destructive cleanup of product repositories.
- DSH core changes, multi-project scheduling, unlimited retries, unattended cross-app orchestration, or a new management platform.
- Treating external reports, synthetic tests or documentation updates as proof of real end-to-end acceptance.

## Migration status and unresolved decisions

The `dev` implementation still calls `createProjectZip()` in `src/controller.mjs` and requires attachments in `src/bridge-client.mjs`. Its Bridge worker remains an attachment-oriented transport. Those are **legacy implementation dependencies requiring adaptation**, not new-loop product requirements. Existing M1/B2f tests substantiate the DSH permission boundary but do not establish M2 acceptance.

Before a real M2 run, verify/design the minimum **ChatGPT Web ↔ Controller/DSH task handoff and return-of-evidence** that works with connected apps. Merely having GitHub and Remote Desktop Commander in ChatGPT Web does not make their tools available to a DSH-side Bridge request. A bounded human-mediated handoff is acceptable initially, if scope, authorization, provenance and run identity are preserved. Do not invent a new automated bridge protocol without observable evidence.

Open decisions to resolve before enabling the affected behavior:
1. Whether `NEEDS_REPLAN` (or an out-of-scope `NEEDS_FIX`) always requires renewed workflow approval.
2. The minimal validated handoff/return protocol and what records it preserves across a manual Web↔DSH transfer.
3. The use of `branchName: "main"` in the existing machine-readable PRD; this legacy field must not silently override the designated `dev` code branch.
4. General test-failure-to-`COMPLETE` semantics and exact evidence snapshot binding (defer to M3 unless demonstrably blocking a bounded M2 test).

## Risks and rollback

Uncertain app connectivity, stale local-vs-remote state, incomplete Agent session evidence and unauthorized extra writes must fail closed or stop for human action. When cancelling or failing, preserve existing product changes for inspection; never reset or clean them automatically. Revert only the Controller's own optional adapter/configuration after confirming ownership and scope.

A **real** Planner/Reviewer/DSH test remains separately opt-in and bounded. This PRD revision does not authorize ChatGPT Web messages, model consumption, DSH Agent execution, local writes or product-repository publishing.
