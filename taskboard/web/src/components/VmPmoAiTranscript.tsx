import { useEffect, useState } from "react";

import { getTaskVmPmoAiTranscript } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { VmPmoAiSession, VmPmoAiStep } from "../types";

const OUTCOMES: Record<string, [string, string]> = {
  completed: ["已完成", "Completed"],
  failed: ["失败", "Failed"],
  timeout: ["超时", "Timed out"],
  interrupted: ["已中断", "Interrupted"],
};

function Step({ step }: { step: VmPmoAiStep }) {
  const { text } = useTaskboardI18n();
  if (step.kind === "command") {
    return (
      <li className="vm-pmo-ai-step is-command">
        <details>
          <summary>
            <span>{text("命令", "Command")}</span>
            {step.exitCode !== null && step.exitCode !== 0 && (
              <code className="vm-pmo-run-error-code">{text(`退出码 ${step.exitCode}`, `exit ${step.exitCode}`)}</code>
            )}
            <code>{step.command}</code>
          </summary>
          {step.output && <pre>{step.output}</pre>}
        </details>
      </li>
    );
  }
  if (step.kind === "file_change") {
    return <li className="vm-pmo-ai-step is-file">{text("写入文件：", "Wrote: ")}<code>{step.files.join("、")}</code></li>;
  }
  return <li className={`vm-pmo-ai-step is-${step.kind}`}>{step.text}</li>;
}

function Session({ session }: { session: VmPmoAiSession }) {
  const { text } = useTaskboardI18n();
  const outcome = session.outcome ? OUTCOMES[session.outcome] : undefined;
  const started = session.startedAt ? new Date(session.startedAt).toLocaleString() : null;
  return (
    <details className="vm-pmo-ai-session">
      <summary>
        <span>{text(`第 ${session.attempt.slice("attempt-".length)} 次规划 · 会话 ${session.session}`,
          `Planning ${session.attempt.slice("attempt-".length)} · session ${session.session}`)}</span>
        {outcome && <span className={`vm-pmo-run-state is-${session.outcome}`}>{text(outcome[0], outcome[1])}</span>}
        {session.resumed && <span>{text("接续上一轮对话", "Continued previous round")}</span>}
        {session.model && <code>{session.model}</code>}
        {started && <span>{started}</span>}
      </summary>
      {session.eventsMissing && <p>{text("没有找到这次会话的过程记录。", "No transcript was found for this session.")}</p>}
      {session.steps.length > 0 && (
        <ol className="vm-pmo-ai-steps">
          {session.steps.map((step, index) => <Step key={index} step={step} />)}
        </ol>
      )}
      {session.truncated && <p>{text("过程较长，只显示前面部分。", "Long transcript; only the beginning is shown.")}</p>}
      {session.report && (
        <div className="vm-pmo-ai-report">
          <strong>{text("最终报告", "Final report")}</strong>
          <p>{session.report}</p>
        </div>
      )}
    </details>
  );
}

/** The AI planning sessions of a VM/PMO run: what the AI said, the commands it ran and its report.
 * Loaded only when opened, and re-read when the run changes state. Display only. */
export function VmPmoAiTranscript({ taskId, refreshKey }: { taskId: string; refreshKey: string }) {
  const { text } = useTaskboardI18n();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<VmPmoAiSession[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setError(false);
    getTaskVmPmoAiTranscript(taskId, controller.signal).then(setSessions, (reason) => {
      if ((reason as Error).name !== "AbortError") setError(true);
    });
    return () => controller.abort();
  }, [open, taskId, refreshKey]);

  return (
    <details className="vm-pmo-ai-transcript" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{text("AI 推理过程", "AI reasoning")}</summary>
      {error && <p role="alert">{text("读取 AI 会话记录失败。", "Could not read the AI session transcript.")}</p>}
      {!error && sessions === null && open && <p>{text("正在读取…", "Loading…")}</p>}
      {sessions?.length === 0 && <p>{text("这次运行还没有 AI 会话。", "This run has no AI session yet.")}</p>}
      {sessions?.map((session) => <Session key={session.name} session={session} />)}
    </details>
  );
}
