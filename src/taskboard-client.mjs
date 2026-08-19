import { parseFeishuTaskMetadata } from "./task-payload.mjs";

export class TaskboardError extends Error {
  constructor(message, { code = "TASKBOARD_REQUEST_FAILED", status = 0 } = {}) {
    super(message);
    this.name = "TaskboardError";
    this.code = code;
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
      return (await this.#request("/api/projects", { body: project })).project;
    } catch (error) {
      if (error instanceof TaskboardError && error.code === "PROJECT_EXISTS") return null;
      throw error;
    }
  }

  async createTask(payload) {
    return (await this.#request("/api/tasks", { body: payload })).task;
  }

  async listTasks({ projectId, archived = "all" } = {}) {
    const query = new URLSearchParams();
    if (projectId) query.set("projectId", projectId);
    query.set("archived", archived);
    const payload = await this.#request(`/api/tasks?${query.toString()}`, { method: "GET" });
    return Array.isArray(payload.tasks) ? payload.tasks : [];
  }

  async findTaskByEventId(eventId, projectId) {
    const tasks = await this.listTasks({ projectId, archived: "all" });
    return tasks.find((task) => parseFeishuTaskMetadata(task?.description)?.eventId === eventId) ?? null;
  }
}
