import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getAutomaticExecutionSettings, updateAutomaticExecutionSettings } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { AutomaticExecutionSettings } from "../types";

interface LocalSettingsDialogProps {
  revision: number;
  onSettingsChange: (settings: AutomaticExecutionSettings) => void;
  onClose: () => void;
}

export function LocalSettingsDialog({ revision, onSettingsChange, onClose }: LocalSettingsDialogProps) {
  const { text } = useTaskboardI18n();
  const [settings, setSettings] = useState<AutomaticExecutionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const requestRef = useRef(0);
  const savingRef = useRef(false);
  const refreshPendingRef = useRef(false);

  const applySettings = useCallback((next: AutomaticExecutionSettings) => {
    setSettings(next);
    onSettingsChange(next);
  }, [onSettingsChange]);

  const loadSettings = useCallback(async (keepError = false) => {
    if (savingRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    if (!keepError) setError(null);
    setSaved(false);
    try {
      const next = await getAutomaticExecutionSettings();
      if (requestRef.current === requestId) applySettings(next);
    } catch (failure) {
      if (requestRef.current === requestId) {
        setSettings(null);
        setError(`${text("无法读取设置。", "Could not read the setting.")} ${failure instanceof Error ? failure.message : ""}`.trim());
      }
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [applySettings, text]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings, revision]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      ++requestRef.current;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const handleFocus = () => void loadSettings();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [loadSettings]);

  async function saveSettings(enabled: boolean) {
    if (!settings || loading || savingRef.current) return;
    const requestId = ++requestRef.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await updateAutomaticExecutionSettings({ enabled, expectedVersion: settings.version });
      if (requestRef.current === requestId) {
        applySettings(next);
        setSaved(true);
      }
    } catch (failure) {
      if (requestRef.current !== requestId) return;
      if (failure instanceof ApiError && failure.status === 409) {
        try {
          const current = await getAutomaticExecutionSettings();
          if (requestRef.current !== requestId) return;
          applySettings(current);
          setError(text(
            "其他页面已修改此设置。已读取当前值，请确认后再操作。",
            "This setting changed elsewhere. The current value has been loaded; review it before trying again.",
          ));
        } catch {
          if (requestRef.current !== requestId) return;
          setSettings(null);
          setError(text("设置已发生变化，暂时无法读取当前值，请重试。", "The setting changed, but its current value could not be read. Try again."));
        }
      } else {
        setError(`${text("无法保存设置。", "Could not save the setting.")} ${failure instanceof Error ? failure.message : ""}`.trim());
      }
    } finally {
      savingRef.current = false;
      if (requestRef.current === requestId) {
        setSaving(false);
        if (refreshPendingRef.current) {
          refreshPendingRef.current = false;
          void loadSettings(true);
        }
      }
    }
  }

  return (
    <div className="delete-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section
        ref={dialogRef}
        className="delete-dialog local-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-settings-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!saving) onClose();
          }
          if (event.key === "Tab") {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id="local-settings-title">{text("本机设置", "Local settings")}</h2>
        <label className="local-settings-switch-row">
          <span>{text("允许本机自动剪辑", "Allow automatic editing on this device")}</span>
          <input
            className="local-settings-switch"
            type="checkbox"
            role="switch"
            checked={settings?.enabled ?? false}
            disabled={!settings || loading || saving}
            aria-describedby="local-settings-help"
            onChange={(event) => void saveSettings(event.target.checked)}
          />
        </label>
        <section id="local-settings-help" className="local-settings-help">
          <p>{text("适用于本机所有学科。设置立即生效，重启后保留。", "Applies to all subjects on this device. Changes take effect immediately and persist after restart.")}</p>
          <p>{text("关闭后，尚未开始的自动任务退回待处理；正在执行的任务继续完成。", "Turning this off returns unstarted automatic tasks to Ready. Running tasks will continue.")}</p>
          <p>{text("开启后仅允许新触发的合格任务自动剪辑，不会自动启动历史任务；学科仍需设为自动并启用。", "Turning this on allows eligible newly triggered tasks to start; it does not start historical tasks. Each subject must also be enabled in automatic mode.")}</p>
        </section>
        <p role="status" className="local-settings-status">
          {saving ? text("正在保存…", "Saving…")
            : loading ? text("正在读取…", "Loading…")
              : saved ? text("已保存", "Saved")
                : settings ? settings.enabled ? text("已开启", "On") : text("已关闭", "Off")
                  : text("状态未知", "Status unknown")}
        </p>
        {error && <p role="alert" className="project-dialog-error">{error}</p>}
        <div>
          {!settings && !loading && <button className="button secondary" type="button" onClick={() => void loadSettings()}>{text("重试", "Retry")}</button>}
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>{text("关闭", "Close")}</button>
        </div>
      </section>
    </div>
  );
}
