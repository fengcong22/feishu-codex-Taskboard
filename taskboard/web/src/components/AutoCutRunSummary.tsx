import { useMemo } from "react";
import type { AutoCutRunConsent } from "../types";
import { autoCutDiagnostic } from "../autocutDiagnostics";
import { LinearIcon } from "./LinearIcon";

export interface AutoCutAttemptSummary {
  runId: string;
  attempt: number;
  stageId: string;
  state: string;
  manifestSha256?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  threadId?: string | null;
  executionKind?: "local" | "codex" | null;
  failedPhase?: string | null;
  lastPhase?: string | null;
}

export interface AutoCutRunSummaryProps {
  task: { id: string; version: number; status: string };
  attempts: AutoCutAttemptSummary[];
  retrying: boolean;
  onRetry: (taskId: string, version: number, runConsent: AutoCutRunConsent) => void | Promise<void>;
  onOpenLog?: (threadId: string) => void;
  onCopy?: (value: string, announcement: string) => void;
}

const STAGE_LABELS: Record<string, string> = {
  initial: "初稿",
  first_review: "初审修改",
  final_review: "终审修改",
};

const STATE_LABELS: Record<string, string> = {
  preparing: "准备中",
  prepared: "已准备",
  running: "剪辑中",
  blocked: "受阻",
  reported: "已上报",
  completed: "已完成",
};

function digestPrefix(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "未生成";
}

export function AutoCutRunSummary({ task, attempts, retrying, onRetry, onOpenLog, onCopy }: AutoCutRunSummaryProps) {
  const ordered = useMemo(
    () => [...attempts].sort((left, right) => left.attempt - right.attempt),
    [attempts],
  );
  if (ordered.length === 0) return null;
  const canRetry = task.status === "blocked" && !retrying;

  return <section className="autocut-run-summary" aria-labelledby="autocut-run-summary-heading">
    <header className="autocut-run-summary-heading">
      <div>
        <h2 id="autocut-run-summary-heading">Auto-Cut 运行</h2>
        <span>{ordered.length} 次尝试</span>
      </div>
      {canRetry && <button
        type="button"
        className="button secondary"
        aria-describedby="autocut-retry-consent"
        onClick={() => void onRetry(task.id, task.version, {
          allowVideoAudioAsr: true,
          allowConfiguredLocalOutput: true,
        })}
      >
        <LinearIcon name="recurrence" />
        重试 Auto-Cut
      </button>}
      {retrying && <span className="autocut-run-retrying" role="status">重试中…</span>}
    </header>
    {canRetry && <p id="autocut-retry-consent" className="autocut-retry-consent">
      点击重试，即允许本次 Auto-Cut 将视频原音发送至火山语音服务进行语音识别，并写入已配置的本机输出目录。
    </p>}
    <ol className="autocut-run-list">
      {ordered.map((attempt) => {
        const diagnostic = autoCutDiagnostic(attempt);
        const blocked = attempt.state === "blocked";
        return <li key={attempt.runId} className={`autocut-run-row is-${attempt.state}`}>
        <div className="autocut-run-row-main">
          <strong>第 {attempt.attempt} 次 · {STAGE_LABELS[attempt.stageId] ?? attempt.stageId}</strong>
          <span className="autocut-run-state">{STATE_LABELS[attempt.state] ?? attempt.state}</span>
        </div>
        <div className="autocut-run-row-meta">
          <span>运行 ID <code>{attempt.runId}</code></span>
          <span>清单 <code title={attempt.manifestSha256 ?? undefined}>{digestPrefix(attempt.manifestSha256)}</code></span>
        </div>
        {blocked && <>
          <p className="autocut-run-error" role="status">{diagnostic.summary}</p>
          <details className="autocut-diagnostic" open={attempt === ordered.at(-1)}>
            <summary>受阻诊断与检查建议</summary>
            <p>{diagnostic.phase}</p>
            <p className="autocut-diagnostic-context">{diagnostic.execution} · 错误码 <code>{diagnostic.code}</code></p>
            <h3>建议检查</h3>
            <ul>{diagnostic.checks.map((check) => <li key={check}>{check}</li>)}</ul>
            <p>{diagnostic.retryHint}</p>
            <div className="autocut-diagnostic-actions">
              {attempt.threadId && onOpenLog && <button type="button" className="button secondary" onClick={() => onOpenLog(attempt.threadId!)}>查看本次日志</button>}
              {onCopy && <button type="button" className="button secondary" onClick={() => onCopy([
                `任务 ID：${task.id}`, `第 ${attempt.attempt} 次尝试`, `运行 ID：${attempt.runId}`,
                diagnostic.execution, diagnostic.phase, `错误码：${diagnostic.code}`, diagnostic.summary,
                "建议检查：", ...diagnostic.checks, diagnostic.retryHint,
              ].join("\n"), "已复制排查信息")}>复制排查信息</button>}
            </div>
          </details>
        </>}
      </li>; })}
    </ol>
  </section>;
}

export default AutoCutRunSummary;
