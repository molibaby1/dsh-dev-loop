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

## 最简单的用法

完成一次 Web profile 配置后，日常使用只需要输入一条需求：

```text
/dev-loop 修复登录页提交后没有反应的问题
```

不需要写 JSON、不需要填写项目路径。项目目录、产物目录和执行权限由 profile 配置提供；流程会先完成
环境检查和方案分析，等待你确认后才会修改代码。确认方式为：

```text
/dev-loop approve run-xxxxxxxx
```

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

The host executor module must export `createExecutor()` or `execute()`. The DSH plugin host
adapter is the supported way to supply it.

## DSH host adapter

`src/plugin.mjs` can be loaded as a DSH plugin in the **Web profile**. It provides
`dshDevLoopExecutor` backed by `ctx.agents` and the installed `openai-codex` route. The selected
permission preset is `danger-full-access`, which sets the session approval policy to `never` for unattended execution.

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
