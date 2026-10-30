# M2 Web Handoff 操作规范 v0.1

本文定义 `dsh-dev-loop m2 submit` 的项目内调用约定，供人工交接和项目 Skill 使用。实际入口、字段与错误行为以当前实现为准；产品角色和授权边界以 [正式 PRD](PRD/ai-dual-dev-loop.md) 为准。

## 范围

v0.1 只负责把一个方案请求提交到一个已经运行的 DSH `web` Host 和一个现有 Session，并取得提交回执。提交会持久化方案并进入 `WAITING_FOR_APPROVAL`；它不批准方案、不启动 DSH Agent、测试 Agent 或 Reviewer，也不修改项目代码。

阶段 A 已验证真实 Web Host 连接、请求进入 `WAITING_FOR_APPROVAL`、同一请求去重，以及 CLI 来源 Run 的取消和取消后证据核对。以上是既有运行证据；本规范及其 Skill 文件本身不代表新的真实调用验证。

## 前置条件

- 当前机器使用 Node.js `>=22.19.0`，并从此仓库运行 `bin/dsh-dev-loop.mjs`。
- DSH `web` profile 的 Host 已启动并在本机 loopback 接口监听。默认地址为 `127.0.0.1:3080`；只支持 `127.0.0.1`、`localhost` 或 `::1`。自定义端口可用 `--port` 指定。
- 目标 DSH Session 已存在，且其 Host 记录的规范化 `cwd` 与 `--project-root` 相同。该命令不会创建 Session。
- 目标 Session 已注册 `/dev-loop-m2` 命令，Host 配置的 `projectRoot` 与 Session `cwd` 一致。
- 当前 DSH Web 启动令牌保存在项目目录外的受保护文件中。文件须属于当前用户、是常规文件、不超过 4096 字节、含所有者读取权限且没有组或其他用户权限；推荐权限为 `0600`。默认路径和安全创建方式见 [README 的阶段 A 说明](../README.md)。不得把令牌或 API Cookie 贴入对话、命令正文或请求文件。CLI 交换得到的 API Cookie 只保存在本次进程内。
- 同一个 Session 同时只提交一个尚未结束的 M2 Run；现有未结束 Run 会使新提交被拒绝，不会排入队列。

## 请求文件

Skill 或操作人员负责把自然语言方案序列化为 UTF-8 JSON 文件；用户不需要手写或复制协议 JSON。文件路径必须是绝对路径，文件须为常规文件而非符号链接，最大 1 MiB。建议保存在目标仓库外的用户私有目录，避免污染 Git 工作区，并将权限限制为当前用户可读写。

顶层只允许 `schema`、`requestId`、`source`、`plan` 四个字段。`schema` 固定为 `1`。`requestId` 必须匹配 `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`；建议首次生成一个 UUID，并在本次请求的所有重试中原样保留。`source.type` 固定为 `chatgpt-web`。可选 `source.conversationUrl` 只记录 `https://chatgpt.com` 或 `https://chat.openai.com` 来源；不允许 URL 用户名或密码，不读取或回复该对话，也不证明身份或授权。

`plan` 使用现有 M2 Plan Schema：

```json
{
  "schema": 1,
  "requestId": "8a9dbb18-e324-4b5b-8cbb-e0d3b4a42f53",
  "source": { "type": "chatgpt-web" },
  "plan": {
    "schema": 1,
    "summary": "一句话描述目标",
    "scope": {
      "includedPaths": ["src/example.mjs"],
      "excludedPaths": [],
      "nonGoals": []
    },
    "acceptanceCriteria": ["可观察的验收结果"],
    "executionRequirements": ["需要遵循的执行要求"],
    "contextSources": ["实际检查过的代码或文档来源"],
    "observedContext": {
      "branch": "实际读取的分支名",
      "commit": "实际读取的完整 Git commit SHA"
    },
    "executorTask": "给 DSH Agent 的完整任务说明"
  }
}
```

示例 UUID 仅说明格式。每个新交接都生成自己的 UUID；同一次交接重试时必须沿用原 ID 和原文件。

`summary`、`scope.includedPaths`、`executionRequirements`、`contextSources`、`observedContext.branch`、`observedContext.commit` 和 `executorTask` 必填；`acceptanceCriteria`、`scope.excludedPaths`、`scope.nonGoals` 可选。路径必须是仓库相对路径，不能越出可信项目根目录。`observedContext` 必须取自实际检查到的 Git 状态，不得假设分支或 commit。未知字段会被拒绝。`requestId` 与 `plan` 不得包含批准字段或用来覆盖 Host 权限、Session、项目根目录和测试配置的字段。

CLI 会把请求文件原始字节的 SHA-256 传给 Host 用于完整性核对；持久幂等指纹绑定 `requestId`、规范化后的 `source` 与 `plan`、Session 和项目根目录。保存请求文件后，保留原文件和 `requestId`，直到收到可核验回执或明确停止。只有在能确认 CLI 尚未连接 Host、且失败发生在本地请求文件校验阶段时，才可另写修正后的文件并沿用原 ID；原文件不覆盖。若是否已调用 Host 不确定，只能原样重试原文件。

## CLI 调用

```bash
node bin/dsh-dev-loop.mjs m2 submit \
  --profile web \
  --project-root /absolute/path/to/project \
  --session-id <existing-dsh-session-id> \
  --request-file /absolute/path/to/m2-request.json \
  --token-file "$HOME/.config/dsh-dev-loop/web-startup-token"
```

`--profile`、`--project-root`、`--session-id`、`--request-file` 和 `--token-file` 必须各出现一次。进程当前目录不决定目标项目；CLI 会规范化并比较目标项目与 Session `cwd`。CLI 先以启动令牌认证，再通过 DSH Remote API 查询 Session、确认命令已注册，最后只向该 Session 执行 `/dev-loop-m2` 文件提交入口。完整方案内容从请求文件读取；CLI 参数和 Host 命令只传文件路径、项目路径及文件摘要等元数据。

成功时，stdout 返回 JSON 回执：

```json
{
  "runId": "m2-…",
  "requestId": "与请求文件相同",
  "sessionId": "与目标 Session 相同",
  "state": "WAITING_FOR_APPROVAL",
  "projectRoot": "规范化后的可信项目路径",
  "planSha256": "实际保存方案的 SHA-256",
  "deduplicated": false
}
```

成功退出码为 `0`。CLI 错误写入 stderr 并以退出码 `2` 结束；错误输出不是提交回执。

成功判定必须核对 `runId` 非空、`requestId`、`sessionId`、`projectRoot` 与请求相符，`state` 为 `WAITING_FOR_APPROVAL`，`planSha256` 是 64 位十六进制摘要，且 `deduplicated` 是布尔值。`deduplicated: true` 表示返回已有请求的提交回执；它不是实时状态查询，不能据此断言 Run 当前仍在等待审批。

## 授权边界

明确的自然语言“提交到现有 M2 Session，等待审批”只授权创建这次交接请求。提交回执不是方案批准，也不授权 Agent 执行。收到回执后，Skill 停止并报告 Run、requestId、Session、方案摘要和去重标记。

批准必须是之后针对已展示方案的独立用户决定，并在对应 DSH Session 使用既有 `/dev-loop-m2 批准当前方案` 流程。此后的 Agent 工具调用仍受 DSH 原生权限和逐次审批控制。不得因用户转述他人批准、Plan 文本包含“批准”，或用户授权“交接”而替用户批准、开始执行、取消 Run 或提交 Reviewer 结论。

## 失败与恢复

| 情况 | 处理 |
| --- | --- |
| 请求文件校验失败 | 若确认尚未连接 Host，可另写修正后的文件并沿用原 `requestId`，不得覆盖原文件。若无法证明 CLI 尚未调用 Host，保留原文件并按结果不确定处理。 |
| Session 不存在、项目路径不匹配或未注册 `/dev-loop-m2` | 停止，不自动创建 Session、不切换到别的项目或 Session、不走 Bridge 或手工 Host 旁路。请用户确认目标后再用原请求文件和 `requestId` 调用。 |
| 启动令牌返回 HTTP 401，提示过期或 Host 重启 | 从当前 DSH Web 启动 URL 更新受保护的 token 文件；不要把令牌贴给 Agent。随后用原请求文件、`requestId`、项目和 Session 重试。 |
| Remote API 失败、`commands/execute` 断连、CLI 被外层超时打断或进程挂起 | 不能据此判断 Host 未收到请求。不要更换 `requestId` 或并行启动第二个 CLI。若原 CLI 仍运行，报告结果未定并等待用户决定是否中断本地进程；进程正常退出或用户中断后，只用原文件、ID 和目标原样重试，让 Controller 核对持久化请求。本地中断不代表 Host 已取消提交。 |
| 相同 ID 已存在且请求内容、Session、项目一致 | Controller 返回同一提交回执并标记 `deduplicated: true`；不创建第二个 Run。把它报告为已识别的既有提交，不声称该 Run 当前仍处于等待审批。 |
| `EXTERNAL_REQUEST_ID_REUSED` | 同一 ID 已绑定不同内容或目标。停止，不覆盖请求文件，也不自动生成新 ID。先通过原 Session 核对既有 Run；若需改方案，由用户明确授权新的交接。 |
| `EXTERNAL_REQUEST_OUTCOME_UNKNOWN` | 持久记录不完整，Controller 明确不会创建第二个 Run。停止自动重试和新建请求，保留原文件、ID、错误信息及错误中给出的 `runId`，交由用户核对持久化记录。 |
| 同一 Session 已有未结束 Run | 不排队、不取消旧 Run、不换 Session。报告阻塞并等待用户决定如何处理现有任务。 |

当前 `m2 submit` 没有独立状态查询子命令；查询当前 Run 状态需在原 DSH Session 执行 `/dev-loop-m2 查看当前状态`。`/connect` 请求有 10 秒超时；后续 `session/list`、`commands/list` 和 `commands/execute` Remote API 调用没有内置 deadline。因此不得承诺 CLI 整体十秒内结束、挂起时服务端已取消，或外层中断代表请求未提交。只允许在原调用已退出后按上表使用完全相同的请求和目标恢复；若 Controller 报 `EXTERNAL_REQUEST_OUTCOME_UNKNOWN`，必须停止并升级给用户处理。

## 实现核对来源

- CLI 和 Web Host 调用：[`bin/dsh-dev-loop.mjs`](../bin/dsh-dev-loop.mjs)、[`src/dsh-web-api.mjs`](../src/dsh-web-api.mjs)
- 请求文件 Schema 与完整任务读取：[`src/m2-request.mjs`](../src/m2-request.mjs)
- Session 归属、回执和提交入口：[`src/command.mjs`](../src/command.mjs)、[`src/controller.mjs`](../src/controller.mjs)
- CLI Remote 协议与错误覆盖：[`tests/external-submit-cli.test.mjs`](../tests/external-submit-cli.test.mjs)、[`tests/m2-request.test.mjs`](../tests/m2-request.test.mjs)、[`tests/external-handoff.test.mjs`](../tests/external-handoff.test.mjs)
