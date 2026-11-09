import assert from "node:assert/strict";
import {test} from "node:test";
import {validateVmPmoManualRevision} from "../server/vm-pmo-manual-revision.mjs";

const sourceSha256 = "a".repeat(64);
const revision = () => ({sourceSha256,note:"Complete the spoken sentence; hold the final frame.",clips:[
  {startMs:0,endMs:159340,freeze:{startMs:158820,endMs:159340,frameMs:158820}},
  {startMs:163360,endMs:285000},
]});

test("manual revision binds exact clips and freeze to one source", () => {
  assert.deepEqual(validateVmPmoManualRevision(revision(),{sourceSha256,durationMs:300800}),revision());
});

test("manual revision rejects changed source, unsupported fields, and invalid boundaries", () => {
  const wrongSource=revision();wrongSource.sourceSha256="b".repeat(64);
  assert.throws(()=>validateVmPmoManualRevision(wrongSource,{sourceSha256,durationMs:300800}),
    {code:"VM_PMO_REVISION_INVALID"});
  const extra=revision();extra.clips[0].sourcePath="C:\\private\\video.mp4";
  assert.throws(()=>validateVmPmoManualRevision(extra),{code:"VM_PMO_REVISION_INVALID"});
  const overlap=revision();overlap.clips[1].startMs=159000;
  assert.throws(()=>validateVmPmoManualRevision(overlap),{code:"VM_PMO_REVISION_INVALID"});
  const pastEnd=revision();pastEnd.clips[1].endMs=300801;
  assert.throws(()=>validateVmPmoManualRevision(pastEnd,{durationMs:300800}),
    {code:"VM_PMO_REVISION_INVALID"});
  const outsideFreeze=revision();outsideFreeze.clips[0].freeze.frameMs=300801;
  assert.throws(()=>validateVmPmoManualRevision(outsideFreeze,{durationMs:300800}),
    {code:"VM_PMO_REVISION_INVALID"});
});
