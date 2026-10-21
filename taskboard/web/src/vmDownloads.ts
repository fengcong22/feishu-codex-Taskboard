import { ApiError, requestVmDownloads } from "./api";

export const VM_DOWNLOAD_REFRESH_INTERVAL_KEY = "taskboard.vm-status-refresh.v1";
export const VM_DOWNLOAD_REFRESH_CHANGE_EVENT = "taskboard-vm-download-refresh-change";
export const VM_DOWNLOAD_REFRESH_INTERVALS = new Set([0, 15_000, 30_000, 60_000, 300_000]);

export function getVmDownloadRefreshInterval(): number {
  try {
    const value = window.localStorage.getItem(VM_DOWNLOAD_REFRESH_INTERVAL_KEY);
    if (value === null) return 30_000;
    const interval = Number(value);
    return VM_DOWNLOAD_REFRESH_INTERVALS.has(interval) ? interval : 30_000;
  } catch {
    return 30_000;
  }
}

export interface VmDownloadSession {
  status: "disconnected" | "connecting" | "connected" | "auth_required" | "unavailable";
  account: { name: string; userId: string } | null;
  expiresAt: number | null;
  expirySource: "token" | "unknown";
  lastCheckedAt: number | null;
  errorCode: string | null;
  automaticRefreshSupported: false;
  crossDeviceAuthorizationSupported: false;
}

export interface VmDownloadSettings {
  outputRoot: string;
  department: string;
  reason: string;
  notificationsEnabled: boolean;
}

export interface VmDownloadJob {
  id: string;
  vmid: string;
  status: string;
  submission_attempts: number;
  attempts: number;
  next_attempt_at: number | null;
  application_id?: string;
  instance_code?: string;
  error?: { code: string; diagnostic_code?: string };
  created_at: number;
  updated_at: number;
  approval_wait_started_at?: number | null;
  approval_deadline_at?: number | null;
  media_wait_started_at?: number | null;
  media_deadline_at?: number | null;
  output_root: string;
  department: string;
  reason: string;
  acquisition?: { path: string; receipt_path: string; bytes: number };
  recovery?: { kind: "private_address" | "unknown_outcome" | "resource_claim" };
}

export interface VmDownloadsSnapshot {
  session: VmDownloadSession;
  settings: VmDownloadSettings;
  jobs: VmDownloadJob[];
  notifications: { available: boolean; enabled: boolean; errorCode: string | null; lastSentAt: number | null; pendingCount?: number; failedCount?: number };
  worker?: { running: boolean; errorCode: string | null };
}

function write<T>(path: string, body: unknown, method = "POST", signal?: AbortSignal): Promise<T> {
  return requestVmDownloads<T>(path, {
    method, headers: { "X-Taskboard-Client": "web" }, body: JSON.stringify(body), signal,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

function validSession(value: unknown): value is VmDownloadSession {
  return record(value) && ["disconnected", "connecting", "connected", "auth_required", "unavailable"].includes(String(value.status))
    && (value.account === null || (record(value.account) && strings(value.account, ["name", "userId"])))
    && ["token", "unknown"].includes(String(value.expirySource))
    && (value.expiresAt === null || (typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)))
    && (value.lastCheckedAt === null || (typeof value.lastCheckedAt === "number" && Number.isFinite(value.lastCheckedAt)))
    && (value.errorCode === null || typeof value.errorCode === "string")
    && value.automaticRefreshSupported === false && value.crossDeviceAuthorizationSupported === false;
}

export async function getVmDownloads(signal?: AbortSignal): Promise<VmDownloadsSnapshot> {
  const value = await requestVmDownloads<unknown>("", { signal });
  const pendingCount = record(value) && record(value.notifications) ? value.notifications.pendingCount : undefined;
  const failedCount = record(value) && record(value.notifications) ? value.notifications.failedCount : undefined;
  if (!record(value) || !validSession(value.session)
    || !record(value.settings) || !strings(value.settings, ["outputRoot", "department", "reason"])
    || typeof value.settings.notificationsEnabled !== "boolean"
    || !record(value.notifications) || typeof value.notifications.available !== "boolean" || typeof value.notifications.enabled !== "boolean"
    || (value.notifications.errorCode !== null && typeof value.notifications.errorCode !== "string")
    || (value.notifications.lastSentAt !== null && (typeof value.notifications.lastSentAt !== "number" || !Number.isFinite(value.notifications.lastSentAt)))
    || !((pendingCount === undefined && failedCount === undefined)
      || (Number.isSafeInteger(pendingCount) && Number(pendingCount) >= 0
        && Number.isSafeInteger(failedCount) && Number(failedCount) >= 0))
    || !Array.isArray(value.jobs) || value.jobs.some((job) => !record(job)
      || !strings(job, ["id", "vmid", "status", "output_root", "department", "reason"])
      || (job.application_id !== undefined && typeof job.application_id !== "string")
      || (job.instance_code !== undefined && typeof job.instance_code !== "string")
      || (job.acquisition !== undefined && (!record(job.acquisition) || !strings(job.acquisition, ["path", "receipt_path"])))
      || (job.error !== undefined && (!record(job.error) || typeof job.error.code !== "string"
        || (job.error.diagnostic_code !== undefined && (typeof job.error.diagnostic_code !== "string"
          || !/^[A-Z][A-Z0-9_]{1,80}$/u.test(job.error.diagnostic_code)))))
      || (job.recovery !== undefined && (!record(job.recovery)
        || !["private_address", "unknown_outcome", "resource_claim"].includes(String(job.recovery.kind)))))) {
    throw new ApiError(0, { error: { code: "VM_DOWNLOAD_RESPONSE_INVALID" } });
  }
  return value as unknown as VmDownloadsSnapshot;
}
export const saveVmDownloadSettings = (settings: VmDownloadSettings, signal?: AbortSignal) => write("/settings", settings, "PUT", signal);
export async function loginVmDownloads(signal?: AbortSignal): Promise<{ loginUrl: string; session: VmDownloadSession }> {
  const value = await write<unknown>("/login", {}, "POST", signal);
  if (!record(value) || typeof value.loginUrl !== "string" || !validSession(value.session)) {
    throw new ApiError(0, { error: { code: "VM_DOWNLOAD_RESPONSE_INVALID" } });
  }
  return { loginUrl: value.loginUrl, session: value.session };
}
export const logoutVmDownloads = (signal?: AbortSignal) => write("/logout", {}, "POST", signal);
export const enqueueVmDownloads = (input: Omit<VmDownloadSettings, "notificationsEnabled"> & { vmids: string[] }, signal?: AbortSignal) => write<{ jobs: VmDownloadJob[] }>("/jobs", input, "POST", signal);
export const removeVmDownloads = (jobIds: string[], signal?: AbortSignal) => write<{ removedCount: number }>("/jobs/cleanup", { jobIds }, "POST", signal);
export const removeVmDownload = (id: string, signal?: AbortSignal) => write<{ removed: boolean }>(`/jobs/${encodeURIComponent(id)}/remove`, {}, "POST", signal);
export const resumeVmDownload = (id: string, signal?: AbortSignal) => write(`/jobs/${encodeURIComponent(id)}/resume`, {}, "POST", signal);
export const recoverVmDownload = (id: string, signal?: AbortSignal) => write(`/jobs/${encodeURIComponent(id)}/recover`, { confirmRepeatableResource: true }, "POST", signal);
export const extendVmDownload = (id: string, signal?: AbortSignal) => write(`/jobs/${encodeURIComponent(id)}/extend`, {}, "POST", signal);
