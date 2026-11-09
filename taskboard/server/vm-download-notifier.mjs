import { createHash, randomUUID } from "node:crypto";
import { createFeishuApiContext } from "../../src/feishu-api.mjs";
import { VmSourceError } from "./vm-source-transfer.mjs";

const MESSAGES = Object.freeze({
  test: "这是一条 Taskboard 飞书通知测试消息。收到这条消息，表示飞书发送接口已确认受理。",
  auth_required: "Shadow 登录已失效或本机服务已重启，下载队列已暂停。请在运行 Taskboard 的电脑顶部栏打开“VM 状态菜单”，点击“连接 Shadow 账号”或“重新连接账号”，在 Shadow 登录窗口完成授权，之后将继续原申请。当前还不支持手机直接为电脑完成 Shadow 授权。",
  expiring: "Shadow 登录预计将在 30 分钟内到期。请在运行 Taskboard 的电脑顶部栏打开“VM 状态菜单”，点击“重新连接账号”，在 Shadow 登录窗口完成授权。队列和原审批会保留。",
  approval_reminder: "下载申请已等待审批超过 24 小时。审批通过后会自动继续；等待满 7 天将暂停，可在 VM 下载面板延长等待。",
  rejected: "下载申请被驳回，已停止处理。请在 VM 下载面板查看原申请。",
  canceled: "下载申请已撤销，已停止处理。",
  wait_expired: "审批或视频准备等待已超时，任务已暂停。在 VM 下载面板可延长等待，原申请会保留。",
  failed: "下载任务需要处理，已暂停。在 VM 下载面板查看错误和恢复操作，原申请会保留。",
});
const WORKFLOW_STAGES = Object.freeze({ initial: "初稿", review: "审核修改", first_review: "一审", final_review: "终审", workflow: "流程" });
const CONTROL = /[\u0000-\u001f\u007f]/u;

function workflowPayload(value) {
  const fields = ["subject", "taskId", "taskTitle", "recordId", "stage", "status", "occurredAt", "reason"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) return false;
  if (fields.filter((field) => field !== "occurredAt").some((field) => typeof value[field] !== "string"
    || !value[field].trim() || value[field].length > (field === "reason" ? 800 : 512) || CONTROL.test(value[field]))) return false;
  return ["blocked", "needs_attention"].includes(value.status)
    && Number.isFinite(Date.parse(value.occurredAt))
    && new Date(Date.parse(value.occurredAt)).toISOString() === value.occurredAt;
}

function workflowMessage(value) {
  const occurredAt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value.occurredAt));
  const state = value.status === "needs_attention" ? "需要处理" : "遇到阻碍";
  const stage = WORKFLOW_STAGES[value.stage] ?? value.stage;
  return `Taskboard 学科流程${state}\n学科：${value.subject}\n任务：${value.taskTitle}（${value.taskId}）\n飞书记录：${value.recordId}\n阶段：${stage}\n发生时间：${occurredAt}\n原因：${value.reason}\n请在 Taskboard 中查看任务详情并处理。`;
}

function feishuCode(value) {
  const code = value?.code ?? value?.response?.data?.code ?? value?.response?.body?.code;
  if (Number.isSafeInteger(code) && code > 0 && code <= 9_999_999_999) return `VM_NOTIFY_FEISHU_${code}`;
  if (typeof code === "string" && /^[1-9][0-9]{0,9}$/u.test(code)) return `VM_NOTIFY_FEISHU_${code}`;
  return null;
}

function failureCode(error) {
  if (error instanceof VmSourceError && error.code.startsWith("VM_NOTIFY_")) return error.code;
  const apiCode = feishuCode(error);
  if (apiCode) return apiCode;
  const status = error?.status ?? error?.response?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `VM_NOTIFY_HTTP_${status}`;
  switch (error?.code) {
    case "ETIMEDOUT": case "ESOCKETTIMEDOUT": return "VM_NOTIFY_TIMEOUT";
    case "ENOTFOUND": case "EAI_AGAIN": return "VM_NOTIFY_DNS_FAILED";
    case "ECONNREFUSED": return "VM_NOTIFY_CONNECT_FAILED";
    case "ECONNRESET": case "EPIPE": return "VM_NOTIFY_CONNECTION_RESET";
    default: return "VM_NOTIFY_SDK_FAILED";
  }
}

export function createVmDownloadNotifier({ appId, appSecret, createContext = createFeishuApiContext, timeoutMs = 15000 } = {}) {
  const configured = Boolean(appId?.trim() && appSecret?.trim());
  let context;
  return {
    available: () => configured,
    async send(input) {
      const { id, recipient, kind, vmid } = input ?? {};
      const payload = input?.payload;
      if (!configured) throw new VmSourceError("VM_NOTIFY_NOT_CONFIGURED");
      if (!/^[a-f0-9]{32}$/u.test(id) || typeof recipient !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)
        || !(MESSAGES[kind] || kind === "workflow_blocked") || (vmid !== null && !/^[a-f0-9]{24}$/u.test(vmid))
        || kind === "workflow_blocked" && !workflowPayload(payload)) throw new VmSourceError("VM_NOTIFY_INPUT_INVALID");
      let timer;
      try {
        context ??= createContext({ appId, appSecret });
        await Promise.race([(async () => {
          const { client } = await context;
          const result = await client.im.message.create({ params: { receive_id_type: "email" }, data: {
            receive_id: recipient, msg_type: "text", uuid: id,
            content: JSON.stringify({ text: kind === "workflow_blocked" ? workflowMessage(payload)
              : `VM 下载${vmid ? ` · ${vmid}` : ""}\n${MESSAGES[kind]}` }),
          } });
          if (result?.code !== 0) throw new VmSourceError(feishuCode(result) ?? "VM_NOTIFY_API_REJECTED");
          if (!result.data?.message_id) throw new VmSourceError("VM_NOTIFY_ACK_MISSING");
        })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new VmSourceError("VM_NOTIFY_TIMEOUT")), timeoutMs); })]);
      } catch (error) {
        context = undefined;
        throw new VmSourceError(failureCode(error));
      } finally { clearTimeout(timer); }
    },
  };
}

/** Local settings/outbox use Taskboard's SQLite connection, never the active job JSON.
 * A stable SDK uuid also deduplicates a retry after an uncertain HTTP result. */
export function createVmDownloadMetadata({ database, now = Date.now }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS vm_download_local_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS vm_download_notifications (
      id TEXT PRIMARY KEY, recipient TEXT NOT NULL, kind TEXT NOT NULL, vmid TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL,
      lease_id TEXT, lease_until INTEGER, sent_at INTEGER, error_code TEXT, payload_json TEXT
    );
    CREATE TABLE IF NOT EXISTS vm_workflow_notification_edges (
      event_key TEXT PRIMARY KEY, consumed_at INTEGER NOT NULL
    );
  `);
  if (!database.prepare("PRAGMA table_info(vm_download_notifications)").all().some((column) => column.name === "payload_json")) {
    database.exec("ALTER TABLE vm_download_notifications ADD COLUMN payload_json TEXT");
  }
  return {
    read(key) {
      const row = database.prepare("SELECT value_json FROM vm_download_local_state WHERE key = ?").get(key);
      try { return row ? JSON.parse(row.value_json) : null; }
      catch { throw new VmSourceError("VM_DOWNLOAD_STATE_INVALID"); }
    },
    write(key, value) {
      database.prepare("INSERT INTO vm_download_local_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(key, JSON.stringify(value));
    },
    enqueue({ key, recipient, kind, vmid = null, payload = null }) {
      const id = createHash("sha256").update(`${recipient}:${key}`).digest("hex").slice(0, 32);
      database.prepare("INSERT OR IGNORE INTO vm_download_notifications(id,recipient,kind,vmid,status,attempts,next_at,payload_json) VALUES (?,?,?,?,'pending',0,?,?)")
        .run(id, recipient, kind, vmid, now(), payload === null ? null : JSON.stringify(payload));
      return id;
    },
    consumeWorkflowEdge({ key, recipient = null, payload }) {
      database.exec("SAVEPOINT workflow_notification_edge");
      try {
        const consumed = database.prepare("INSERT OR IGNORE INTO vm_workflow_notification_edges(event_key,consumed_at) VALUES (?,?)")
          .run(key, now());
        let id = null;
        if (consumed.changes === 1 && recipient !== null) {
          id = createHash("sha256").update(`${recipient}:${key}`).digest("hex").slice(0, 32);
          database.prepare(`INSERT OR IGNORE INTO vm_download_notifications
            (id,recipient,kind,vmid,status,attempts,next_at,payload_json) VALUES (?,?,'workflow_blocked',NULL,'pending',0,?,?)`)
            .run(id, recipient, now(), JSON.stringify(payload));
        }
        database.exec("RELEASE workflow_notification_edge");
        return id;
      } catch (error) {
        database.exec("ROLLBACK TO workflow_notification_edge; RELEASE workflow_notification_edge");
        throw error;
      }
    },
    claim() {
      const lease = randomUUID();
      return database.prepare(`UPDATE vm_download_notifications SET lease_id=?, lease_until=?
        WHERE id=(SELECT id FROM vm_download_notifications WHERE status='pending' AND next_at<=?
        AND (lease_id IS NULL OR lease_until<=?) ORDER BY next_at,id LIMIT 1)
        RETURNING *`).get(lease, now() + 60000, now(), now()) ?? null;
    },
    complete(item, success, failure = "VM_NOTIFY_SEND_FAILED") {
      const attempts = item.attempts + 1;
      const status = success ? "sent" : attempts >= 6 ? "failed" : "pending";
      const errorCode = typeof failure === "string" && /^VM_NOTIFY_[A-Z0-9_]{1,80}$/u.test(failure)
        ? failure : "VM_NOTIFY_SEND_FAILED";
      database.prepare(`UPDATE vm_download_notifications SET status=?, attempts=?, next_at=?, lease_id=NULL,
        lease_until=NULL, sent_at=?, error_code=? WHERE id=? AND lease_id=? AND lease_until>?`)
        .run(status, attempts, now() + Math.min(1800000, 60000 * 2 ** (attempts - 1)),
          success ? now() : null, success ? null : errorCode, item.id, item.lease_id, now());
    },
    dismiss(item) {
      database.prepare(`UPDATE vm_download_notifications SET status='dismissed', lease_id=NULL,
        lease_until=NULL, error_code=NULL WHERE id=? AND lease_id=? AND lease_until>?`)
        .run(item.id, item.lease_id, now());
    },
    summary() {
      const sent = database.prepare("SELECT MAX(sent_at) AS time FROM vm_download_notifications").get();
      const pending = database.prepare("SELECT COUNT(*) AS count FROM vm_download_notifications WHERE status='pending'").get();
      const failed = database.prepare("SELECT COUNT(*) AS count FROM vm_download_notifications WHERE status='failed'").get();
      const currentError = database.prepare("SELECT error_code FROM vm_download_notifications WHERE status='pending' AND error_code IS NOT NULL ORDER BY next_at DESC LIMIT 1").get();
      const lastFailure = database.prepare("SELECT error_code FROM vm_download_notifications WHERE status='failed' AND error_code IS NOT NULL ORDER BY next_at DESC LIMIT 1").get();
      return { lastSentAt: sent.time ?? null, errorCode: currentError?.error_code ?? null,
        pendingCount: pending.count, failedCount: failed.count, lastFailureCode: lastFailure?.error_code ?? null };
    },
  };
}
