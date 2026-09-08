import { parseFeishuTaskMetadata } from "./task-payload.mjs";
import { safeDeliveryErrorCode } from "./retry-policy.mjs";

const FEISHU_PROVENANCE_FIELDS = [
  "version",
  "source",
  "eventId",
  "baseToken",
  "tableId",
  "recordId",
  "triggerField",
  "triggerFieldId",
  "triggerValue",
  "mode",
  "subjectKey",
  "configVersion",
  "executionMode",
  "uploadMode",
  "packageAlias",
  "packageSource",
  "concurrencyGroup",
  "maxConcurrent",
  "resourceGroups",
];

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

function validFeishuOrigin(value) {
  return objectPayload(value)
    && value.version === 1
    && value.source === "feishu-base"
    && nonEmptyString(value.eventId)
    && nonEmptyString(value.baseToken)
    && nonEmptyString(value.tableId)
    && nonEmptyString(value.recordId);
}

function validFeishuTask(value) {
  return validTaskSnapshot(value) && validFeishuOrigin(value.feishuOrigin);
}

function matchingFeishuProvenance(value, expected) {
  if (!validFeishuOrigin(value) || !objectPayload(expected)) return false;
  return FEISHU_PROVENANCE_FIELDS.every((field) => {
    const expectedHasField = Object.hasOwn(expected, field);
    if (Object.hasOwn(value, field) !== expectedHasField) return false;
    if (!expectedHasField) return true;
    if (Array.isArray(expected[field])) {
      return Array.isArray(value[field])
        && value[field].length === expected[field].length
        && expected[field].every((entry, index) => value[field][index] === entry);
    }
    return value[field] === expected[field];
  });
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
  constructor(baseUrl, {
    fetchImplementation = globalThis.fetch,
    timeoutMs = 5000,
    bridgeSecret = process.env.CODEX_FEISHU_BRIDGE_SECRET ?? null,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImplementation;
    this.timeoutMs = timeoutMs;
    this.bridgeSecret = typeof bridgeSecret === "string" ? bridgeSecret.trim() : null;
  }

  async #request(pathname, { method = "POST", body, headers = {} } = {}) {
    let response;
    try {
      const requestHeaders = { ...headers };
      if (requestHeaders["x-taskboard-client"] === "feishu-bridge" && this.bridgeSecret) {
        requestHeaders["x-feishu-bridge-secret"] = this.bridgeSecret;
      }
      const options = {
        method,
        headers: requestHeaders,
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

  async createFeishuTask(payload) {
    const metadata = parseFeishuTaskMetadata(payload?.description);
    if (!metadata || metadata.source !== "feishu-base") {
      throw new TaskboardError("Feishu task payload is missing valid workflow metadata", {
        code: "INVALID_FEISHU_ORIGIN",
        status: 400,
      });
    }
    const response = await this.#request("/api/local/feishu/tasks", {
      body: payload,
      headers: { "x-taskboard-client": "feishu-bridge" },
    });
    if (!validFeishuTask(response?.task)
      || !matchingFeishuProvenance(response.task.feishuOrigin, metadata)) {
      throw invalidResponse("/api/local/feishu/tasks");
    }
    return response.task;
  }

  async registerFeishuStageTask(payload, { bridgeSecret = this.bridgeSecret } = {}) {
    if (!objectPayload(payload)) throw invalidResponse("/api/local/feishu/tasks");
    const secret = typeof bridgeSecret === "string" ? bridgeSecret.trim() : "";
    if (!secret) {
      throw new TaskboardError("Feishu Bridge secret is not configured", {
        code: "FEISHU_BRIDGE_SECRET_NOT_CONFIGURED",
        status: 503,
      });
    }
    const pathname = "/api/local/feishu/tasks";
    const response = await this.#request(pathname, {
      body: payload,
      headers: {
        "x-taskboard-client": "feishu-bridge",
        "x-feishu-bridge-secret": secret,
      },
    });
    if (!validTask(response?.task)) throw invalidResponse(pathname);
    return response.task;
  }

  async listFeishuTasks(options = {}) {
    const query = new URLSearchParams();
    for (const field of [
      "eventId",
      "projectId",
      "baseToken",
      "tableId",
      "recordId",
      "triggerFieldId",
      "triggerField",
      "triggerValue",
      "status",
    ]) {
      if (nonEmptyString(options[field])) query.set(field, options[field].trim());
    }
    query.set("archived", options.archived === "all" ? "all" : "false");
    const pathname = `/api/local/feishu/tasks?${query.toString()}`;
    const payload = await this.#request(pathname, {
      method: "GET",
      headers: { "x-taskboard-client": "feishu-bridge" },
    });
    const tasks = Array.isArray(payload?.tasks)
      ? payload.tasks
      : Object.hasOwn(payload ?? {}, "task") ? (payload.task ? [payload.task] : []) : null;
    if (!tasks || tasks.some((task) => !validFeishuTask(task))) throw invalidResponse(pathname);
    return options.stageId === undefined
      ? tasks
      : tasks.filter((task) => task.feishuOrigin.stageId === options.stageId);
  }

  async listFeishuWaitingTasks(options = {}) {
    const { event, table } = options;
    const projectId = options.projectId ?? table?.projectId;
    const baseToken = options.baseToken ?? event?.baseToken;
    const tableId = options.tableId ?? event?.tableId;
    const recordId = options.recordId ?? event?.recordId;
    const triggerFieldId = options.triggerFieldId ?? table?.triggerFieldId;
    const triggerField = options.triggerField ?? table?.triggerField;
    const triggerValue = options.triggerValue ?? table?.triggerValue;
    if (![baseToken, tableId, recordId, triggerValue].every(nonEmptyString)
      || (!nonEmptyString(triggerFieldId) && !nonEmptyString(triggerField))) {
      throw invalidResponse("/api/local/feishu/tasks");
    }
    const query = new URLSearchParams({
      ...(projectId ? { projectId } : {}), baseToken, tableId, recordId,
      ...(triggerFieldId ? { triggerFieldId } : { triggerField }),
      triggerValue, status: "todo", archived: "false",
    });
    const pathname = `/api/local/feishu/tasks?${query.toString()}`;
    const payload = await this.#request(pathname, {
      method: "GET", headers: { "x-taskboard-client": "feishu-bridge" },
    });
    if (!objectPayload(payload) || !Array.isArray(payload.tasks)
      || payload.tasks.some((task) => !validFeishuTask(task))) throw invalidResponse(pathname);
    return payload.tasks;
  }

  async archiveFeishuTask(task) {
    if (!validArchiveInput(task)) {
      throw invalidResponse("/api/local/feishu/tasks/:id/archive");
    }
    const pathname = `/api/local/feishu/tasks/${encodeURIComponent(task.id)}/archive`;
    const payload = await this.#request(pathname, {
      body: { version: task.version },
      headers: { "x-taskboard-client": "feishu-bridge" },
    });
    if (!validFeishuTask(payload?.task) || payload.task.id !== task.id
      || payload.task.status !== "todo" || !nonEmptyString(payload.task.archivedAt)) {
      throw invalidResponse(pathname);
    }
    return payload.task;
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
    if (!nonEmptyString(eventId) || !nonEmptyString(projectId)) throw invalidResponse("/api/local/feishu/tasks");
    const pathname = `/api/local/feishu/tasks?${new URLSearchParams({ eventId, projectId, archived: "all" })}`;
    const payload = await this.#request(pathname, {
      method: "GET", headers: { "x-taskboard-client": "feishu-bridge" },
    });
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks
      : Object.hasOwn(payload ?? {}, "task") ? (payload.task === null ? [] : [payload.task]) : null;
    if (!tasks || tasks.some((candidate) => candidate !== null && !validFeishuTask(candidate))) throw invalidResponse(pathname);
    const task = tasks.find((candidate) => candidate.feishuOrigin.eventId === eventId);
    if (!task) return null;
    return task;
  }
}
