import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { taskboardStorage } from "../storage";

const STORAGE_KEY = "taskboard.feishu-configuration-layout.v1";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 520;
const SETTINGS_MIN_WIDTH = 420;
const SPLITTER_WIDTH = 8;
const STACKED_WIDTH = 760;

type ResizeSession = {
  pointerId: number;
  target: HTMLDivElement;
  startX: number;
  startWidth: number;
  startPreference: number;
  width: number;
};

function readWidth() {
  try {
    const value = JSON.parse(taskboardStorage.getItem(STORAGE_KEY) ?? "null")?.catalogWidth;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value));
    }
  } catch { /* A blocked or invalid preference does not prevent configuration. */ }
  return DEFAULT_WIDTH;
}

function saveWidth(catalogWidth: number) {
  try {
    taskboardStorage.setItem(STORAGE_KEY, JSON.stringify({ catalogWidth }));
  } catch { /* The current layout remains usable when storage is unavailable. */ }
}

function releaseCapture(session: ResizeSession | null) {
  if (session?.target.hasPointerCapture?.(session.pointerId)) {
    session.target.releasePointerCapture(session.pointerId);
  }
}

/** Layout preferences are separate from the subject configuration and never enter its draft. */
export function useFeishuConfigurationLayout(enabled: boolean) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [panelWidth, setPanelWidth] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const sessionRef = useRef<ResizeSession | null>(null);
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, panelWidth - SETTINGS_MIN_WIDTH - SPLITTER_WIDTH));
  const width = Math.round(Math.min(maxWidth, Math.max(MIN_WIDTH, preferredWidth)));
  const stacked = panelWidth <= STACKED_WIDTH;
  const boundsRef = useRef({ maxWidth, width, preferredWidth });
  boundsRef.current = { maxWidth, width, preferredWidth };

  const finish = useCallback((commit: boolean, pointerId?: number) => {
    const session = sessionRef.current;
    if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) return;
    sessionRef.current = null;
    releaseCapture(session);
    setDragging(false);
    setPreferredWidth(commit ? session.width : session.startPreference);
    if (commit) saveWidth(session.width);
  }, []);

  useLayoutEffect(() => {
    if (!enabled) return;
    const measure = () => {
      const measured = panelRef.current?.getBoundingClientRect().width ?? 0;
      if (measured > 0) {
        finish(false);
        setPanelWidth(measured);
      }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled, finish]);

  useEffect(() => {
    if (!enabled) return;
    const move = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      event.preventDefault();
      session.width = Math.round(Math.max(MIN_WIDTH, Math.min(
        boundsRef.current.maxWidth,
        session.startWidth + event.clientX - session.startX,
      )));
      setPreferredWidth(session.width);
    };
    const end = (event: globalThis.PointerEvent) => finish(true, event.pointerId);
    const cancel = (event: globalThis.PointerEvent) => finish(false, event.pointerId);
    const blur = () => finish(false);
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && sessionRef.current) {
        event.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key);
      const session = sessionRef.current;
      sessionRef.current = null;
      releaseCapture(session);
    };
  }, [enabled, finish]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || stacked || event.button !== 0 || event.isPrimary === false || sessionRef.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    sessionRef.current = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      startX: event.clientX,
      startWidth: width,
      startPreference: preferredWidth,
      width,
    };
    setDragging(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!enabled || stacked || sessionRef.current) return;
    const step = event.shiftKey ? 64 : 16;
    const next = event.key === "ArrowLeft" ? width - step
      : event.key === "ArrowRight" ? width + step
        : event.key === "Home" ? MIN_WIDTH
          : event.key === "End" ? maxWidth : null;
    if (next === null) return;
    event.preventDefault();
    const bounded = Math.max(MIN_WIDTH, Math.min(maxWidth, next));
    setPreferredWidth(bounded);
    saveWidth(bounded);
  }

  return {
    panelRef,
    stacked,
    dragging,
    style: { "--feishu-catalog-width": `${width}px` } as CSSProperties,
    splitterProps: {
      role: "separator",
      tabIndex: 0,
      "aria-label": "调整学科目录宽度",
      "aria-orientation": "vertical" as const,
      "aria-valuemin": MIN_WIDTH,
      "aria-valuemax": maxWidth,
      "aria-valuenow": width,
      "aria-valuetext": `${width} 像素`,
      title: "拖动调整目录宽度；方向键微调，Home / End 调至最窄 / 最宽",
      onPointerDown,
      onKeyDown,
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finish(false, event.pointerId),
    },
  };
}
