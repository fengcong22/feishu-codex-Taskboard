import { parseFeishuTaskMetadata } from "./task-payload.mjs";
import { safeDeliveryErrorCode } from "./retry-policy.mjs";

function invalidResponse(pathname) {
  return new TaskboardError(`Taskboard returned an invalid response for ${pathname}`, {
    code: "TASKBOARD_INVALID_RESPONSE",
    status: 502,
  });
}

function objectPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function validTask(value) {
  return objectPayload(value)
    && nonEmptyString(value.id)
    && nonEmptyString(value.identifier);
}

function validTaskSnapshot(value) {
  return validTask(value)
    && validVersion(value.version)
    && nonEmptyString(value.status)
    && Object.hasOwn(value, "archivedAt")
    && (value.archivedAt === null || nonEmptyString(value.archivedAt));
}

function validArchiveInput(value) {
  return validTask(value) && validVersion(value.version);
}

export class TaskboardError extends Error {
  constructor(message, { code = "TASKBOARD_REQUEST_FAILED", status = 0 } = {}) {
    super(message);
    this.name = "TaskboardError";
    this.code = safeDeliveryErrorCode(code, "TASKBOARD_REQUEST_FAILED");
    this.status = status;
  }
}

export class TaskboardClient {
  constructor(baseUrl, { fetchImplementation = globalThis.fetch, timeoutMs = 5000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImplementation;
    this.timeoutMs = timeoutMs;
  }

  async #request(pathname, { method = "POST", body } = {}) {
    let response;
    try {
      const options = {
        method,
        headers: {},
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      if (body !== undefined) {
        options.headers["content-type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      response = await this.fetch(`${this.baseUrl}${pathname}`, {
        ...options,
      });
    } catch (error) {
      throw new TaskboardError(`Cannot reach Taskboard: ${error.message}`, {
        code: "TASKBOARD_UNAVAILABLE",
      });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    if (!response.ok) {
      throw new TaskboardError(
        payload?.error?.message ?? `Taskboard returned HTTP ${response.status}`,
        { code: payload?.error?.code, status: response.status },
      );
    }
    return payload;
  }

  async ensureProject(project) {
    try {
      const payload = await this.#request("/api/projects", { body: project });
      if (
        !objectPayload(payload?.project)
        || !nonEmptyString(payload.project.id)
        || payload.project.id !== project.id
      ) {
        throw invalidResponse("/api/projects");
      }
      return payload.project;
    } catch (error) {
      if (
        error instanceof TaskboardError
        && error.status === 409
        && error.code === "PROJECT_EXISTS"
      ) return null;
      throw error;
    }
  }

  async createTask(payload) {
    const response = await this.#request("/api/tasks", { body: payload });
    if (!validTask(response?.task)) throw invalidResponse("/api/tasks");
    return response.task;
  }

  async listTasks({ projectId, archived = "all" } = {}) {
    const query = new URLSearchParams();
    if (projectId) query.set("projectId", projectId);
    query.set("archived", archived);
    const pathname = `/api/tasks?${query.toString()}`;
    const payload = await this.#request(pathname, { method: "GET" });
    if (!objectPayload(payload) || !Array.isArray(payload.tasks)) throw invalidResponse(pathname);
    return payload.tasks;
  }

  async getTask(taskId) {
    if (!nonEmptyString(taskId)) throw invalidResponse("/api/tasks/:id");
    const pathname = `/api/tasks/${encodeURIComponent(taskId)}`;
    const payload = await this.#request(pathname, { method: "GET" });
    if (!validTaskSnapshot(payload?.task) || payload.task.id !== taskId) {
      throw invalidResponse(pathname);
    }
    return payload.task;
  }

  async archiveTask(task) {
    if (!validArchiveInput(task)) throw invalidResponse("/api/tasks/:id/archive");
    const pathname = `/api/tasks/${encodeURIComponent(task.id)}/archive`;
    const payload = await this.#request(pathname, { body: { version: task.version } });
    if (
      !validTaskSnapshot(payload?.task)
      || payload.task.id !== task.id
      || payload.task.status !== "todo"
      || !nonEmptyString(payload.task.archivedAt)
    ) {
      throw invalidResponse(pathname);
    }
    return payload.task;
  }

  async findTaskByEventId(eventId, projectId) {
    const tasks = await this.listTasks({ projectId, archived: "all" });
    const task = tasks.find((candidate) => (
      parseFeishuTaskMetadata(candidate?.description)?.eventId === eventId
    ));
    if (!task) return null;
    if (!validTask(task)) throw invalidResponse("/api/tasks");
    return task;
  }
}
