---
name: m2-web-handoff
description: Use when 用户明确授权把一个已讨论的方案提交到现有 DSH Web Session 并等待独立审批；普通实现、状态查询、批准、取消或复审请求不单独触发此 Skill。
---

# M2 Web Handoff

本 Skill 只把一个方案交给当前项目已有的 DSH Web Host，并在获得提交回执后停止。它通过项目现有 CLI 调用，不实现认证、Remote API 或另一条审批通道。

操作契约、请求文件字段、CLI 回执和错误恢复以 [M2 Web Handoff 操作规范 v0.1](../../../docs/m2-web-handoff.md) 为准。需要准备或恢复请求时先阅读该文档。

## 触发与前置条件

- 用户明确要求“提交/交接到 M2”或等价表达，并授权把当前明确方案送入审批队列。普通“帮我完成这个任务”不构成交接授权。
- 目标是本地项目路径和一个已存在的 DSH `web` Session。项目根目录与 Session `cwd` 必须相同；不创建 Session、不自动猜另一个 Session。
- 方案有明确目标、仓库相对修改范围、排除项或非目标、验收条件及执行要求。无法从当前对话和只读检查确定的范围先向用户询问，不自行扩写。
- 可取得该仓库实际 branch 和完整 HEAD。不得用默认分支或旧报告代替当前值。
- 运行环境已有 Node.js `>=22.19.0`、正在运行的 loopback DSH Web Host、该 Session 中的 `/dev-loop-m2` 命令，以及项目目录外的有效 token 文件。若 token 文件缺失或 Host 已重启导致令牌失效，按 README 的阶段 A 说明处理；不要索要或输出令牌、Cookie。

## 授权边界

自然语言交接授权只允许提交方案并取得 `WAITING_FOR_APPROVAL` 回执。它不批准方案、不启动 Agent、不批准 DSH 原生工具操作，也不授权取消 Run 或提交 Reviewer 结论。

提交后报告回执并停止。即使用户在同一条请求中要求“提交后自动批准并开始”，本 Skill 也只执行交接；针对已展示方案的批准必须由用户在之后单独作出，再由对应 DSH Session 执行现有批准命令。DSH 的原生权限和逐次工具审批始终有效。

## 执行

1. 确认 Node 版本、当前工作目录、目标项目根目录、`git status --short`、当前分支和 `git rev-parse HEAD`。只读核对，不更改、暂存或清理工作区。
2. 确认用户提供或可信上下文明确给出的现有 Session ID。token 文件默认使用 `$HOME/.config/dsh-dev-loop/web-startup-token`；只有用户明确提供其他受保护文件路径时才替换该值。若 Session ID 不明，停止并询问；若 token 文件缺失或失效，按 README 说明处理，不要从日志猜测或索要令牌内容。
3. 根据已授权方案生成一个新的安全 UUID，并构造符合操作规范的 `schema: 1` 请求对象。`source.type` 使用现有 Schema 唯一支持的 `chatgpt-web`；`conversationUrl` 可省略，不得把它当身份或授权证明。
4. 将请求对象序列化为 UTF-8 JSON，写到 `$HOME/.config/dsh-dev-loop/m2-requests/` 下的新文件。目录权限设为 `0700`，请求文件权限设为 `0600`；该目录应位于目标仓库外。保存好完整路径；重试必须使用同一文件字节和同一 `requestId`，不得重写原文件或生成新 ID。若目录无法安全创建或写入，停止并报告。
5. 只运行项目现有入口：

   ```bash
   node bin/dsh-dev-loop.mjs m2 submit \
     --profile web \
     --project-root /absolute/path/to/project \
     --session-id <existing-dsh-session-id> \
     --request-file /absolute/path/to/m2-request.json \
     --token-file "$HOME/.config/dsh-dev-loop/web-startup-token"
   ```

   若用户明确提供了其他受保护 token 文件路径，只替换 `--token-file` 的路径。默认 Host 为 `127.0.0.1:3080`；只有在用户给出或项目配置确认了另一个 loopback 端口时才传 `--port`。不得改用公开/远程 Host、Bridge、MCP/RPC 直连或其他提交入口。

6. CLI 返回成功后解析 stdout JSON，核对 `runId` 非空，`requestId`、`sessionId` 和 `projectRoot` 与本次请求一致，`state` 为 `WAITING_FOR_APPROVAL`，`planSha256` 为 64 位十六进制摘要，`deduplicated` 是布尔值。回执缺字段或目标不符时停止，不换 ID 重投。
7. 向用户报告 `runId`、`requestId`、目标 Session、回执状态、`planSha256`、`deduplicated` 和请求文件路径。明确说明提交没有批准或执行方案。`deduplicated: true` 是同一已保存请求的回执，不代表 Run 的实时状态。

## 失败恢复

- 输入或本地校验失败：只有在能证明请求尚未连接 Host 时，才另写修正文件并沿用原 ID；原文件不覆盖。若是否已调用 Host 不确定，保留原文件并按不确定结果处理。
- Session 不存在、`cwd` 不匹配或没有 `/dev-loop-m2`：停止并报告。不要创建 Session、改投其他 Session 或走旁路。
- Host 重启或 token 返回 401：停止，按 README 从当前 DSH Web 启动 URL 更新 token 文件。随后只用原请求文件、原 ID、原 Session 和原项目重试。
- Remote API 错误、连接中断、外层执行器超时或用户中断 CLI：不能推断 Host 未收到请求。若本地 CLI 仍在运行，不并行提交；报告进程仍运行、结果未定，并等待用户决定是否中断。进程退出或被中断后，允许用完全相同的文件、ID 和目标重试，让 Controller 做持久化去重。中断本地 CLI 不代表 Host 已取消提交。
- `deduplicated: true`：报告原 Run 回执并停止。不要再生成一个 ID，也不要宣称其仍处于等待状态；如用户要求查询，请在原 DSH Session 使用现有状态命令。
- `EXTERNAL_REQUEST_ID_REUSED`：原 ID 绑定了其他内容或目标。保留原文件，停止；只有用户明确授权新的方案交接后才创建新请求。
- `EXTERNAL_REQUEST_OUTCOME_UNKNOWN`：持久记录不完整。停止重试和新建请求，报告错误中给出的 `runId`，保留文件与 ID，交由用户核对记录。
- 同一 Session 已有未结束 Run：不排队、不取消、不换 Session；报告阻塞并等待用户决定。

当前 CLI 仅为 `/connect` 设置 10 秒超时；后续 Remote API 请求没有内置 deadline 或独立状态查询子命令。若外层工具超时或命令挂起，不要声称服务端已取消或没有提交；遵循上面的原样重试规则。Controller 返回 `EXTERNAL_REQUEST_OUTCOME_UNKNOWN` 时必须停止并交由用户处理。

## 完成判定

只有收到并核对匹配的提交回执，才能报告“交接已提交”。没有有效回执时报告“提交结果未确认”或明确的 CLI 错误，不猜测成功。

回执表示方案已保存，执行仍等待独立批准。即使提交回执正确，也不得在本 Skill 中批准、取消、执行、复审或修改项目代码。
