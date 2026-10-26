# dsh-dev-loop

Bounded AI dual-layer development loop for a separate project repository.

## Runtime boundary

- M2 Planner and Reviewer handoffs support manual text transfer and local Host inboxes for Planner JSON and Reviewer decisions; the historical `/dev-loop` flow still uses DSH-Brain-Bridge ChatGPT Web transport with validated local attachments.
- Executor uses the installed `dsh-codex-subscription` DSH provider route: `openai-codex` / `gpt-6-luna`.
- The Executor is a DSH Agent, so DSH remains the tool, permission, session, and execution authority.
- The M2 Controller allows Git operations required by the approved task under DSH native permissions, while keeping project and file-scope checks and giving the Reviewer commit-history, file-diff, and final-state evidence.
- The development Agent uses the trusted Host `permissionPreset`; the separate test Agent always requests DSH `workspace-write` and still requires its own native one-time tool approval. This does not grant or imply a wider project permission.
- M2 scope paths are repository-relative. Current Git/worktree evidence observes repository-visible paths and selected commit/status/diff data; it does not prove the absence of arbitrary effects outside the repository or all changes to `.git` internals (for example, reflogs, hooks, or local configuration). Such effects are not authorized by repository scope and must not be treated as compliant merely because the captured file list is in scope. A formal cross-workspace authorization and Git-metadata evidence contract remains undecided; M2 does not claim to enforce or attest either.

## Development

```bash
npm test
npm run package:fixture
```

`npm test` uses only fake Bridge/Executor/CDP seams. It does not consume ChatGPT or Codex quota.

## 历史兼容入口：`/dev-loop`

`/dev-loop` 保留原有内置方案流，适用于已配置的 Web profile。新的人工转交流程推荐使用 `/dev-loop-m2`；它由用户把 ChatGPT 生成的方案转交给 DSH，不依赖 Bridge 或项目 ZIP。

原入口仍可接收自然语言需求：

```text
/dev-loop 修复登录页提交后没有反应的问题
```

不需要写 JSON、不需要填写项目路径。项目目录、产物目录和执行权限由 profile 配置提供；流程会先完成
环境检查和方案分析，等待你确认后才会修改代码。确认方式为：

```text
/dev-loop approve run-xxxxxxxx
```

## 推荐入口：M2 普通文本人工交接

`/dev-loop-m2` 是离线人工交接入口，不调用 Bridge、不生成或上传项目 ZIP。项目根目录、工件目录、测试命令和 DSH 权限来自可信 Host 配置，方案内容不能更改这些设置。

本机 ChatGPT Web 可用 Remote Desktop Commander 将 Planner JSON 写入 Host 工件目录下固定的 `.m2-inbox`。首次在 DSH Session 中执行“领取待审方案”会创建该目录；若没有完成文件，命令错误详情会给出绝对路径。将完整方案写入 `plan.partial.json`，再在同一目录移动为 `plan.json`，随后在同一 DSH Session 再执行“领取待审方案”。目录只接受这个固定文件名；领取会先原子改名为 `claimed-<UUID>.json`，因此同一文件不能重复领取，未完成的 partial 文件也不会被读取。

暂存文件是 Controller 外部方案字段的 JSON 表示：

```json
{
  "schema": 1,
  "summary": "修复提交失败时没有反馈的问题",
  "scope": {
    "includedPaths": ["src/submit.mjs", "tests/submit.test.mjs"],
    "excludedPaths": ["src/generated.mjs"],
    "nonGoals": ["不调整页面样式"]
  },
  "acceptanceCriteria": ["提交失败时显示错误信息"],
  "executionRequirements": ["先检查现有实现，再运行配置的测试命令"],
  "contextSources": ["GitHub dev 分支与当前工作区"],
  "observedContext": {"branch": "dev", "commit": "<完整 Git commit SHA>"},
  "executorTask": "为提交失败增加用户可见的错误反馈。"
}
```

不得加入 `projectRoot`、`artifactRoot`、`sessionId`、权限或批准字段；Controller 会拒绝未知字段和越界仓库路径，并重新核对方案观察到的分支与 commit。Session ID 来自真实 DSH 命令调用上下文。成功领取后仍进入 `WAITING_FOR_APPROVAL`，不会运行 Agent；批准、执行和 Reviewer 复核仍沿用下方独立步骤。这个本机文件通道不对文件内容做 ChatGPT 身份认证；信任来源是本机文件访问权限，方案内容仍按不可信输入校验。固定标题文本继续作为兼容交接方式：

先把 Planner 生成的方案整体粘贴到 `/dev-loop-m2`。以下十个标题必须各出现一次，路径必须是仓库相对路径；`修改范围` 至少列出一个路径。无排除路径或非目标时填写 `- 无`。分支和 commit 必须来自 Planner 观察到的 Git 状态：

```text
/dev-loop-m2
目标：修复提交失败时没有反馈的问题
修改范围：
- src/submit.mjs
- tests/submit.test.mjs
排除路径：
- src/generated.mjs
非目标：
- 不调整页面样式
验收条件：
- 提交失败时显示错误信息
执行要求：
- 先检查现有实现，再运行配置的测试命令
上下文来源：
- GitHub dev 分支与当前工作区
Planner 观察到的分支：
dev
Planner 观察到的 commit：
<完整 Git commit SHA>
DSH Agent 执行任务：
为提交失败增加用户可见的错误反馈。
```

提交只保存方案并进入 `WAITING_FOR_APPROVAL`，不会调用 DSH Agent 或修改项目。接着在同一个 DSH 会话单独执行批准命令：

```text
/dev-loop-m2 批准当前方案
```

批准前 Controller 会重新检查方案哈希、可信项目根目录、分支和工作区状态。随后由 DSH Agent 在原生权限与审批下执行；批准任务需要的 Git 操作不再受 M2 Controller 的额外类别禁令或审批要求限制，项目路径和文件范围校验仍然生效。DSH 审批拒绝、取消、超时、审批证据缺失、测试失败或范围越界都会停止，不会切换到宿主备用执行器。执行和取证完成后进入 `REVIEWING`，命令会显示唯一审核回执、证据目录和 `evidence-manifest.json` 路径。Reviewer 可通过 `git-history.patch`、`git-diff.patch`、快照和最终 HEAD/工作区状态核验提交与代码；把回执和这些证据交给 ChatGPT Reviewer 人工检查。

Reviewer 现在可以通过同一个本机 `.m2-inbox` 回传决定。ChatGPT Reviewer 从当前 Run 的审核证据中读取回执并完成独立核查后，通过 Remote Desktop Commander 将以下字段写入 `review.partial.json`，再在同一目录原子移动为 `review.json`；用户随后在对应 DSH Session 执行“领取复审结果”。示例中的 `ACCEPTED` 只有在 Reviewer 独立核查后明确给出时才可填写，不是默认值：

```json
{
  "schema": 1,
  "receipt": "<当前 Run 的审核回执>",
  "decision": "ACCEPTED",
  "summary": "变更范围、测试和证据均已核对。",
  "findings": []
}
```

只允许上述五个字段和现有五种 decision。不得加入 Run ID、Session ID、Host 路径、权限或审批字段。Controller 从真实命令调用 Session 查找唯一的 `REVIEWING` Run，再把结果交给原 `submitExternalReview()` 校验。进入 `REVIEWING` 时，DSH 命令会显示两个绝对文件路径和领取指令。部分文件不会被读取；领取会原子改名为 `claimed-review-<UUID>.json`，输入副本保留供审计。错误 Session 或没有唯一 `REVIEWING` Run 时不会领取文件；无效回执、损坏输入或过期证据继续按现有 Controller 规则拒绝或停止。

本机文件通道不认证 ChatGPT 身份；任何有权写入 Host 工件目录的本机主体都能提交输入，Controller 仍会核对当前 Run、回执、证据哈希、测试结果和项目状态。`ACCEPTED` 必须来自 Reviewer 已完成的独立核查，不能作为默认决定。

固定标题文本方式继续作为兼容交接入口。用户也可以把 Reviewer 结果粘贴到 `/dev-loop-m2`；标题和 decision 值必须精确填写，无发现时写 `- 无`：

```text
/dev-loop-m2 提交复审结果
审核回执：<原样粘贴 Host 显示的回执>
Reviewer decision：ACCEPTED
复审摘要：变更范围与证据均已核对。
发现的问题：
- 无
```

Reviewer decision 只接受 `ACCEPTED`、`NEEDS_FIX`、`NEEDS_REPLAN`、`DEFER` 或 `ESCALATE`。只有回执仍对应当前 run、方案、证据和完整项目状态，且 DSH 测试通过时，`ACCEPTED` 才会进入 `COMPLETE`；其他结论进入 `STOPPED`，不会自动重新执行。

同一 DSH session 内可用以下独立命令操作；普通聊天里的“同意”“好的”不会批准方案。Controller 会把可信 DSH session ID 与方案持久关联，恢复后仍可查询；零个、多个、损坏或状态不匹配的候选都会拒绝，不会猜测“最近一次运行”。

```text
/dev-loop-m2 查看当前状态
/dev-loop-m2 取消当前任务
```

离线实现和回归测试本身不能证明真实端到端验收；此前已经通过一次实际的 ChatGPT Web Planner → DSH Agent/原生工具测试 → ChatGPT Web Reviewer 闭环（`run-bbbd7494-2527-4566-968e-dcdc9e7cc882`，`COMPLETE / ACCEPTED`）。本机暂存减少 Planner 方案和 Reviewer 决定的人工转交步骤，但不会自动连接 ChatGPT Web 与 DSH，也不替代独立审批或复核。

## CLI（高级/调试用法）

CLI 保留完整参数，适合本地打包或没有 Web profile 的调试场景。打包是本地只读操作：

```bash
node bin/dsh-dev-loop.mjs package --project /path/to/project --output /path/to/artifacts
```

完整运行需要 DSH host executor module；CLI 不直接实现 subscription API：

```bash
node bin/dsh-dev-loop.mjs run \
  --project /path/to/project \
  --output /path/to/artifacts \
  --problem-file problem.json \
  --executor-module ./dsh-host-executor.mjs \
  --bridge-url http://127.0.0.1:7688 \
  --bridge-token "$DSH_BRIDGE_TOKEN" \
  --approve
```

The host executor module must export `createExecutor()` or `execute()` for Agent turns and also
provide `executeTest()` backed by the DSH Agent tool path. The CLI rejects modules without that
DSH test executor; it has no local test-command fallback. The DSH plugin host adapter is the
supported way to supply both methods.

## DSH host adapter

`src/plugin.mjs` can be loaded as a DSH plugin in the **Web profile**. It provides
`dshDevLoopExecutor` backed by `ctx.agents` and the installed `openai-codex` route. The selected
permission preset defaults to `workspace-write`, which pairs workspace-scoped writes with DSH's
native `approval: ask` policy. A higher preset can be selected only through trusted host/profile
configuration; task text and model output do not select or raise it. This default supersedes the
historical `danger-full-access` / no-approval requirement in the original PRD. `/dev-loop approve`
approves the workflow plan only; it does not approve DSH tool requests.

`cordis.patch.yml` is an explicit Web-profile overlay, not an automatic bundle patch. Apply it
only to the profile that provides `connection` and `web`; attaching the Controller to a minimal
headless profile will fail closed because `dsh-codex-subscription` is Web-bound.

The low-level `streamCodex()` helper pins the same provider/model when a host needs a direct
`ctx.llm.stream()` call. Normal repository execution should use the Agent adapter so DSH tools
and session evidence remain authoritative.

### Direct Web-profile usage

The Web-profile overlay registers `/dev-loop`. Install the local package into the existing Web
profile, then apply the explicit overlay when that profile is launched:

```bash
export DSH_DEV_LOOP_PROJECT_ROOT=/absolute/path/to/project
export DSH_DEV_LOOP_ARTIFACT_ROOT=/absolute/path/to/dsh-dev-loop/artifacts
export DSH_BRIDGE_URL=http://127.0.0.1:7688
export DSH_BRIDGE_TOKEN="$DSH_MCP_STATIC_TOKEN"
# Or use a local JSON/token file when the already-running host cannot inherit env:
export DSH_BRIDGE_TOKEN_FILE=/absolute/path/to/bridge/config.json
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-dev-loop
dsh plugin --profile web add /absolute/path/to/dsh-dev-loop/client-plugin
dsh --profile web --patch /absolute/path/to/dsh-dev-loop/cordis.patch.yml
```

`dsh-dev-loop-ui` requires DSH `0.2.1-rc.2` or newer: `@deepseek-ai/dsh-client-ui-conversation` provides `uiConversation.events`, `@deepseek-ai/dsh-client-ui-renderer` provides `slots`, and `@deepseek-ai/dsh-client-ui-chat` owns the `conversation.chat.node` card slot.

When the profile already configures the project and artifact roots, the DSH Web composer accepts a
plain-language task and presents its preflight, progress, evidence, and diagnostic state in Chinese:

```text
/dev-loop 修复登录页提交后没有反应的问题
```

The previous JSON contract remains available as an advanced mode:

```text
/dev-loop {"problemPackage":{"id":"problem-1","summary":"Describe the bounded task"},"executorTask":"Implement only the requested change"}
```

默认 `autoApprove: false`。旧 JSON 输入仍兼容；在 JSON 中明确写入 `"approve":true` 可以保留一次性自动执行，
但日常建议使用生成方案后再执行 `/dev-loop approve <runId>`。

The command never accepts local paths inside the prompt; project and artifact roots come from
profile configuration or validated command fields. Do not apply this overlay to headless profiles.

### 激活与版本确认

Host 插件会显示 `运行版本` 指纹；如果卡片显示“未知（旧服务器或旧事件）”，说明当前页面或
Host 仍使用旧版本。客户端资源可以热更新，但 Host 代码和 profile 配置变更后应重启现有的
`dsh web` 进程，再刷新 `http://127.0.0.1:3080`。不要启动替代服务器。

## Artifacts and security

Run artifacts are written to a Controller-owned root. ZIP packaging is deterministic and
reuses the Wuxia-Life exclusion policy without writing into Wuxia-Life. Each staged artifact
gets a byte count and SHA-256 hash; Bridge submission additionally enforces canonical-path,
symlink, root, size, and hash validation.

See [`docs/PRD/ai-dual-dev-loop.md`](docs/PRD/ai-dual-dev-loop.md) for the approved first-phase
contract and [`docs/PRD/ai-dual-dev-loop.prd.json`](docs/PRD/ai-dual-dev-loop.prd.json) for the
machine-readable scope.
