import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { taskboardStorage } from "../storage";

const STORAGE_KEY = "taskboard.sidebar-layout.v1";
const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const WORKSPACE_MIN_WIDTH = 440;
const MOBILE_WIDTH = 840;

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
    const width = JSON.parse(taskboardStorage.getItem(STORAGE_KEY) ?? "null")?.width;
    if (typeof width === "number" && Number.isFinite(width)) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
  } catch { /* Invalid or unavailable preferences retain the default layout. */ }
  return DEFAULT_WIDTH;
}

function saveWidth(width: number) {
  try { taskboardStorage.setItem(STORAGE_KEY, JSON.stringify({ width })); }
  catch { /* Resizing remains available when preferences cannot be saved. */ }
}

function releaseCapture(session: ResizeSession | null) {
  if (session?.target.hasPointerCapture?.(session.pointerId)) session.target.releasePointerCapture(session.pointerId);
}

/** This display preference is independent of PMO workflow configuration. */
export function useSidebarLayout(enabled: boolean) {
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const sessionRef = useRef<ResizeSession | null>(null);
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - WORKSPACE_MIN_WIDTH));
  const width = Math.round(Math.min(preferredWidth, maxWidth));
  const resizable = enabled && viewportWidth > MOBILE_WIDTH;
  const boundsRef = useRef({ maxWidth, width, preferredWidth, resizable });
  boundsRef.current = { maxWidth, width, preferredWidth, resizable };

  const finish = useCallback((commit: boolean, pointerId?: number) => {
    const session = sessionRef.current;
    if (!session || (pointerId !== undefined && session.pointerId !== pointerId)) return;
    sessionRef.current = null;
    releaseCapture(session);
    setDragging(false);
    setPreferredWidth(commit ? session.width : session.startPreference);
    if (commit) saveWidth(session.width);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const move = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      event.preventDefault();
      session.width = Math.round(Math.max(MIN_WIDTH, Math.min(boundsRef.current.maxWidth,
        session.startWidth + event.clientX - session.startX)));
      setPreferredWidth(session.width);
    };
    const end = (event: globalThis.PointerEvent) => finish(true, event.pointerId);
    const cancel = (event: globalThis.PointerEvent) => finish(false, event.pointerId);
    const blur = () => finish(false);
    const resize = () => { finish(false); setViewportWidth(window.innerWidth); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && sessionRef.current) {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", resize);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", key, true);
      const session = sessionRef.current;
      sessionRef.current = null;
      releaseCapture(session);
    };
  }, [enabled, finish]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!resizable || event.button !== 0 || event.isPrimary === false || sessionRef.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    sessionRef.current = { pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX,
      startWidth: width, startPreference: preferredWidth, width };
    setDragging(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!resizable || sessionRef.current) return;
    const step = event.shiftKey ? 64 : 16;
    const next = event.key === "ArrowLeft" ? width - step : event.key === "ArrowRight" ? width + step
      : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth : null;
    if (next === null) return;
    event.preventDefault();
    const bounded = Math.max(MIN_WIDTH, Math.min(maxWidth, next));
    setPreferredWidth(bounded);
    saveWidth(bounded);
  }

  return {
    resizable, dragging,
    style: { "--taskboard-sidebar-width": `${width}px` } as CSSProperties,
    splitterProps: {
      role: "separator", tabIndex: 0, "aria-orientation": "vertical" as const,
      "aria-valuemin": MIN_WIDTH, "aria-valuemax": maxWidth, "aria-valuenow": width,
      onPointerDown, onKeyDown,
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => finish(false, event.pointerId),
    },
  };
}
