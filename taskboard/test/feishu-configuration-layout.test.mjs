import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

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

test("ZIP and VM scroll only the configuration details while tabs and actions stay outside", async () => {
  const styles = await stylesSource();
  const dom = new JSDOM('<div class="feishu-configuration-stack"></div>');
  try {
    const sheet = dom.window.document.createElement("style");
    sheet.textContent = styles;
    dom.window.document.head.append(sheet);
    const root = dom.window.document.querySelector(".feishu-configuration-stack");
    for (const vm of [false, true]) {
      for (const feedback of [false, true]) {
        const form = dom.window.document.createElement("form");
        form.className = `feishu-subject-settings has-package-route${vm ? " is-vm-workflow" : ""}`;
        form.innerHTML = `<header class="feishu-subject-settings-header">学科配置</header>
          <fieldset class="feishu-config-card feishu-package-route feishu-package-context">包选择与当前生效包</fieldset>
          ${feedback ? '<p class="feishu-field-refresh-feedback">字段刷新结果</p>' : ""}
          ${vm ? '<section class="feishu-vm-pmo-editor"><div class="feishu-vm-pmo-summary">流程草稿版本</div>' : ""}
          <div class="feishu-settings-tabs">配置分区</div>
          <section class="feishu-settings-tabpanel">长配置内容</section>
          <div class="feishu-subject-actions${vm ? " feishu-vm-pmo-actions" : ""}">保存草稿</div>
          ${vm ? "</section>" : ""}`;
        root.append(form);
        const layout = dom.window.getComputedStyle(form);
        assert.equal(layout.display, "flex");
        assert.equal(layout.flexDirection, "column");
        assert.equal(layout.overflowY, "hidden", "the form must not scroll tabs and actions out of view");
        assert.equal(layout.minHeight, "0");
        const editor = form.querySelector(".feishu-settings-tabpanel");
        const vmEditor = form.querySelector(".feishu-vm-pmo-editor");
        if (vmEditor) {
          const vmLayout = dom.window.getComputedStyle(vmEditor);
          assert.equal(vmLayout.display, "flex");
          assert.equal(vmLayout.flexDirection, "column");
          assert.equal(vmLayout.flexGrow, "1");
          assert.equal(vmLayout.minHeight, "0");
          assert.equal(vmLayout.overflow, "hidden");
        }
        for (const block of [...form.children, ...(vmEditor?.children ?? [])]) {
          const style = dom.window.getComputedStyle(block);
          if (block === editor) {
            assert.equal(style.flexGrow, "1");
            assert.equal(style.overflow, "auto");
            assert.equal(style.minHeight, "0", "details must shrink to the available pane height");
          } else if (block !== vmEditor) {
            assert.equal(style.flexShrink, "0", "metadata, tabs and actions must not collapse");
          }
        }
        form.remove();
      }
    }
  } finally {
    dom.window.close();
  }
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
