import { useEffect, useMemo, useState } from "react";

import "./VmOverviewDashboard.css";
import { getVmOverview } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { Task, VmOverview, VmOverviewTask } from "../types";

type Props = {
  projectId: string | null;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
};

const REFRESH_MS = 15_000;

/** Human labels for the failure codes a person can actually act on. */
const REASONS: Record<string, [string, string]> = {
  VM_DOWNLOAD_FAILED: ["素材下载失败，需人工放素材", "Material download failed"],
  WORD_ALIGNMENT_UNRESOLVED: ["语音词对齐不确定，可重做规划", "Word alignment unresolved"],
  PLAN_INVALID: ["已保存的规划校验未通过", "Saved plan failed validation"],
  VM_PMO_START_EVIDENCE_FAILED: ["渲染未启动，可用原规划重渲", "Render never started"],
  UNSUPPORTED_INSTRUCTION: ["修改意见无法自动执行，需人工方案", "Instruction needs a manual plan"],
  VM_APPLICANT_CHANGED: ["申请人已变更，需重新排队", "Applicant changed"],
  VM_PMO_RECORD_CHANGED: ["飞书记录已变化，需确认后重试", "Feishu record changed"],
  AI_INTENT_SCOPE_VIOLATION: ["AI 规划越权，需人工检查", "AI intent overstepped its scope"],
  AI_INTENT_TIMEOUT: ["AI 规划超时，可重跑", "AI planning timed out"],
  AI_INTENT_MISSING: ["AI 未产出剪辑意图，可重跑", "AI produced no intent"],
  AI_INTENT_FAILED: ["AI 会话失败，可重跑", "AI session failed"],
  VM_PMO_AI_SESSION_CHANGED: ["AI 模型已切换，与冻结模型不一致", "AI model differs from the frozen one"],
  VM_PMO_REVIEW_SOURCE_INVALID: ["审核轮原片链路不完整", "Review source chain is incomplete"],
  VM_REVIEW_IMAGES_UNSUPPORTED: ["审核意见带截图，当前版本不支持", "Review images are unsupported"],
  VM_TASK_BINDING_CONFLICT: ["任务与审批绑定冲突", "Task binding conflict"],
  VM_WRITEBACK_DEAD_LETTER: ["进度回写失败，可重试回写", "Progress writeback failed"],
  VM_ARCHIVE_CONFLICT: ["成片归档冲突，同名异 SHA", "Archive conflict: same name, different SHA"],
  VM_ARCHIVE_DEAD_LETTER: ["成片归档失败", "Final archive failed"],
  VM_PMO_STATE_INVALID: ["运行状态记录损坏", "Run state is unreadable"],
  VM_AUTH_REQUIRED: ["VM 登录失效，需重新连接", "VM sign-in required"],
};

const COLUMNS: Array<[VmOverviewTask["column"], string, string]> = [
  ["todo", "待登记", "Ready"],
  ["materials", "等素材", "Materials"],
  ["queued", "排队等槽", "Queued"],
  ["editing", "剪辑中", "Editing"],
  ["feishu_delivery", "回写飞书", "Feishu delivery"],
  ["awaiting_feishu_review", "等飞书审核", "Awaiting review"],
  ["nas_upload", "上传 NAS", "NAS upload"],
  ["completed", "已完成", "Completed"],
  ["needs_attention", "需要处理", "Needs attention"],
];

function reasonLabel(code: string, text: (zh: string, en: string) => string) {
  const known = REASONS[code];
  return known ? text(known[0], known[1]) : code;
}

function duration(value: number | null | undefined, text: (zh: string, en: string) => string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const minutes = Math.round(value / 60_000);
  if (minutes < 1) return text("不足 1 分钟", "< 1 min");
  if (minutes < 60) return text(`${minutes} 分钟`, `${minutes} min`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return text(`${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`, `${hours} h ${minutes % 60} min`);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return text(`${days} 天${rest ? ` ${rest} 小时` : ""}`, `${days} d${rest ? ` ${rest} h` : ""}`);
}

export function VmOverviewDashboard({ projectId, tasks, onOpenTask }: Props) {
  const { text } = useTaskboardI18n();
  const [overview, setOverview] = useState<VmOverview | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setOverview(null);
    setError(false);

    async function load() {
      try {
        const next = await getVmOverview(projectId, controller.signal);
        if (disposed) return;
        setOverview(next);
        setError(false);
      } catch (failure) {
        if (disposed || (failure instanceof Error && failure.name === "AbortError")) return;
        setError(true);
      }
      if (!disposed) timer = setTimeout(load, REFRESH_MS);
    }

    void load();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);

  function open(taskId: string) {
    const task = taskById.get(taskId);
    if (task) onOpenTask(task);
  }

  if (error && overview === null) {
    return (
      <div className="vm-overview" role="status">
        <div className="vm-overview-empty">{text("暂时无法读取剪辑流水线数据。", "The editing pipeline is unavailable right now.")}</div>
      </div>
    );
  }

  if (overview === null) {
    return (
      <div className="vm-overview" role="status" aria-live="polite">
        <div className="vm-overview-empty">{text("正在读取剪辑流水线…", "Loading the editing pipeline…")}</div>
      </div>
    );
  }

  const { kpis, slot } = overview;
  const kpiCards = [
    {
      key: "editing",
      label: text("剪辑中", "Editing"),
      value: String(kpis.editing),
      note: slot?.maxConcurrent
        ? text(`槽位 ${slot.activeCount ?? 0}/${slot.maxConcurrent}`, `Slot ${slot.activeCount ?? 0}/${slot.maxConcurrent}`)
        : text(`${kpis.activeRuns} 个运行中`, `${kpis.activeRuns} active runs`),
      tone: "editing",
    },
    {
      key: "approval",
      label: text("等 VM 审批", "Awaiting approval"),
      value: String(kpis.waitingApproval),
      note: kpis.oldestApprovalWaitMs === null
        ? text("当前没有等待", "Nothing is waiting")
        : text(`最久已等 ${duration(kpis.oldestApprovalWaitMs, text)}`, `Oldest ${duration(kpis.oldestApprovalWaitMs, text)}`),
      tone: "waiting",
    },
    {
      key: "attention",
      label: text("需要处理", "Needs attention"),
      value: String(kpis.needsAttention),
      note: text(`${overview.writebackDeadLetters} 条回写失败`, `${overview.writebackDeadLetters} writeback failures`),
      tone: kpis.needsAttention > 0 ? "blocked" : "calm",
    },
    {
      key: "delivered",
      label: text("近 7 天交付", "Delivered in 7 days"),
      value: String(kpis.deliveredLast7Days),
      note: text(`${kpis.publishedLast7Days} 个已发布 NAS`, `${kpis.publishedLast7Days} published to NAS`),
      tone: "delivered",
    },
    {
      key: "first-pass",
      label: text("一次通过率", "First-pass rate"),
      value: kpis.firstPassRate === null ? "—" : `${kpis.firstPassRate}%`,
      note: kpis.firstPassRate === null
        ? text("近 7 天没有交付", "No deliveries in 7 days")
        : text("无返修、无阻断的轮次", "Rounds with no retry or block"),
      tone: "quality",
    },
  ];

  const funnelTotal = Math.max(1, overview.funnel.reduce((total, item) => total + item.count, 0));

  return (
    <div className="vm-overview">
      <div className="vm-overview-kpis">
        {kpiCards.map(card => (
          <article className={`vm-kpi tone-${card.tone}`} key={card.key}>
            <span className="vm-kpi-label">{card.label}</span>
            <strong className="vm-kpi-value">{card.value}</strong>
            <span className="vm-kpi-note">{card.note}</span>
          </article>
        ))}
      </div>

      <section className="vm-overview-panel vm-overview-attention">
        <header>
          <span>{text("需要你处理", "Needs your attention")}</span>
          <b>{overview.attention.length}</b>
        </header>
        <div className="vm-overview-rows">
          {overview.attention.length ? overview.attention.map(item => (
            <button
              type="button"
              className="vm-attention-row"
              onClick={() => open(item.taskId)}
              key={item.taskId}
              title={item.errorCode ?? undefined}
            >
              <span className="vm-attention-copy">
                <strong>{item.title}</strong>
                <small>{reasonLabel(item.reasonCode ?? item.errorCode ?? "", text)}</small>
              </span>
              <span className="vm-attention-meta">
                {item.reviewRound > 0 && (
                  <em>{text(`第 ${item.reviewRound} 轮`, `Round ${item.reviewRound}`)}</em>
                )}
                {item.materialSource === "manual" && <em>{text("人工素材", "Manual source")}</em>}
                <time>{duration(item.stuckMs ?? null, text)}</time>
              </span>
            </button>
          )) : (
            <div className="vm-overview-empty">
              {text("流水线运行正常，没有卡住的任务。", "Nothing is stuck; the pipeline is clear.")}
            </div>
          )}
        </div>
      </section>

      <section className="vm-overview-panel vm-overview-funnel">
        <header><span>{text("产线漏斗", "Pipeline funnel")}</span></header>
        <div className="vm-funnel">
          {COLUMNS.map(([id, zh, en]) => {
            const count = overview.funnel.find(item => item.id === id)?.count ?? 0;
            return (
              <div
                className={`vm-funnel-segment${count ? "" : " is-empty"}${id === "needs_attention" && count ? " is-alert" : ""}`}
                key={id}
                style={{ flexGrow: count || 0 }}
              >
                <span className="vm-funnel-label">{text(zh, en)}</span>
                <strong>{count}</strong>
                <i style={{ width: `${(count / funnelTotal) * 100}%` }} aria-hidden="true" />
              </div>
            );
          })}
        </div>
        {slot?.pendingCount ? (
          <div className="vm-funnel-note">
            {text(
              `${slot.pendingCount} 个任务在等剪辑槽位（上限 ${slot.maxConcurrent ?? "?"}）`,
              `${slot.pendingCount} queued for an editing slot (limit ${slot.maxConcurrent ?? "?"})`,
            )}
          </div>
        ) : null}
      </section>

      <section className="vm-overview-panel vm-overview-failures">
        <header><span>{text("失败原因", "Failure reasons")}</span></header>
        <div className="vm-overview-rows">
          {overview.failures.length ? overview.failures.map(item => (
            <button
              type="button"
              className="vm-failure-row"
              onClick={() => open(item.taskIds[0])}
              key={item.errorCode}
            >
              <span className="vm-failure-copy">
                <strong>{reasonLabel(item.errorCode, text)}</strong>
                <small>{item.errorCode}</small>
              </span>
              <b>{item.count}</b>
            </button>
          )) : (
            <div className="vm-overview-empty">{text("当前没有被记录到的失败。", "No recorded failures right now.")}</div>
          )}
        </div>
      </section>

      <section className="vm-overview-panel vm-overview-quality">
        <header><span>{text("质量与耗时", "Quality and durations")}</span></header>
        <div className="vm-quality-body">
          <div className="vm-rounds">
            <span className="vm-quality-label">{text("每条记录的审核轮次", "Review rounds per record")}</span>
            {([
              ["one", text("1 轮", "1 round")],
              ["two", text("2 轮", "2 rounds")],
              ["threeOrMore", text("3 轮以上", "3+ rounds")],
            ] as const).map(([key, label]) => (
              <div className="vm-round-row" key={key}>
                <span>{label}</span>
                <i style={{ width: `${(overview.rounds[key] / Math.max(1, overview.rounds.one + overview.rounds.two + overview.rounds.threeOrMore)) * 100}%` }} aria-hidden="true" />
                <b>{overview.rounds[key]}</b>
              </div>
            ))}
          </div>
          <div className="vm-durations">
            <span className="vm-quality-label">{text("中位 / P90 耗时", "Median / P90 duration")}</span>
            {([
              ["plan", text("规划", "Planning")],
              ["render", text("渲染", "Rendering")],
              ["delivery", text("上传回写", "Upload")],
            ] as const).map(([key, label]) => {
              const entry = overview.durations[key];
              return (
                <div className="vm-duration-row" key={key}>
                  <span>{label}</span>
                  <b>{entry.samples ? `${duration(entry.median, text)} / ${duration(entry.p90, text)}` : text("样本不足", "Not enough data")}</b>
                  <small>{text(`${entry.samples} 个样本`, `${entry.samples} samples`)}</small>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="vm-overview-footer">
        <span>{text(`更新于 ${new Date(overview.generatedAt).toLocaleTimeString()}`, `Updated ${new Date(overview.generatedAt).toLocaleTimeString()}`)}</span>
        {overview.archiveFailures > 0 && (
          <span className="is-alert">{text(`${overview.archiveFailures} 个归档失败`, `${overview.archiveFailures} archive failures`)}</span>
        )}
      </div>
    </div>
  );
}
