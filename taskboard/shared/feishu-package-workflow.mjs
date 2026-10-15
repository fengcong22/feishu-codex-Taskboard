const LEGACY = Object.freeze({ id: "document_draft_zip", version: 1 });
const VM = Object.freeze({ id: "vm_pmo_review_video", version: 1 });

export class PackageWorkflowError extends Error {
  constructor(code) {
    const messages = {
      PACKAGE_WORKFLOW_UNSUPPORTED: "Package workflow declaration is unsupported",
      PACKAGE_WORKFLOW_NOT_READY: "Package workflow is available for preview only",
      PACKAGE_WORKFLOW_MISMATCH: "Package workflow does not match its saved identity",
    };
    const safeCode = Object.hasOwn(messages, code) ? code : "PACKAGE_WORKFLOW_UNSUPPORTED";
    super(messages[safeCode]);
    this.name = "PackageWorkflowError";
    this.code = safeCode;
    this.status = 409;
  }
}

function unsupported() { throw new PackageWorkflowError("PACKAGE_WORKFLOW_UNSUPPORTED"); }
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** An absent declaration retains the current document/draft/ZIP workflow. */
export function normalizePackageWorkflowTemplate(value) {
  if (value === undefined) return { ...LEGACY };
  if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "id")
    || !Object.hasOwn(value, "version") || value.version !== 1
    || ![LEGACY.id, VM.id].includes(value.id)) unsupported();
  return { id: value.id, version: value.version };
}

export function assertPackageWorkflowExecutable(value) {
  const template = normalizePackageWorkflowTemplate(value);
  if (template.id === VM.id) throw new PackageWorkflowError("PACKAGE_WORKFLOW_NOT_READY");
  return template;
}

export function workflowTemplatesEqual(left, right) {
  const a = normalizePackageWorkflowTemplate(left);
  const b = normalizePackageWorkflowTemplate(right);
  return a.id === b.id && a.version === b.version;
}

/** Reject explicit partial/unknown workflow signals instead of falling back. */
export function packageWorkflowFromManifest(packageInterface) {
  if (packageInterface === undefined) return { ...LEGACY };
  if (!object(packageInterface)) unsupported();
  const template = normalizePackageWorkflowTemplate(packageInterface.workflowTemplate);
  const hasContract = Object.hasOwn(packageInterface, "contract");
  const hasDriver = Object.hasOwn(packageInterface, "driverId");
  const hasArtifact = Object.hasOwn(packageInterface, "artifactKind");
  if (template.id === LEGACY.id) {
    // No legacy contract/driver identifier has been established; do not invent one.
    if (hasContract || hasDriver || (hasArtifact && packageInterface.artifactKind !== "zip")) unsupported();
    return template;
  }
  if (hasContract && !workflowTemplatesEqual(packageInterface.contract, VM)) unsupported();
  if (hasDriver && packageInterface.driverId !== "vm_pmo_review_video_v1") unsupported();
  if (hasArtifact && packageInterface.artifactKind !== "review_mp4") unsupported();
  return template;
}
