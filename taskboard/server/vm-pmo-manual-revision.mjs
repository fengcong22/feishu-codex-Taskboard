const HASH = /^[a-f0-9]{64}$/u;

function fail() {
  const error = new Error("VM_PMO_REVISION_INVALID");
  error.code = "VM_PMO_REVISION_INVALID";
  throw error;
}

function object(value, keys, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && keys.every(key => Object.hasOwn(value,key))
    && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
}

export function validateVmPmoManualRevision(value,{sourceSha256,durationMs} = {}) {
  if (!object(value,["sourceSha256","note","clips"])
    || typeof value.sourceSha256 !== "string" || !HASH.test(value.sourceSha256)
    || sourceSha256 !== undefined && value.sourceSha256 !== sourceSha256
    || typeof value.note !== "string" || !value.note.trim() || value.note.length > 1024
    || value.note.includes("\0") || !Array.isArray(value.clips)
    || value.clips.length < 1 || value.clips.length > 8
    || durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 1)) fail();
  let previousEnd = 0;
  const clips = value.clips.map(row => {
    if (!object(row,["startMs","endMs"],["freeze"])
      || !Number.isSafeInteger(row.startMs) || !Number.isSafeInteger(row.endMs)
      || row.startMs < previousEnd || row.endMs <= row.startMs
      || durationMs !== undefined && row.endMs > durationMs) fail();
    previousEnd = row.endMs;
    const clip = {startMs:row.startMs,endMs:row.endMs};
    if (row.freeze !== undefined) {
      const freeze = row.freeze;
      if (!object(freeze,["startMs","endMs","frameMs"])
        || ![freeze.startMs,freeze.endMs,freeze.frameMs].every(Number.isSafeInteger)
        || freeze.startMs < row.startMs || freeze.endMs <= freeze.startMs
        || freeze.endMs > row.endMs || freeze.frameMs < 0
        || durationMs !== undefined && freeze.frameMs >= durationMs) fail();
      clip.freeze = {startMs:freeze.startMs,endMs:freeze.endMs,frameMs:freeze.frameMs};
    }
    return clip;
  });
  return {sourceSha256:value.sourceSha256,note:value.note,clips};
}

export function toVmPmoInputManualRevision(value,options = {}) {
  const revision = validateVmPmoManualRevision(value,options);
  return {source_sha256:revision.sourceSha256,note:revision.note,clips:revision.clips.map(row => ({
    start_ms:row.startMs,end_ms:row.endMs,
    ...(row.freeze ? {freeze:{start_ms:row.freeze.startMs,end_ms:row.freeze.endMs,
      frame_ms:row.freeze.frameMs}} : {}),
  }))};
}

export function validateVmPmoInputManualRevision(value,options = {}) {
  if (!object(value,["source_sha256","note","clips"]) || !Array.isArray(value.clips)) fail();
  const revision = {sourceSha256:value.source_sha256,note:value.note,clips:value.clips.map(row => {
    if (!object(row,["start_ms","end_ms"],["freeze"])) fail();
    let freeze;
    if (row.freeze !== undefined) {
      if (!object(row.freeze,["start_ms","end_ms","frame_ms"])) fail();
      freeze = {startMs:row.freeze.start_ms,endMs:row.freeze.end_ms,frameMs:row.freeze.frame_ms};
    }
    return {startMs:row.start_ms,endMs:row.end_ms,...(freeze ? {freeze} : {})};
  })};
  return toVmPmoInputManualRevision(revision,options);
}
