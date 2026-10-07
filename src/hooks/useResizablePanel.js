import { useCallback, useEffect, useRef, useState } from 'react';
import useUIStore from '../stores/uiStore';

export const DEFAULT_FRACTION = 0.4;
const FRACTION_KEY_STEP = 0.02;
const PX_KEY_STEP = 20;

export const clampFraction = (fraction, containerWidth, minPx, maxFraction) => {
  const minFraction = containerWidth > 0 ? Math.min(minPx / containerWidth, maxFraction) : 0;
  const clamped = Math.min(Math.max(fraction, minFraction), maxFraction);
  return Math.round(clamped * 10000) / 10000; // no 42.00000000000001% in the style
};

export const clampPx = (px, minPx, maxPx) => Math.round(Math.min(Math.max(px, minPx), maxPx));

const percent = (fraction) => Math.round(fraction * 10000) / 100;

/**
 * A draggable divider for a detail panel. Two shapes, chosen by `unit`:
 *
 * `unit: 'fraction'` (default) is a list + detail SPLIT in one flex row (Artifacts). The panel's share of the
 *   row is kept as a fraction, so a saved width still makes sense when the window changes size. CSS min/max
 *   on the panel keep it usable at any window size; the drag handler clamps the same way.
 *   Options: defaultFraction, minPx, maxFraction. Put `containerRef` on the flex row, spread `panelStyle` on
 *   the panel and render `<div {...separatorProps} />` as a sibling between the list and the panel.
 *
 * `unit: 'px'` is a panel pinned to the right edge (a fixed overlay, or the last item of a row that ends at
 *   the window edge: Findings, Requirements, Controls). Width is in pixels, measured from the right edge of
 *   `containerRef` if one is set, else of the window. Options: defaultPx, minPx, maxPx. Spread `panelStyle`
 *   on the panel and render `<div {...separatorProps} />` INSIDE it (the handle is absolutely positioned on
 *   the panel's left edge, so the panel must be `position: fixed` or `relative`).
 *
 * The value is saved per `key` in uiStore `panelSplits`, which is per-browser and never synced to the server.
 * Callers style the divider's colour from `isDragging` (the hook sets layout and cursor only).
 */
const useResizablePanel = ({
  key,
  unit = 'fraction',
  defaultFraction = DEFAULT_FRACTION,
  minPx = unit === 'px' ? 320 : 384,
  maxFraction = 0.75,
  defaultPx = 420,
  maxPx = 800
}) => {
  const isPx = unit === 'px';
  const saved = useUIStore((s) => s.panelSplits?.[key]);
  const setPanelSplit = useUIStore((s) => s.setPanelSplit);
  const containerRef = useRef(null);
  const [dragValue, setDragValue] = useState(null);

  const fallback = isPx ? defaultPx : defaultFraction;
  const stored = Number.isFinite(saved) ? saved : fallback;
  const value = dragValue ?? (isPx ? clampPx(stored, minPx, maxPx) : stored);
  const isDragging = dragValue !== null;

  const rect = () => containerRef.current?.getBoundingClientRect();

  const valueAt = (clientX) => {
    if (isPx) {
      const right = rect()?.right ?? window.innerWidth;
      return clampPx(right - clientX, minPx, maxPx);
    }
    const r = rect();
    if (!r || r.width <= 0) return null;
    return clampFraction((r.right - clientX) / r.width, r.width, minPx, maxFraction);
  };

  // While dragging, keep the pointer a col-resize cursor and stop text selection across the page.
  useEffect(() => {
    if (!isDragging) return undefined;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const next = valueAt(e.clientX);
    if (next !== null) setDragValue(next);
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const next = valueAt(e.clientX);
    if (next !== null) setDragValue(next);
  };

  const endDrag = (e) => {
    if (!isDragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setPanelSplit(key, dragValue);
    setDragValue(null);
  };

  const onKeyDown = (e) => {
    // The panel is on the right, so ArrowLeft moves the divider left and widens it.
    const dir = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (isPx) {
      setPanelSplit(key, clampPx(value + dir * PX_KEY_STEP, minPx, maxPx));
    } else {
      setPanelSplit(key, clampFraction(value + dir * FRACTION_KEY_STEP, rect()?.width || 0, minPx, maxFraction));
    }
  };

  const reset = useCallback(() => setPanelSplit(key, null), [key, setPanelSplit]);

  const panelStyle = isPx
    ? { width: `${value}px`, maxWidth: 'calc(100vw - 48px)' } // a saved width never covers a small window
    : { flex: `0 0 ${percent(value)}%`, minWidth: `${minPx}px`, maxWidth: `${percent(maxFraction)}%` };

  const layoutStyle = isPx
    ? { position: 'absolute', left: '-4px', top: 0, bottom: 0, width: '8px', zIndex: 10 }
    : { flex: '0 0 6px' };

  return {
    containerRef,
    isDragging,
    fraction: isPx ? undefined : value,
    width: isPx ? value : undefined,
    panelStyle,
    separatorProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize detail panel',
      'aria-valuemin': isPx ? minPx : 0,
      'aria-valuemax': isPx ? maxPx : Math.round(maxFraction * 100),
      'aria-valuenow': isPx ? value : Math.round(value * 100),
      tabIndex: 0,
      title: 'Drag to resize, double-click to reset',
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown,
      onDoubleClick: reset,
      style: { ...layoutStyle, cursor: 'col-resize', touchAction: 'none', userSelect: 'none' }
    }
  };
};

export default useResizablePanel;
