# Feishu Subject Configuration Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved four-page, responsive configuration view for a Feishu subject without changing its persisted configuration or execution contract.

**Architecture:** Keep `FeishuWorkflowPanel` as the single owner of `SubjectForm`, validation and `saveDraft`. Add local selected-tab state and conditionally render one of four semantic tab panels, moving existing controls without changing their names or update callbacks. Make existing CSS grids adapt to the width of the configuration panel and separate stage trigger/source layout inside `FeishuStageEditor`.

**Tech Stack:** React 19, TypeScript, Vitest, CSS.

## Global Constraints

- Do not change Auto-Cut-Lite manifests, run inputs, stored stage snapshots, or the Bridge/Taskboard protocol.
- Existing source fields, stage options and existing Feishu fields/options remain selected by ID.
- Never remove historical configuration or board-label database values as part of this UI change.
- Preserve the approved functional palette and use 8px single-layer configuration cards.

---

### Task 1: Prove the four-page behavior

**Files:**
- Modify: `taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`

**Interfaces:**
- Consumes: rendered `FeishuWorkflowPanel` fixtures and existing accessible control names.
- Produces: regression coverage for page ownership, selected tab behavior, keyboard navigation, and retaining an unsaved stage edit.

- [ ] **Step 1: Write failing tab-panel tests**

```tsx
expect(screen.getByRole("tab", { name: "基础与执行" })).toHaveAttribute("aria-selected", "true");
expect(screen.getByRole("tabpanel", { name: "基础与执行" })).toBeVisible();
expect(screen.queryByRole("tabpanel", { name: "飞书回写" })).toBeNull();

fireEvent.click(screen.getByRole("tab", { name: "存储与目录" }));
expect(screen.getByLabelText("指定状态进入时创建00成片")).toBeVisible();
expect(screen.queryByLabelText("初稿处理中字段")).toBeNull();
```

- [ ] **Step 2: Run the focused test and observe failure**

Run: `npm run test:components -- --run taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`

Expected: the new assertions fail because the current production form mounts all sections with no tab roles.

### Task 2: Implement four semantic panels

**Files:**
- Modify: `taskboard/web/src/components/FeishuWorkflowPanel.tsx`
- Test: `taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`

**Interfaces:**
- Consumes: `SubjectForm`, existing callbacks including `updateDelivery`, `updateStage` and `saveDraft`.
- Produces: `basics`, `materials`, `storage`, and `writeback` tab panels; unchanged saved patch shape.

- [ ] **Step 1: Add the minimum local navigation state**

```tsx
type SettingsTabId = "basics" | "materials" | "storage" | "writeback";
const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTabId>("basics");
```

Reset this state to `"basics"` only after the selected subject key changes.

- [ ] **Step 2: Move existing JSX by ownership**

```tsx
const SETTINGS_TABS = [
  ["basics", "基础与执行"],
  ["materials", "素材与阶段"],
  ["storage", "存储与目录"],
  ["writeback", "飞书回写"],
] as const;
```

Use `role="tablist"`, `role="tab"` and `role="tabpanel"`; support ArrowLeft, ArrowRight, Home and End. Keep stage source controls in `materials`; move `finalDirectoryTrigger` to `storage`; move course-path and phase assignments to `writeback`; retain a disabled-state prerequisite message when delivery is off.

- [ ] **Step 3: Run focused tests**

Run: `npm run test:components -- --run taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`

Expected: PASS with all legacy source-field and new tab-panel cases.

### Task 3: Make cards adapt to the configuration container

**Files:**
- Modify: `taskboard/web/src/components/FeishuStageEditor.tsx`
- Modify: `taskboard/web/src/styles.css`
- Test: `taskboard/web/src/components/FeishuWorkflowPanel.test.tsx`

**Interfaces:**
- Consumes: existing stage field controls and class names.
- Produces: a trigger row, two-column source grouping, full-width audio, and auto-fitting configuration grids.

- [ ] **Step 1: Add layout-only wrappers to the stage editor**

```tsx
<div className="feishu-stage-trigger">...</div>
<div className="feishu-stage-source-grid">
  <div className="feishu-stage-source-group">...</div>
  <div className="feishu-stage-source-group">...</div>
</div>
```

Do not alter input names, values, labels, handlers, or validation messages.

- [ ] **Step 2: Add container-aware responsive CSS**

```css
.feishu-subject-settings { container-type: inline-size; }
.feishu-delivery-writeback { grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
@container (max-width: 720px) { .feishu-settings-grid, .feishu-stage-source-grid { grid-template-columns: 1fr; } }
```

Keep the card radius at 8px and avoid nested card styling.

- [ ] **Step 3: Run focused tests and a production build**

Run: `npm run test:components -- --run taskboard/web/src/components/FeishuWorkflowPanel.test.tsx && npm run typecheck && npm run build:web`

Expected: each command exits `0`.

### Task 4: Verify the local product stack

**Files:**
- No source changes required unless a check exposes a user-facing regression.

**Interfaces:**
- Consumes: production web build and existing local-only startup scripts.
- Produces: evidence that the updated frontend is served by the local Taskboard and Bridge health checks remain green.

- [ ] **Step 1: Run the component suite**

Run: `npm run test:components`

Expected: PASS.

- [ ] **Step 2: Restart and check the stack**

Run: `./scripts/stop-local.ps1`, `./scripts/start-local.ps1`, `./scripts/check-local.ps1`

Expected: Taskboard and Bridge health checks pass on loopback-only URLs.
