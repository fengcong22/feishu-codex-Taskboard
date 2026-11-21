import type { FeishuPackageOptions, FeishuPackagePreset } from "../types";

/** Switches handed to auto-cut-autoedit (document_edit_zip) through the source manifest. */
const SWITCHES: Array<{ key: "selfEdit" | "defaultSfx" | "bgm"; label: string; on: string; off: string }> = [
  {
    key: "selfEdit",
    label: "初稿自动剪辑",
    on: "按常规剪辑规则自行处理（停顿、气口、讲错、重复、打嗝），同时处理讲师意见",
    off: "只处理讲师意见",
  },
  {
    key: "defaultSfx",
    label: "音效需求",
    on: "按规则给画面事件自动加音效",
    off: "不自动加；讲师意见附了音效文件就照放，没附就写进反馈表",
  },
  {
    key: "bgm",
    label: "BGM",
    on: "需要加 BGM（目前在反馈表提示人工添加，并留一条空 BGM 轨）",
    off: "不加",
  },
];

export const PACKAGE_PRESETS: Array<{ id: FeishuPackagePreset; label: string }> = [
  { id: "politics-fine", label: "政治精剪" },
  { id: "civics-medium", label: "道法中剪" },
  { id: "english-dub", label: "英语配音" },
  { id: "general-medium", label: "通用" },
];

export const EMPTY_PACKAGE_OPTIONS: FeishuPackageOptions = { selfEdit: null, defaultSfx: null, bgm: null, preset: null };

/** The first missing option, phrased for the enable button; null when every option is set. */
export function packageOptionsIncompleteReason(options: FeishuPackageOptions | null): string | null {
  const value = options ?? EMPTY_PACKAGE_OPTIONS;
  const missing = SWITCHES.find((item) => value[item.key] === null);
  if (missing) return `请在剪辑包选项中选择「${missing.label}」开或关`;
  if (value.preset === null) return "请在剪辑包选项中选择剪辑预设";
  return null;
}

export function FeishuPackageOptionsEditor({ value, disabled, onChange }: {
  value: FeishuPackageOptions | null;
  disabled: boolean;
  onChange: (value: FeishuPackageOptions) => void;
}) {
  const options = value ?? EMPTY_PACKAGE_OPTIONS;
  return <fieldset className="feishu-config-card feishu-package-options" disabled={disabled}>
    <legend>剪辑包选项</legend>
    <p className="feishu-execution-help">这些选项随每次运行交给剪辑包；启用学科前四项都需要选择。</p>
    {SWITCHES.map((item) => <div className="feishu-package-option" key={item.key} role="radiogroup" aria-label={item.label}>
      <span className="feishu-package-option-label">{item.label}</span>
      {([true, false] as const).map((enabled) => <label key={String(enabled)} className="feishu-package-option-choice">
        <input
          type="radio"
          name={`package-option-${item.key}`}
          aria-label={`${item.label}：${enabled ? "开" : "关"}`}
          checked={options[item.key] === enabled}
          onChange={() => onChange({ ...options, [item.key]: enabled })}
        />
        <span><strong>{enabled ? "开" : "关"}</strong>：{enabled ? item.on : item.off}</span>
      </label>)}
    </div>)}
    <label className="feishu-package-option">
      <span className="feishu-package-option-label">剪辑预设</span>
      <select aria-label="剪辑预设" value={options.preset ?? ""}
        onChange={(event) => onChange({ ...options, preset: (event.target.value || null) as FeishuPackagePreset | null })}>
        <option value="">请选择剪辑预设</option>
        {PACKAGE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
      </select>
    </label>
  </fieldset>;
}
