import { useCallback, useEffect, useId, useState } from "react";
import {
  activateAiProvider, ApiError, createAiProvider, deleteAiProvider, getAiProviders,
  importCurrentAiProvider, testAiProvider, updateAiProvider,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { AiProviderInput, AiProviderProfile, AiProviderSettings as Settings, AiProviderTestResult } from "../types";

const EMPTY: AiProviderInput = { name: "", baseUrl: "", wireApi: "responses", apiKey: "", model: "", vmModel: null };

function testMessage(result: AiProviderTestResult, text: (zh: string, en: string) => string) {
  if (result.ok) return text(`连接成功，可选模型 ${result.models.length} 个。`, `Connected; ${result.models.length} models available.`);
  const reason: Record<string, string> = {
    AI_PROVIDER_KEY_REJECTED: text("key 不正确或已失效。", "The key was rejected."),
    AI_PROVIDER_FORBIDDEN: text("服务商拒绝了请求（常见原因：余额不足或没有权限）。", "The provider refused the request (often no balance or no access)."),
    AI_PROVIDER_TIMEOUT: text("连接超时。", "The connection timed out."),
    AI_PROVIDER_UNREACHABLE: text("连不上这个地址，请检查网址。", "The address could not be reached."),
    AI_PROVIDER_MODELS_UNAVAILABLE: text("地址能连上，但没取到模型列表；如果确认 key 和模型名正确，仍可保存。",
      "Reached the address but got no model list; you can still save if the key and model are right."),
  };
  return `${reason[result.errorCode] ?? result.errorCode}${result.detail ? ` ${result.detail}` : ""}`;
}

export function AiProviderSettings() {
  const { text } = useTaskboardI18n();
  const listId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; value: AiProviderInput; keyHint?: string } | null>(null);
  const [test, setTest] = useState<AiProviderTestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSettings(await getAiProviders()); setError(null); }
    catch (failure) { setError(`${text("无法读取 AI 接口设置。", "Could not read AI provider settings.")} ${failure instanceof Error ? failure.message : ""}`); }
  }, [text]);
  useEffect(() => { void load(); }, [load]);

  async function act(work: () => Promise<Settings>, done: string) {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { setSettings(await work()); setNotice(done); return true; }
    catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) await load();
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally { setBusy(false); }
  }

  async function runTest() {
    if (!editing || busy) return;
    setBusy(true); setTest(null); setError(null);
    try { setTest(await testAiProvider({ ...(editing.id ? { id: editing.id } : {}), baseUrl: editing.value.baseUrl, apiKey: editing.value.apiKey })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!editing || !settings) return;
    const input = { ...editing.value, vmModel: editing.value.vmModel?.trim() ? editing.value.vmModel.trim() : null,
      expectedVersion: settings.version };
    const ok = await act(() => editing.id ? updateAiProvider(editing.id, input) : createAiProvider(input),
      text("已保存。", "Saved."));
    if (ok) { setEditing(null); setTest(null); }
  }

  function edit(profile: AiProviderProfile | null) {
    setTest(null); setNotice(null);
    setEditing(profile
      ? { id: profile.id, keyHint: profile.keyHint, value: { name: profile.name, baseUrl: profile.baseUrl, wireApi: profile.wireApi,
        apiKey: "", model: profile.model, vmModel: profile.vmModel } }
      : { id: null, value: { ...EMPTY } });
  }

  const set = (patch: Partial<AiProviderInput>) => setEditing((current) => current && { ...current, value: { ...current.value, ...patch } });
  const models = test?.ok ? test.models : [];

  return (
    <section className="ai-provider-settings" aria-labelledby={`${listId}-title`}>
      <h3 id={`${listId}-title`}>{text("AI 接口", "AI provider")}</h3>
      {settings && <p className="ai-provider-current">
        {text("Codex 当前使用：", "Codex currently uses: ")}
        <strong>{settings.codex.name ?? text("未配置", "not configured")}</strong>
        {settings.codex.model && <> · <code>{settings.codex.model}</code></>}
      </p>}
      {settings && !settings.available && <p className="project-dialog-error">{text("此电脑无法加密保存 API key，不能使用这里的设置。", "This computer cannot encrypt API keys, so these settings are unavailable.")}</p>}

      {settings && settings.profiles.length > 0 && <ul className="ai-provider-list">
        {settings.profiles.map((profile) => {
          const active = profile.id === settings.activeId;
          return <li key={profile.id} className={active ? "is-active" : undefined}>
            <div className="ai-provider-row-main">
              <strong>{profile.name}</strong>
              {active && <span className="ai-provider-badge">{text("正在使用", "In use")}</span>}
              <span className="ai-provider-meta">{profile.baseUrl}</span>
              <span className="ai-provider-meta">
                {text("模型", "Model")} <code>{profile.model}</code>
                {" · "}{text("AI 剪辑", "AI editing")} <code>{profile.vmModel ?? profile.model}</code>
                {" · key "}<code>{profile.keyHint}</code>
              </span>
            </div>
            <div className="ai-provider-row-actions">
              {!active && <button type="button" className="button secondary" disabled={busy || !settings.available}
                onClick={() => void act(() => activateAiProvider(profile.id, settings.version),
                  text(`已切换到「${profile.name}」，新开的 Codex 任务会用它。`, `Switched to ${profile.name}; new Codex tasks will use it.`))}>
                {text("设为当前", "Use this")}
              </button>}
              <button type="button" className="button secondary" disabled={busy} onClick={() => edit(profile)}>{text("编辑", "Edit")}</button>
              {!active && <button type="button" className="button secondary" disabled={busy}
                onClick={() => { if (window.confirm(text(`删除「${profile.name}」？保存的 key 也会删除。`, `Delete ${profile.name} and its saved key?`)))
                  void act(() => deleteAiProvider(profile.id, settings.version), text("已删除。", "Deleted.")); }}>
                {text("删除", "Delete")}
              </button>}
            </div>
          </li>;
        })}
      </ul>}

      {settings && !editing && <div className="ai-provider-actions">
        <button type="button" className="button secondary" disabled={busy || !settings.available} onClick={() => edit(null)}>{text("新增接口", "Add provider")}</button>
        {settings.codex.baseUrl && !settings.codex.managedByTaskboard && <button type="button" className="button secondary"
          disabled={busy || !settings.available}
          onClick={() => void act(() => importCurrentAiProvider(settings.version), text("已把 Codex 当前配置保存为一套接口。", "Saved Codex's current provider."))}>
          {text("导入当前 Codex 配置", "Import current Codex provider")}
        </button>}
      </div>}

      {editing && <div className="ai-provider-form">
        <label>{text("名称", "Name")}<input value={editing.value.name} maxLength={60} placeholder={text("例如：主用接口", "e.g. Main")}
          onChange={(event) => set({ name: event.target.value })} /></label>
        <label>{text("接口地址", "Base URL")}<input value={editing.value.baseUrl} placeholder="https://api.example.com/v1"
          onChange={(event) => { set({ baseUrl: event.target.value }); setTest(null); }} /></label>
        <label>{text("接口类型", "API type")}<select value={editing.value.wireApi}
          onChange={(event) => set({ wireApi: event.target.value as AiProviderInput["wireApi"] })}>
          <option value="responses">Responses（{text("推荐", "recommended")}）</option>
          <option value="chat">Chat Completions</option>
        </select></label>
        <label>API key<input type="password" autoComplete="off" value={editing.value.apiKey}
          placeholder={editing.id ? text(`留空则保留原 key（${editing.keyHint ?? ""}）`, `Leave blank to keep ${editing.keyHint ?? "the saved key"}`) : "sk-…"}
          onChange={(event) => { set({ apiKey: event.target.value }); setTest(null); }} /></label>
        <div className="ai-provider-test">
          <button type="button" className="button secondary" disabled={busy || !editing.value.baseUrl || (!editing.value.apiKey && !editing.id)}
            onClick={() => void runTest()}>{text("测试连接并获取模型", "Test and list models")}</button>
          {test && <span role="status" className={test.ok ? "ai-provider-test-ok" : "project-dialog-error"}>{testMessage(test, text)}</span>}
        </div>
        <datalist id={`${listId}-models`}>{models.map((model) => <option key={model} value={model} />)}</datalist>
        <label>{text("日常模型（手动任务和 Codex 默认）", "Daily model (manual tasks and Codex default)")}
          <input list={`${listId}-models`} value={editing.value.model} onChange={(event) => set({ model: event.target.value })} /></label>
        <label>{text("AI 剪辑模型（VM 剪辑规划）", "AI editing model (VM planning)")}
          <input list={`${listId}-models`} value={editing.value.vmModel ?? ""} placeholder={text("留空则与日常模型相同", "Blank uses the daily model")}
            onChange={(event) => set({ vmModel: event.target.value })} /></label>
        <div className="ai-provider-actions">
          <button type="button" className="button" disabled={busy || !editing.value.name.trim() || !editing.value.baseUrl.trim()
            || !editing.value.model.trim() || (!editing.id && !editing.value.apiKey.trim())} onClick={() => void save()}>{text("保存", "Save")}</button>
          <button type="button" className="button secondary" disabled={busy} onClick={() => { setEditing(null); setTest(null); }}>{text("取消", "Cancel")}</button>
        </div>
      </div>}

      {notice && <p role="status" className="local-settings-status">{notice}</p>}
      {error && <p role="alert" className="project-dialog-error">{error}</p>}
    </section>
  );
}
