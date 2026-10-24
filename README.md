# dsh-dev-loop

Bounded AI dual-layer development loop for a separate project repository.

## Runtime boundary

- Planner and Reviewer use DSH-Brain-Bridge ChatGPT Web transport with validated local attachments.
- Executor uses the installed `dsh-codex-subscription` DSH provider route: `openai-codex` / `gpt-6-luna`.
- The Executor is a DSH Agent, so DSH remains the tool, permission, session, and execution authority.
- The Controller never resets, cleans, commits, or pushes the product repository.

## Development

```bash
npm test
npm run package:fixture
```

`npm test` uses only fake Bridge/Executor/CDP seams. It does not consume ChatGPT or Codex quota.

## 历史兼容入口：`/dev-loop`

`/dev-loop` 保留原有内置方案流，适用于已配置的 Web profile。新的人工转交流程推荐使用 `/dev-loop-m2`；它由用户把 ChatGPT 生成的固定标题文本转交给 DSH，不依赖 Bridge 或项目 ZIP。

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

`/dev-loop-m2` 是离线人工交接入口，不调用 Bridge、不生成或上传项目 ZIP。Planner 方案和 Reviewer 结论由用户从 ChatGPT Web 转交；固定标题只是普通文本协议，不认证 ChatGPT 身份。项目根目录、工件目录、测试命令和 DSH 权限来自可信 Host 配置，文本内容不能更改这些设置。

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

批准前 Controller 会重新检查方案哈希、可信项目根目录、分支和工作区状态。随后由 DSH Agent 在原生审批下执行；DSH 审批拒绝、取消、超时、审批证据缺失、测试失败或范围越界都会停止，不会切换到宿主备用执行器。执行和取证完成后进入 `REVIEWING`，命令会显示唯一审核回执、证据目录和 `evidence-manifest.json` 路径。把回执、当前变更和 Reviewer 所需证据交给 ChatGPT Reviewer 人工检查。

Reviewer 应返回审核回执、decision、摘要和发现的问题，再把其结果粘贴到 `/dev-loop-m2`。标题和 decision 值必须精确填写；无发现时写 `- 无`：

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

本入口完成离线实现和安全回归，不代表真实 ChatGPT Web ↔ DSH Agent 交接已验收。

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
