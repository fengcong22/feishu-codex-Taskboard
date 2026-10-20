import { createHash, randomUUID } from "node:crypto";
import { createFeishuApiContext } from "../../src/feishu-api.mjs";
import { VmSourceError } from "./vm-source-transfer.mjs";

const MESSAGES = Object.freeze({
  auth_required: "Shadow 登录已失效或本机服务已重启，下载队列已暂停。请在电脑的 Taskboard「本机设置 → VM 下载」重新连接账号，之后将继续原申请。当前还不支持手机直接为电脑完成 Shadow 授权。",
  expiring: "Shadow 登录即将到期。请在电脑的 Taskboard「本机设置 → VM 下载」重新连接账号；队列和原审批会保留。",
  approval_reminder: "下载申请已等待审批超过 24 小时。审批通过后会自动继续；等待满 7 天将暂停，可在 VM 下载面板延长等待。",
  rejected: "下载申请被驳回，已停止处理。请在 VM 下载面板查看原申请。",
  canceled: "下载申请已撤销，已停止处理。",
  wait_expired: "审批或视频准备等待已超时，任务已暂停。在 VM 下载面板可延长等待，原申请会保留。",
  failed: "下载任务需要处理，已暂停。在 VM 下载面板查看错误和恢复操作，原申请会保留。",
});

export function createVmDownloadNotifier({ appId, appSecret, createContext = createFeishuApiContext, timeoutMs = 15000 } = {}) {
  const configured = Boolean(appId?.trim() && appSecret?.trim());
  let context;
  return {
    available: () => configured,
    async send({ id, recipient, kind, vmid }) {
      if (!configured) throw new VmSourceError("VM_NOTIFY_NOT_CONFIGURED");
      if (!/^[a-f0-9]{32}$/u.test(id) || typeof recipient !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)
        || !MESSAGES[kind] || (vmid !== null && !/^[a-f0-9]{24}$/u.test(vmid))) throw new VmSourceError("VM_NOTIFY_INPUT_INVALID");
      let timer;
      try {
        context ??= createContext({ appId, appSecret });
        await Promise.race([(async () => {
          const { client } = await context;
          const result = await client.im.message.create({ params: { receive_id_type: "email" }, data: {
            receive_id: recipient, msg_type: "text", uuid: id,
            content: JSON.stringify({ text: `VM 下载${vmid ? ` · ${vmid}` : ""}\n${MESSAGES[kind]}` }),
          } });
          if (result?.code !== 0 || !result.data?.message_id) throw new Error("notification rejected");
        })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("notification timeout")), timeoutMs); })]);
      } catch {
        context = undefined;
        throw new VmSourceError("VM_NOTIFY_SEND_FAILED");
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
      lease_id TEXT, lease_until INTEGER, sent_at INTEGER, error_code TEXT
    );
  `);
  return {
    read(key) {
      const row = database.prepare("SELECT value_json FROM vm_download_local_state WHERE key = ?").get(key);
      try { return row ? JSON.parse(row.value_json) : null; }
      catch { throw new VmSourceError("VM_DOWNLOAD_STATE_INVALID"); }
    },
    write(key, value) {
      database.prepare("INSERT INTO vm_download_local_state(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(key, JSON.stringify(value));
    },
    enqueue({ key, recipient, kind, vmid = null }) {
      const id = createHash("sha256").update(`${recipient}:${key}`).digest("hex").slice(0, 32);
      database.prepare("INSERT OR IGNORE INTO vm_download_notifications(id,recipient,kind,vmid,status,attempts,next_at) VALUES (?,?,?,?,'pending',0,?)")
        .run(id, recipient, kind, vmid, now());
    },
    claim() {
      const lease = randomUUID();
      return database.prepare(`UPDATE vm_download_notifications SET lease_id=?, lease_until=?
        WHERE id=(SELECT id FROM vm_download_notifications WHERE status='pending' AND next_at<=?
        AND (lease_id IS NULL OR lease_until<=?) ORDER BY next_at,id LIMIT 1)
        RETURNING *`).get(lease, now() + 60000, now(), now()) ?? null;
    },
    complete(item, success) {
      const attempts = item.attempts + 1;
      const status = success ? "sent" : attempts >= 6 ? "failed" : "pending";
      database.prepare(`UPDATE vm_download_notifications SET status=?, attempts=?, next_at=?, lease_id=NULL,
        lease_until=NULL, sent_at=?, error_code=? WHERE id=? AND lease_id=? AND lease_until>?`)
        .run(status, attempts, now() + Math.min(1800000, 60000 * 2 ** (attempts - 1)),
          success ? now() : null, success ? null : "VM_NOTIFY_SEND_FAILED", item.id, item.lease_id, now());
    },
    summary() {
      const sent = database.prepare("SELECT MAX(sent_at) AS time FROM vm_download_notifications").get();
      const failed = database.prepare("SELECT error_code FROM vm_download_notifications WHERE status!='sent' AND error_code IS NOT NULL ORDER BY next_at DESC LIMIT 1").get();
      return { lastSentAt: sent.time ?? null, errorCode: failed?.error_code ?? null };
    },
  };
}
