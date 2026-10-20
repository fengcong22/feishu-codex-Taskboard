import { useState } from "react";
import { useTaskboardI18n } from "../i18n";
import type { PackageBoardSettings, PackageBoardStage } from "../types";

type Column = { id: PackageBoardStage; zh: string; en: string };
export function PackageWorkflowControls({
  settings,
  columns,
  onSave,
}: {
  settings: PackageBoardSettings;
  columns: Column[];
  onSave: (settings: PackageBoardSettings) => Promise<void>;
}) {
  const { text } = useTaskboardI18n();
  const [draft, setDraft] = useState<PackageBoardSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(value: PackageBoardSettings, close = false) {
    setBusy(true);
    setError(null);
    try {
      await onSave(value);
      if (close) setDraft(null);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : text("保存失败，请重新加载后重试", "Save failed; reload and retry"),
      );
    } finally {
      setBusy(false);
    }
  }
  const active = draft?.views.find((view) => view.id === draft.activeViewId);
  return (
    <>
      <label className="package-workflow-view-selector">
        {text("流程视图", "Workflow view")}
        <select
          aria-label={text("流程视图", "Workflow view")}
          value={settings.activeViewId}
          disabled={busy}
          onChange={(event) =>
            void save({ ...settings, activeViewId: event.target.value })
          }
        >
          {settings.views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.isSystem ? text("全部流程", "All stages") : view.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          setDraft(structuredClone(settings));
          setError(null);
        }}
      >
        {text("配置流程视图", "Configure workflow views")}
      </button>
      {error && !draft && <span role="alert">{error}</span>}
      {draft && (
        <div
          role="dialog"
          aria-label={text("配置流程视图", "Configure workflow views")}
          className="package-workflow-settings"
        >
          <div className="package-workflow-settings-heading">
            <strong>{text("本包流程视图", "Views for this package")}</strong>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {text("关闭", "Close")}
            </button>
          </div>
          <label>
            {text("编辑视图", "Edit view")}
            <select
              value={draft.activeViewId}
              onChange={(event) =>
                setDraft({ ...draft, activeViewId: event.target.value })
              }
            >
              {draft.views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              const id = `view-${crypto.randomUUID()}`;
              let ordinal = 1;
              while (
                draft.views.some(
                  (view) => view.name === `自定义视图 ${ordinal}`,
                )
              )
                ordinal++;
              setDraft({
                ...draft,
                activeViewId: id,
                views: [
                  ...draft.views,
                  {
                    id,
                    name: `自定义视图 ${ordinal}`,
                    stageIds: [...columns.map((column) => column.id)],
                    isSystem: false,
                  },
                ],
              });
            }}
          >
            {text("新建视图", "New view")}
          </button>
          {active && !active.isSystem && (
            <>
              <label>
                {text("视图名称", "View name")}
                <input
                  value={active.name}
                  maxLength={64}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      views: draft.views.map((view) =>
                        view.id === active.id
                          ? { ...view, name: event.target.value }
                          : view,
                      ),
                    })
                  }
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    activeViewId: "all",
                    defaultViewId:
                      draft.defaultViewId === active.id
                        ? "all"
                        : draft.defaultViewId,
                    views: draft.views.filter((view) => view.id !== active.id),
                  })
                }
              >
                {text("删除此视图", "Delete view")}
              </button>
            </>
          )}
          <label>
            {text("默认视图", "Default view")}
            <select
              value={draft.defaultViewId}
              onChange={(event) =>
                setDraft({ ...draft, defaultViewId: event.target.value })
              }
            >
              {draft.views.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.name}
                </option>
              ))}
            </select>
          </label>
          <div className="package-workflow-stage-settings">
            {columns.map((column) => {
              const display = draft.stageDisplays.find(
                (item) => item.stageId === column.id,
              );
              return (
                <div key={column.id}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={active?.isSystem}
                      checked={active?.stageIds.includes(column.id) ?? false}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          views: draft.views.map((view) =>
                            view.id === active?.id
                              ? {
                                  ...view,
                                  stageIds: columns
                                    .filter((candidate) =>
                                      candidate.id === column.id
                                        ? event.target.checked
                                        : view.stageIds.includes(candidate.id),
                                    )
                                    .map((candidate) => candidate.id),
                                }
                              : view,
                          ),
                        })
                      }
                    />
                    {text(column.zh, column.en)}
                  </label>
                  <input
                    aria-label={`${text(column.zh, column.en)}${text("列名", " column name")}`}
                    placeholder={text(column.zh, column.en)}
                    value={display?.zhName ?? ""}
                    maxLength={64}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        stageDisplays: [
                          ...draft.stageDisplays.filter(
                            (item) => item.stageId !== column.id,
                          ),
                          {
                            stageId: column.id,
                            zhName: event.target.value.trim()
                              ? event.target.value
                              : null,
                            enName: display?.enName ?? null,
                            zhDescription: display?.zhDescription ?? null,
                            enDescription: display?.enDescription ?? null,
                          },
                        ],
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
          {error && <p role="alert">{error}</p>}
          <button
            type="button"
            disabled={busy || !active?.stageIds.length}
            onClick={() => void save(draft, true)}
          >
            {busy
              ? text("保存中…", "Saving…")
              : text("保存视图配置", "Save view settings")}
          </button>
        </div>
      )}
    </>
  );
}
