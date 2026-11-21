import { useState } from "react";

import { acknowledgeBridgeDeadLetters, getBridgeDeliveryIssues, startBridgeListener } from "../api";
import type { BridgeDeliveryIssue, LinkHealth } from "../types";

type Text = (zh: string, en: string) => string;

/** Listener states the operator can recover from the dashboard. */
const STARTABLE = new Set(["disabled", "error", "stopped"]);

function time(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * Operator actions under the Bridge health row: start or reconnect the Feishu
 * long connection, list events that have not succeeded, and acknowledge dead
 * letters. Acknowledging keeps the record (so `event_id` dedupe still holds);
 * it only stops counting it as an open problem.
 */
export function BridgeOpsPanel({ health, text, onChanged }: { health: LinkHealth; text: Text; onChanged: () => void }) {
  const { bridge } = health;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [issues, setIssues] = useState<BridgeDeliveryIssue[] | null>(null);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  if (bridge.state !== "up" || bridge.stale) return null;
  const listenerState = bridge.listener?.state ?? null;
  const queue = bridge.queue;
  const openIssues = (queue?.deadLetter ?? 0) + (queue?.retryWait ?? 0) + (queue?.deadLetterAcknowledged ?? 0);
  const canStart = listenerState !== null && STARTABLE.has(listenerState);
  if (!canStart && openIssues === 0 && issues === null) return null;

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (failure) {
      const code = (failure as { code?: string })?.code;
      setMessage(text(`操作失败${code ? `：${code}` : ""}`, `Action failed${code ? `: ${code}` : ""}`));
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const result = await getBridgeDeliveryIssues();
    setIssues(result.items);
    setTotal(result.total);
    setSelected(new Set());
  }

  function startListener() {
    const confirmed = window.confirm(text(
      "启动飞书长连接？\n\n启动后本进程不再接受模拟事件。断连期间飞书表格的改动不会补跑，需要的记录请在飞书中改离触发选项再改回。",
      "Start the Feishu long connection?\n\nThis process will stop accepting simulated events. Changes made while it was off are not replayed.",
    ));
    if (!confirmed) return;
    void run(async () => {
      const result = await startBridgeListener();
      onChanged();
      return result.listener.state === "sdk_managed"
        ? text("长连接已接管。请用测试表事件确认端到端。", "Long connection is SDK-managed. Verify with a test-table event.")
        : text(`长连接状态：${result.listener.state ?? "未知"}`, `Listener state: ${result.listener.state ?? "unknown"}`);
    });
  }

  function acknowledge() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const confirmed = window.confirm(text(
      `确认清除 ${ids.length} 条死信？\n\n记录会保留在 Bridge 状态文件中（同一事件重放仍会被去重），只是不再计入异常。不会重试，也不会创建任务。`,
      `Acknowledge ${ids.length} dead letters?\n\nThe records stay in the Bridge state file, so replays are still deduplicated. Nothing is retried.`,
    ));
    if (!confirmed) return;
    void run(async () => {
      const result = await acknowledgeBridgeDeadLetters(ids);
      await load();
      onChanged();
      return text(
        `已确认 ${result.acknowledged.length} 条${result.skipped.length ? `，跳过 ${result.skipped.length} 条` : ""}`,
        `Acknowledged ${result.acknowledged.length}${result.skipped.length ? `, skipped ${result.skipped.length}` : ""}`,
      );
    });
  }

  const openDeadLetters = (issues ?? []).filter(item => item.deliveryState === "dead_letter" && !item.acknowledgedAt);
  const allSelected = openDeadLetters.length > 0 && openDeadLetters.every(item => selected.has(item.eventId));

  return (
    <div className="vm-bridge-ops">
      <div className="vm-bridge-ops-actions">
        {canStart && (
          <button type="button" disabled={busy} onClick={startListener}>
            {listenerState === "disabled" ? text("启动长连接", "Start listener") : text("重连长连接", "Reconnect listener")}
          </button>
        )}
        {openIssues > 0 && (
          <button type="button" disabled={busy} onClick={() => {
            if (issues) { setIssues(null); return; }
            void run(async () => { await load(); return ""; });
          }}>
            {issues ? text("收起明细", "Hide details") : text("查看队列明细", "Show queue details")}
          </button>
        )}
        {message && <span className="vm-bridge-ops-message" role="status">{message}</span>}
      </div>
      {issues && (
        <div className="vm-bridge-ops-list">
          {issues.length === 0 ? (
            <div className="vm-bridge-ops-empty">{text("没有待重试或死信事件。", "No retrying or dead-letter events.")}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={text("全选未确认死信", "Select all open dead letters")}
                      checked={allSelected}
                      disabled={busy || openDeadLetters.length === 0}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(openDeadLetters.map(item => item.eventId)))}
                    />
                  </th>
                  <th>{text("状态", "State")}</th>
                  <th>{text("时间", "Time")}</th>
                  <th>{text("记录", "Record")}</th>
                  <th>{text("错误码", "Error")}</th>
                  <th>{text("次数", "Attempts")}</th>
                </tr>
              </thead>
              <tbody>
                {issues.map(item => {
                  const selectable = item.deliveryState === "dead_letter" && !item.acknowledgedAt;
                  const state = item.deliveryState === "retry_wait"
                    ? text(`等待重试（${time(item.nextAttemptAt)}）`, `Retry at ${time(item.nextAttemptAt)}`)
                    : item.acknowledgedAt ? text("死信·已确认", "Dead letter, acknowledged") : text("死信", "Dead letter");
                  return (
                    <tr key={item.eventId} className={item.acknowledgedAt ? "is-acknowledged" : undefined}>
                      <td>
                        {selectable && (
                          <input
                            type="checkbox"
                            aria-label={text(`选择 ${item.eventId}`, `Select ${item.eventId}`)}
                            checked={selected.has(item.eventId)}
                            disabled={busy}
                            onChange={() => setSelected(previous => {
                              const next = new Set(previous);
                              if (next.has(item.eventId)) next.delete(item.eventId); else next.add(item.eventId);
                              return next;
                            })}
                          />
                        )}
                      </td>
                      <td>{state}{item.source === "simulation" ? text("·模拟", " · simulated") : ""}</td>
                      <td>{time(item.updatedAt)}</td>
                      <td title={item.eventId}>{item.recordTitle ?? item.recordId ?? "—"}</td>
                      <td>{item.errorCode ?? "—"}</td>
                      <td>{item.attempts}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="vm-bridge-ops-actions">
            {total > issues.length && (
              <span>{text(`仅显示最近 ${issues.length} 条，共 ${total} 条`, `Showing the latest ${issues.length} of ${total}`)}</span>
            )}
            <button type="button" disabled={busy || selected.size === 0} onClick={acknowledge}>
              {text(`确认清除所选死信（${selected.size}）`, `Acknowledge selected (${selected.size})`)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
