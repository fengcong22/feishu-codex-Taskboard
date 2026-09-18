import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const stylesSource = () => readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

function cssRule(styles, selector) {
  const selectorPattern = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${selectorPattern}\\s*\\{`).exec(styles);
  assert.ok(match, `missing ${selector} rule`);
  const start = match.index;
  const end = styles.indexOf("}", start);
  assert.notEqual(end, -1, `unterminated ${selector} rule`);
  return styles.slice(start, end + 1);
}

test("Feishu configuration tabs retain their height when the settings pane has long content", async () => {
  const styles = await stylesSource();
  const tabs = cssRule(styles, ".feishu-configuration-stack .feishu-settings-tabs");

  assert.match(tabs, /display:\s*flex;/);
  assert.match(tabs, /flex:\s*0\s+0\s+auto;/);
  assert.match(tabs, /min-block-size:\s*42px;/);
  assert.match(tabs, /overflow-x:\s*auto;/);
  assert.match(tabs, /overflow-y:\s*hidden;/);
});

test("Feishu field-refresh feedback reserves its own grid row before the tabs", async () => {
  const styles = await stylesSource();
  const feedbackLayout = cssRule(
    styles,
    ".feishu-configuration-stack .feishu-subject-settings:has(.feishu-field-refresh-feedback)",
  );

  assert.match(
    feedbackLayout,
    /grid-template-rows:\s*max-content\s+max-content\s+max-content\s+minmax\(0,\s*1fr\)\s+max-content;/,
  );
});

test("Feishu configuration moves the floating AI chat launcher above sticky actions", async () => {
  const styles = await stylesSource();
  const launcher = cssRule(styles, "body:has(.feishu-configuration-stack) .ai-chat-launcher");

  assert.match(launcher, /bottom:\s*80px;/);
});

test("Feishu configuration action bar stays one row so the AI launcher clearance remains valid", async () => {
  const styles = await stylesSource();
  const actions = cssRule(styles, ".feishu-configuration-stack .feishu-subject-actions");
  const actionButtons = cssRule(styles, ".feishu-configuration-stack .feishu-subject-actions > .button");

  assert.match(actions, /flex-wrap:\s*nowrap;/);
  assert.match(actions, /overflow-x:\s*auto;/);
  assert.match(actions, /overflow-y:\s*hidden;/);
  assert.match(actionButtons, /flex:\s*0\s+0\s+auto;/);
});
