import { useCallback, useRef, useState } from 'react';
import useUIStore from '../stores/uiStore';

export const DEFAULT_FRACTION = 0.4;
const KEY_STEP = 0.02;

export const clampFraction = (fraction, containerWidth, minPx, maxFraction) => {
  const minFraction = containerWidth > 0 ? Math.min(minPx / containerWidth, maxFraction) : 0;
  const clamped = Math.min(Math.max(fraction, minFraction), maxFraction);
  return Math.round(clamped * 10000) / 10000; // no 42.00000000000001% in the style
};

const percent = (fraction) => Math.round(fraction * 10000) / 100;

/**
 * A draggable divider for a list + detail split (Artifacts, and later Findings / Controls).
 *
 * The detail panel's share of the row is kept as a FRACTION (not pixels) so a saved width still makes
 * sense when the window changes size. CSS min/max on the panel keep it usable at any window size even
 * when the saved fraction would not be; the drag handler clamps the same way. The fraction is saved per
 * `key` in uiStore, which is per-browser (never synced to the server).
 *
 * Usage: put `containerRef` on the flex row, spread `panelStyle` on the detail panel, and render a
 * `<div {...separatorProps} />` between the list and the panel.
 */
const useResizablePanel = ({ key, defaultFraction = DEFAULT_FRACTION, minPx = 384, maxFraction = 0.75 }) => {
  const saved = useUIStore((s) => s.panelSplits?.[key]);
  const setPanelSplit = useUIStore((s) => s.setPanelSplit);
  const containerRef = useRef(null);
  const [dragFraction, setDragFraction] = useState(null);

  const fraction = dragFraction ?? (Number.isFinite(saved) ? saved : defaultFraction);
  const isDragging = dragFraction !== null;

  const containerWidth = () => containerRef.current?.getBoundingClientRect().width || 0;

  const fractionAt = (clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return clampFraction((rect.right - clientX) / rect.width, rect.width, minPx, maxFraction);
  };

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const next = fractionAt(e.clientX);
    if (next !== null) setDragFraction(next);
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const next = fractionAt(e.clientX);
    if (next !== null) setDragFraction(next);
  };

  const endDrag = (e) => {
    if (!isDragging) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setPanelSplit(key, dragFraction);
    setDragFraction(null);
  };

  const onKeyDown = (e) => {
    // The panel is on the right, so ArrowLeft moves the divider left and widens it.
    const delta = e.key === 'ArrowLeft' ? KEY_STEP : e.key === 'ArrowRight' ? -KEY_STEP : 0;
    if (!delta) return;
    e.preventDefault();
    setPanelSplit(key, clampFraction(fraction + delta, containerWidth(), minPx, maxFraction));
  };

  const reset = useCallback(() => setPanelSplit(key, null), [key, setPanelSplit]);

  return {
    containerRef,
    isDragging,
    fraction,
    panelStyle: {
      flex: `0 0 ${percent(fraction)}%`,
      minWidth: `${minPx}px`,
      maxWidth: `${percent(maxFraction)}%`
    },
    separatorProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize detail panel',
      'aria-valuemin': 0,
      'aria-valuemax': Math.round(maxFraction * 100),
      'aria-valuenow': Math.round(fraction * 100),
      tabIndex: 0,
      title: 'Drag to resize, double-click to reset',
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown,
      onDoubleClick: reset,
      style: {
        flex: '0 0 6px',
        cursor: 'col-resize',
        touchAction: 'none',
        userSelect: 'none',
        background: isDragging ? 'var(--accent-color, #2563eb)' : 'transparent'
      }
    }
  };
};

export default useResizablePanel;
