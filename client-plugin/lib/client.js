window.__ModuleLoader__.load({
  id: "dsh-dev-loop-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const CLIENT_BUILD_ID = "0.1.0-card-v1";

    const EVENT_TYPES = new Set([
      "dev-loop/run-started",
      "dev-loop/progress",
      "dev-loop/diagnostic",
      "dev-loop/run-finished",
    ]);

    const ORDER = [
      "CHECKING_ENVIRONMENT",
      "ANALYZING",
      "PLAN_READY",
      "WAITING_FOR_APPROVAL",
      "EXECUTING",
      "COLLECTING_EVIDENCE",
      "REVIEWING",
      "COMPLETE",
    ];

    const LABELS = {
      CHECKING_ENVIRONMENT: "检查运行环境",
      ANALYZING: "分析项目现状",
      PLAN_READY: "生成修改方案",
      WAITING_FOR_APPROVAL: "等待确认",
      EXECUTING: "修改代码",
      COLLECTING_EVIDENCE: "运行验证",
      REVIEWING: "审阅结果",
      COMPLETE: "任务完成",
      STOPPED: "任务已停止",
      FAILED: "任务失败",
      CANCELLED: "任务已取消",
    };

    const TERMINAL = new Set(["COMPLETE", "STOPPED", "FAILED", "CANCELLED"]);

    function contextLocation(context) {
      return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
    }

    const definition = {
      kind: "dev-loop-run",
      target: "chat",
      match(event) {
        if (!EVENT_TYPES.has(event.type)) return null;
        const runId = event.data?.runId;
        if (typeof runId !== "string" || runId === "") return null;
        return { id: runId, role: event.type === "dev-loop/run-started" ? "start" : "update" };
      },
      start(_context, match) {
        return {
          runId: match.event.data.runId,
          projectRoot: match.event.data.projectRoot,
          artifactRoot: match.event.data.artifactRoot,
          stage: "IDLE",
          label: "准备任务",
          detail: "任务已经进入运行队列。",
          history: [],
          startedAt: match.event.data.at,
          anchorSeq: match.event.seq,
          diagnostic: null,
          summary: null,
          decision: null,
          fingerprint: match.event.data.fingerprint ?? null,
        };
      },
      update(context, match) {
        const data = match.event.data ?? {};
        const next = { ...context.state };
        if (data.fingerprint) next.fingerprint = data.fingerprint;
        if (match.event.type === "dev-loop/progress") {
          next.stage = data.stage ?? next.stage;
          next.label = data.label ?? LABELS[data.stage] ?? next.label;
          next.detail = data.detail ?? next.detail;
          next.round = data.round ?? next.round;
          next.decision = data.decision ?? next.decision;
          next.hasModifiedProject = data.hasModifiedProject ?? next.hasModifiedProject;
          if (data.stage && !next.history.includes(data.stage)) next.history = [...next.history, data.stage];
        } else if (match.event.type === "dev-loop/diagnostic") {
          next.diagnostic = data.diagnostic ?? data;
        } else if (match.event.type === "dev-loop/run-finished") {
          next.stage = data.state ?? next.stage;
          next.label = LABELS[next.stage] ?? next.label;
          next.summary = data.summary ?? null;
          next.diagnostic = data.diagnostic ?? next.diagnostic;
          next.decision = data.decision ?? next.decision;
          next.finishedAt = data.at;
        }
        return next;
      },
      publication() { return "immediate"; },
      buildViewNode(context) {
        const state = context.state;
        if (!state) return null;
        return {
          key: context.key,
          kind: "dev-loop-card",
          id: context.id,
          target: "chat",
          anchorSeq: state.anchorSeq,
          location: contextLocation(context),
          visibility: "visible",
          data: state,
        };
      },
    };

    function statusTone(stage) {
      if (stage === "COMPLETE") return "success";
      if (stage === "FAILED" || stage === "STOPPED") return "error";
      if (stage === "CANCELLED") return "muted";
      return "active";
    }

    const DevLoopCard = React.memo(function DevLoopCard({ node }) {
      const data = node.data;
      const tone = statusTone(data.stage);
      const stages = ORDER.map((stage) => {
        const completed = data.history.includes(stage) || data.stage === stage || (data.stage === "COMPLETE" && stage !== "COMPLETE");
        const current = data.stage === stage && !TERMINAL.has(data.stage);
        return React.createElement("li", { key: stage, className: `dshDevLoopStep ${completed ? "isDone" : ""} ${current ? "isCurrent" : ""}` },
          React.createElement("span", { className: "dshDevLoopDot", "aria-hidden": true }, current ? "●" : completed ? "✓" : "○"),
          React.createElement("span", null, LABELS[stage]),
        );
      });
      const summary = data.summary ?? {};
      const technical = data.diagnostic?.technical;
      const fingerprint = data.fingerprint;
      const versionText = fingerprint?.backend?.buildId
        ? `后端 ${fingerprint.backend.buildId} · 客户端 ${fingerprint.client?.buildId ?? CLIENT_BUILD_ID}`
        : "运行版本：未知（旧服务器或旧事件）";
      return React.createElement("section",  { className: `dshDevLoopCard tone-${tone}`, "data-run-id": data.runId },
        React.createElement("header", { className: "dshDevLoopHeader" },
          React.createElement("div", null,
            React.createElement("div", { className: "dshDevLoopEyebrow" }, "可追踪开发流程"),
            React.createElement("h3", null, data.label ?? LABELS[data.stage] ?? "处理任务"),
          ),
          React.createElement("span", { className: "dshDevLoopBadge" }, TERMINAL.has(data.stage) ? "已结束" : data.stage === "WAITING_FOR_APPROVAL" ? "待确认" : "运行中"),
        ),
        React.createElement("p", { className: "dshDevLoopDetail" }, data.diagnostic?.message ?? data.detail),
        React.createElement("ol", { className: "dshDevLoopTimeline" }, stages),
        React.createElement("div", { className: "dshDevLoopFacts" },
          summary.test ? React.createElement("span", null, `测试：${summary.test.ok ? "通过" : "未通过"}`) : null,
          Number.isInteger(summary.changedFiles) ? React.createElement("span", null, `变更文件：${summary.changedFiles} 个`) : null,
          data.round ? React.createElement("span", null, `执行轮次：${data.round + 1}`) : null,
        ),
        data.diagnostic ? React.createElement("div", { className: "dshDevLoopDiagnostic" },
          React.createElement("strong", null, data.diagnostic.title),
          React.createElement("p", null, data.diagnostic.suggestion),
        ) : null,
        React.createElement("footer", { className: "dshDevLoopFooter" },
          React.createElement("code", null, data.runId),
          React.createElement("span", null, versionText),
          !TERMINAL.has(data.stage) ? React.createElement("span", null, "输入 /dev-loop approve 或 cancel + runId 控制") : null,
        ),
        React.createElement("details", { className: "dshDevLoopTechnical" },
          React.createElement("summary", null, "技术详情"),
          React.createElement("pre", null, JSON.stringify({
            runId: data.runId,
            stage: data.stage,
            projectRoot: data.projectRoot,
            decision: data.decision,
            fingerprint,
            technical,
          }, null, 2)),
        ),
      );
    });

    const css = `
.dshDevLoopCard{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-base);padding:16px;box-shadow:0 4px 18px rgba(0,0,0,.05)}
.dshDevLoopCard.tone-active{border-color:var(--dsw-alias-state-business-primary)}
.dshDevLoopCard.tone-success{border-color:var(--dsw-alias-state-success-primary)}
.dshDevLoopCard.tone-error{border-color:var(--dsw-alias-state-error-primary)}
.dshDevLoopHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dshDevLoopHeader h3{font-size:16px;line-height:24px;margin:2px 0;color:var(--dsw-alias-label-primary)}
.dshDevLoopEyebrow{font-size:11px;color:var(--dsw-alias-label-caption)}.dshDevLoopBadge{font-size:12px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshDevLoopDetail{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:8px 0 12px}.dshDevLoopTimeline{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:7px 10px}
.dshDevLoopStep{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-caption)}.dshDevLoopStep.isDone{color:var(--dsw-alias-label-secondary)}.dshDevLoopStep.isCurrent{color:var(--dsw-alias-state-business-primary);font-weight:600}.dshDevLoopDot{width:14px;text-align:center}
.dshDevLoopFacts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.dshDevLoopFacts span{font-size:12px;padding:3px 7px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshDevLoopDiagnostic{margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--dsw-specific-warning);color:var(--dsw-alias-label-primary)}.dshDevLoopDiagnostic p{margin:4px 0 0;font-size:12px;line-height:18px}
.dshDevLoopFooter{display:flex;justify-content:space-between;gap:12px;margin-top:12px;color:var(--dsw-alias-label-caption);font-size:11px}.dshDevLoopFooter code{font-family:var(--dsw-font-family-mono,monospace)}
.dshDevLoopTechnical{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}.dshDevLoopTechnical summary{cursor:pointer}.dshDevLoopTechnical pre{white-space:pre-wrap;overflow:auto;max-height:240px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-l2);font-size:11px}
`;

    const inject = ["slots", "conversationEvents"];
    function apply(ctx) {
      if (typeof document !== "undefined" && !document.querySelector('style[data-plugin-css="dsh-dev-loop"]')) {
        const style = document.createElement("style");
        style.dataset.pluginCss = "dsh-dev-loop";
        style.textContent = css;
        document.head.appendChild(style);
      }
      ctx.conversationEvents.register(definition);
      ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
        name: "conversation.chat.node",
        key: "dev-loop-card",
      }, DevLoopCard));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.definition = definition;
    exports.DevLoopCard = DevLoopCard;
    return module.exports;
  },
});
