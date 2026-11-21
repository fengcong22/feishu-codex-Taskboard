/**
 * Per-subject options for the document_edit_zip package (auto-cut-autoedit).
 *
 * A subject stores them as `packageOptions` (camelCase); the run's source manifest carries the
 * same values as `package_options` (snake_case). Only document_edit_zip runs use them; Lite's
 * manifest must never carry the field.
 */
export const EDIT_PACKAGE_TEMPLATE_ID = "document_edit_zip";
export const PACKAGE_OPTION_PRESETS = Object.freeze(["politics-fine", "civics-medium", "english-dub", "general-medium"]);
const SWITCHES = Object.freeze(["selfEdit", "defaultSfx", "bgm"]);
const KEYS = Object.freeze([...SWITCHES, "preset"]);
const MANIFEST_KEYS = Object.freeze({ selfEdit: "self_edit", defaultSfx: "default_sfx", bgm: "bgm", preset: "preset" });

export class PackageOptionsError extends Error {
  constructor(code, message, path = "packageOptions") {
    super(message);
    this.name = "PackageOptionsError";
    this.code = code;
    this.path = path;
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function isEditPackageTemplate(template) {
  return template?.id === EDIT_PACKAGE_TEMPLATE_ID && (template.version ?? 1) === 1;
}

/**
 * Canonical `packageOptions`: all four keys, each a value or null while drafting.
 * `requireComplete` (an enabled subject) demands an explicit true/false per switch and a preset.
 */
export function normalizePackageOptions(value, { requireComplete = false } = {}) {
  if (!plainObject(value)) throw new PackageOptionsError("INVALID_FIELD", "packageOptions must be an object");
  const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
  if (unknown) throw new PackageOptionsError("UNKNOWN_FIELD", `packageOptions.${unknown} is not supported`, `packageOptions.${unknown}`);
  const result = {};
  for (const key of SWITCHES) {
    const entry = value[key] ?? null;
    if (entry !== null && typeof entry !== "boolean") {
      throw new PackageOptionsError("INVALID_FIELD", `packageOptions.${key} must be true or false`, `packageOptions.${key}`);
    }
    result[key] = entry;
  }
  const preset = value.preset ?? null;
  if (preset !== null && !PACKAGE_OPTION_PRESETS.includes(preset)) {
    throw new PackageOptionsError("INVALID_FIELD", "packageOptions.preset is not supported", "packageOptions.preset");
  }
  result.preset = preset;
  if (requireComplete) {
    const missing = KEYS.find((key) => result[key] === null);
    if (missing) {
      throw new PackageOptionsError("PACKAGE_OPTIONS_REQUIRED", `packageOptions.${missing} is required before enabling`, `packageOptions.${missing}`);
    }
  }
  return result;
}

/** The manifest's `package_options` from a subject snapshot's complete `packageOptions`. */
export function manifestPackageOptions(packageOptions) {
  const options = normalizePackageOptions(packageOptions, { requireComplete: true });
  return Object.fromEntries(KEYS.map((key) => [MANIFEST_KEYS[key], options[key]]));
}

/** Validate a manifest's `package_options`: exactly the four keys, all set. */
export function normalizeManifestPackageOptions(value) {
  if (!plainObject(value)) throw new PackageOptionsError("INVALID_FIELD", "package_options must be an object", "package_options");
  const allowed = Object.values(MANIFEST_KEYS);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new PackageOptionsError("UNKNOWN_FIELD", `package_options.${unknown} is unsupported`, `package_options.${unknown}`);
  const result = {};
  for (const key of SWITCHES) {
    const name = MANIFEST_KEYS[key];
    if (typeof value[name] !== "boolean") {
      throw new PackageOptionsError("INVALID_FIELD", `package_options.${name} must be true or false`, `package_options.${name}`);
    }
    result[name] = value[name];
  }
  if (!PACKAGE_OPTION_PRESETS.includes(value.preset)) {
    throw new PackageOptionsError("INVALID_FIELD", "package_options.preset is invalid", "package_options.preset");
  }
  result.preset = value.preset;
  return result;
}
