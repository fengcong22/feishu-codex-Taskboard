import { ApiError } from "./database.mjs";
import { normalizePackageWorkflowTemplate } from "../shared/feishu-package-workflow.mjs";
import { PACKAGE_WORKFLOW_STAGES } from "../shared/package-workflow-stages.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const VIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const DISPLAY_FIELDS = ["zhName", "enName", "zhDescription", "enDescription"];
const STATE_FIELDS = ["views", "activeViewId", "defaultViewId", "stageDisplays"];
const PATCH_FIELDS = ["subjectKey", "packageAlias", "revision", ...STATE_FIELDS];

function invalid(message = "Package board settings are invalid") {
  throw new ApiError(400, "INVALID_FIELD", message);
}

function shape(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw new ApiError(400, "UNKNOWN_FIELD", "Unsupported package board settings field");
  }
  if (keys.some(key => !Object.hasOwn(value, key))) invalid("Package board settings are incomplete");
}

function normalizeScope(value) {
  shape(value, ["subjectKey", "packageAlias"]);
  const { subjectKey, packageAlias } = value;
  if (typeof subjectKey !== "string" || subjectKey.length > 513
    || subjectKey.split(":").length !== 2 || !subjectKey.split(":").every(part => ID_PATTERN.test(part))) {
    invalid("subjectKey must be baseToken:tableId");
  }
  if (typeof packageAlias !== "string" || packageAlias.length < 1 || packageAlias.length > 256
    || /^[.]/u.test(packageAlias) || /[\s/\\\u0000-\u001f\u007f-\u009f\p{Cf}"'`:$<>|]/u.test(packageAlias)
    || ["__proto__", "prototype", "constructor"].includes(packageAlias)) invalid("packageAlias is invalid");
  return { subjectKey, packageAlias };
}

function text(value, maxLength, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f\p{Cf}<>]/u.test(value)) invalid("Display text must be plain text");
  const normalized = value.trim();
  if ([...normalized].length > maxLength || (!nullable && !normalized)) invalid("Display text has an invalid length");
  return nullable && !normalized ? null : normalized;
}

function systemView(stageIds) {
  return { id: "all", name: "全部流程", stageIds: [...stageIds], isSystem: true };
}

function defaults(stageIds) {
  return {
    views: [systemView(stageIds)], activeViewId: "all", defaultViewId: "all",
    stageDisplays: stageIds.map(stageId => ({ stageId, ...Object.fromEntries(DISPLAY_FIELDS.map(field => [field, null])) })),
  };
}

function normalizeState(value, stageIds) {
  shape(value, STATE_FIELDS);
  if (!Array.isArray(value.views) || value.views.length < 1 || value.views.length > 50) invalid("A package board requires between 1 and 50 views");
  const ids = new Set();
  const names = new Set();
  const views = value.views.map((view, index) => {
    shape(view, ["id", "name", "stageIds", "isSystem"]);
    if (typeof view.id !== "string" || !VIEW_ID_PATTERN.test(view.id) || ids.has(view.id)) invalid("View identities must be unique");
    const name = text(view.name, 64);
    if (names.has(name.toLocaleLowerCase())) invalid("View names must be unique");
    ids.add(view.id);
    names.add(name.toLocaleLowerCase());
    if (!Array.isArray(view.stageIds) || view.stageIds.length < 1 || view.stageIds.length > stageIds.length
      || new Set(view.stageIds).size !== view.stageIds.length || view.stageIds.some(stage => !stageIds.includes(stage))) {
      invalid("View stages must belong to this package workflow");
    }
    if (index === 0) {
      if (view.id !== "all" || name !== "全部流程" || view.isSystem !== true
        || JSON.stringify(view.stageIds) !== JSON.stringify(stageIds)) invalid("The all-stages system view is fixed");
      return systemView(stageIds);
    }
    if (view.id === "all" || view.isSystem !== false) invalid("Custom views cannot replace the system view");
    return { id: view.id, name, stageIds: stageIds.filter(stage => view.stageIds.includes(stage)), isSystem: false };
  });
  if (!ids.has(value.activeViewId) || !ids.has(value.defaultViewId)) invalid("Active and default views must exist in this package board");
  if (!Array.isArray(value.stageDisplays) || value.stageDisplays.length !== stageIds.length) invalid("Every package workflow stage requires display settings");
  const displays = new Map();
  for (const display of value.stageDisplays) {
    shape(display, ["stageId", ...DISPLAY_FIELDS]);
    if (!stageIds.includes(display.stageId) || displays.has(display.stageId)) invalid("Stage displays must belong to this package workflow");
    displays.set(display.stageId, {
      stageId: display.stageId,
      ...Object.fromEntries(DISPLAY_FIELDS.map(field => [field, text(display[field], field.endsWith("Name") ? 80 : 500, { nullable: true })])),
    });
  }
  return { views, activeViewId: value.activeViewId, defaultViewId: value.defaultViewId, stageDisplays: stageIds.map(stage => displays.get(stage)) };
}

function queryScope(query) {
  for (const key of query.keys()) {
    if (!["subjectKey", "packageAlias"].includes(key)) throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Unsupported package board query parameter");
  }
  if (["subjectKey", "packageAlias"].some(key => query.getAll(key).length !== 1)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Package boards require one subjectKey and one packageAlias");
  }
  return normalizeScope({ subjectKey: query.get("subjectKey"), packageAlias: query.get("packageAlias") });
}

export function createPackageBoardSettings({ database, packageStore, getPackageBoard = null }) {
  if (!database?.database || !packageStore) throw new TypeError("database and packageStore are required");
  const db = database.database;
  db.exec(`CREATE TABLE IF NOT EXISTS feishu_package_board_settings (
    subject_key TEXT NOT NULL REFERENCES feishu_subjects(subject_key) ON DELETE CASCADE,
    package_alias TEXT NOT NULL,
    template_id TEXT NOT NULL,
    template_version INTEGER NOT NULL CHECK (template_version > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    settings_json TEXT NOT NULL,
    PRIMARY KEY (subject_key, package_alias, template_id, template_version)
  )`);
  const select = db.prepare(`SELECT revision, settings_json FROM feishu_package_board_settings
    WHERE subject_key = ? AND package_alias = ? AND template_id = ? AND template_version = ?`);

  function assertSubject(subjectKey) {
    if (!db.prepare("SELECT 1 FROM feishu_subjects WHERE subject_key = ? AND removed_at IS NULL").get(subjectKey)) {
      throw new ApiError(404, "SUBJECT_NOT_FOUND", "Subject does not exist");
    }
  }

  function historicalTemplate(scope) {
    const templates = new Map();
    const invalidHistory = () => new ApiError(409, "PACKAGE_BOARD_HISTORY_INVALID", "Saved package board identity is invalid");
    function add(value) {
      let template;
      try { template = normalizePackageWorkflowTemplate(value); } catch { throw invalidHistory(); }
      templates.set(`${template.id}:${template.version}`, template);
      return template;
    }
    // These keys were derived from a registered package when its preferences
    // were first saved. They retain presentation identity after task deletion.
    for (const row of db.prepare(`SELECT template_id, template_version FROM feishu_package_board_settings
      WHERE subject_key = ? AND package_alias = ?`).all(scope.subjectKey, scope.packageAlias)) {
      add({ id: row.template_id, version: row.template_version });
    }
    const [baseToken, tableId] = scope.subjectKey.split(":");
    const tasks = db.prepare(`SELECT snapshots.task_id FROM feishu_task_package_snapshots AS snapshots
      JOIN feishu_task_origins AS origins ON origins.task_id = snapshots.task_id
      WHERE snapshots.package_alias = ? AND (origins.subject_key = ?
        OR (origins.subject_key IS NULL AND origins.base_token = ? AND origins.table_id = ?))`)
      .all(scope.packageAlias, scope.subjectKey, baseToken, tableId);
    for (const { task_id: taskId } of tasks) {
      let origin;
      let snapshot;
      try {
        origin = database.getFeishuTaskOrigin(taskId);
        snapshot = database.getFeishuTaskPackageSnapshot(taskId);
      } catch { throw invalidHistory(); }
      // Simulation and ordinary task descriptions cannot establish a production
      // package identity. Only the dedicated persisted origin/snapshot pair can.
      if (origin?.deliverySource === "simulation") continue;
      if (origin?.source !== "feishu-base" || origin.deliverySource !== undefined
        || (origin.subjectKey ?? `${origin.baseToken}:${origin.tableId}`) !== scope.subjectKey
        || `${origin.baseToken}:${origin.tableId}` !== scope.subjectKey
        || origin.packageAlias !== scope.packageAlias || snapshot?.packageAlias !== scope.packageAlias) {
        throw invalidHistory();
      }
      const saved = add(snapshot.workflowTemplate);
      let frozen;
      try { frozen = normalizePackageWorkflowTemplate(origin.stageSnapshot?.workflowTemplate); } catch { throw invalidHistory(); }
      if (saved.id !== frozen.id || saved.version !== frozen.version) throw invalidHistory();
    }
    if (templates.size > 1) {
      throw new ApiError(409, "PACKAGE_BOARD_TEMPLATE_AMBIGUOUS", "Saved package board templates disagree");
    }
    if (templates.size === 0) throw new ApiError(404, "PACKAGE_NOT_FOUND", "Package does not exist");
    return templates.values().next().value;
  }

  async function resolveScope(input) {
    const scope = normalizeScope(input);
    assertSubject(scope.subjectKey);
    const catalog = typeof packageStore.get === "function" ? null : await packageStore.read();
    const record = typeof packageStore.get === "function"
      ? await packageStore.get(scope.packageAlias)
      : catalog && Object.hasOwn(catalog, scope.packageAlias) ? catalog[scope.packageAlias] : null;
    const workflowTemplate = record
      ? normalizePackageWorkflowTemplate(record.workflowTemplate) : historicalTemplate(scope);
    return { ...scope, workflowTemplate, stageIds: PACKAGE_WORKFLOW_STAGES[workflowTemplate.id], key: [scope.subjectKey, scope.packageAlias, workflowTemplate.id, workflowTemplate.version] };
  }

  function response(scope, row) {
    let state;
    try {
      if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error("Invalid revision");
      state = normalizeState(JSON.parse(row.settings_json), scope.stageIds);
    } catch {
      throw new ApiError(500, "PACKAGE_BOARD_SETTINGS_INVALID", "Saved package board settings are invalid");
    }
    return { subjectKey: scope.subjectKey, packageAlias: scope.packageAlias, workflowTemplate: scope.workflowTemplate, revision: row.revision, ...state };
  }

  function ensure(scope) {
    assertSubject(scope.subjectKey);
    db.prepare(`INSERT INTO feishu_package_board_settings
      (subject_key, package_alias, template_id, template_version, revision, settings_json)
      VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING`).run(...scope.key, JSON.stringify(defaults(scope.stageIds)));
    return select.get(...scope.key);
  }

  async function getSettings(input) {
    const scope = await resolveScope(input);
    return response(scope, ensure(scope));
  }

  async function saveSettings(body) {
    shape(body, PATCH_FIELDS);
    if (!Number.isSafeInteger(body.revision) || body.revision < 1) invalid("revision must be a positive integer");
    const scope = await resolveScope({ subjectKey: body.subjectKey, packageAlias: body.packageAlias });
    const state = normalizeState(Object.fromEntries(STATE_FIELDS.map(key => [key, body[key]])), scope.stageIds);
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = response(scope, ensure(scope));
      if (body.revision !== current.revision) {
        throw new ApiError(409, "VERSION_CONFLICT", "Package board settings changed; reload before saving", { expectedRevision: body.revision, actualRevision: current.revision });
      }
      db.prepare(`UPDATE feishu_package_board_settings SET revision = revision + 1, settings_json = ?
        WHERE subject_key = ? AND package_alias = ? AND template_id = ? AND template_version = ? AND revision = ?`)
        .run(JSON.stringify(state), ...scope.key, current.revision);
      const saved = response(scope, select.get(...scope.key));
      db.exec("COMMIT");
      return saved;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    getSettings,
    saveSettings,
    async handle({ method, pathname, query = new URLSearchParams(), body = null }) {
      if (pathname !== "/api/local/feishu/package-board") return null;
      if (method !== "GET" && method !== "PATCH") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      if (method === "PATCH") {
        if ([...query.keys()].length) throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "PATCH package board settings does not accept query parameters");
        return { status: 200, body: { settings: await saveSettings(body) } };
      }
      const scope = queryScope(query);
      const settings = await getSettings(scope);
      const status = settings.workflowTemplate.id === "vm_pmo_review_video" && getPackageBoard
        ? await getPackageBoard(scope) : { ...scope, tasks: [] };
      return { status: 200, body: { status, settings } };
    },
  };
}
