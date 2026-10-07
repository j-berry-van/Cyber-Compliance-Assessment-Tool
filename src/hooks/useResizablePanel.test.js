import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import useResizablePanel, { clampFraction, clampPx } from './useResizablePanel';
import useUIStore from '../stores/uiStore';

// jsdom (Jest 27) has no PointerEvent, so fireEvent.pointer* would drop clientX/button.
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  };
}

const Harness = () => {
  const { containerRef, panelStyle, separatorProps } = useResizablePanel({ key: 'test', minPx: 200, maxFraction: 0.75 });
  return (
    <div ref={containerRef} data-testid="row">
      <div {...separatorProps} />
      <div data-testid="panel" style={panelStyle} />
    </div>
  );
};

const mockRow = () => {
  jest.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, right: 1000, width: 1000, top: 0, bottom: 500, height: 500, x: 0, y: 0
  });
};

describe('useResizablePanel', () => {
  beforeEach(() => {
    mockRow();
    act(() => useUIStore.setState({ panelSplits: {} }));
  });
  afterEach(() => jest.restoreAllMocks());

  test('clampFraction keeps the panel between the minimum width and the maximum share', () => {
    expect(clampFraction(0.05, 1000, 200, 0.75)).toBeCloseTo(0.2);
    expect(clampFraction(0.95, 1000, 200, 0.75)).toBe(0.75);
    expect(clampFraction(0.5, 1000, 200, 0.75)).toBe(0.5);
  });

  test('starts at the default 40% share', () => {
    render(<Harness />);
    expect(screen.getByTestId('panel').style.flex).toBe('0 0 40%');
  });

  test('dragging the divider resizes the panel and saves the width on release', () => {
    render(<Harness />);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 600, button: 0 });
    fireEvent.pointerMove(sep, { clientX: 500 });
    expect(screen.getByTestId('panel').style.flex).toBe('0 0 50%');
    expect(useUIStore.getState().panelSplits.test).toBeUndefined();
    fireEvent.pointerUp(sep);
    expect(useUIStore.getState().panelSplits.test).toBe(0.5);
  });

  test('dragging past the limits is clamped', () => {
    render(<Harness />);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 600, button: 0 });
    fireEvent.pointerMove(sep, { clientX: 5 });
    expect(screen.getByTestId('panel').style.flex).toBe('0 0 75%');
    fireEvent.pointerMove(sep, { clientX: 990 });
    expect(screen.getByTestId('panel').style.flex).toBe('0 0 20%');
    fireEvent.pointerUp(sep);
  });

  test('arrow keys resize and double-click resets', () => {
    render(<Harness />);
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(screen.getByTestId('panel').style.flex).toBe('0 0 42%');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(screen.getByTestId('panel').style.flex).toBe('0 0 38%');
    fireEvent.doubleClick(sep);
    expect(screen.getByTestId('panel').style.flex).toBe('0 0 40%');
  });

  test('uses a saved width', () => {
    act(() => useUIStore.setState({ panelSplits: { test: 0.6 } }));
    render(<Harness />);
    expect(screen.getByTestId('panel').style.flex).toBe('0 0 60%');
  });

  describe("unit: 'px' (panel pinned to the right edge)", () => {
    const PxHarness = () => {
      const { containerRef, panelStyle, separatorProps, isDragging } = useResizablePanel({
        key: 'px-test', unit: 'px', defaultPx: 480, minPx: 380, maxPx: 900
      });
      return (
        <div ref={containerRef}>
          <div data-testid="panel" style={panelStyle}>
            <div {...separatorProps} data-dragging={String(isDragging)} />
          </div>
        </div>
      );
    };

    test('the panel never covers the whole window, whatever width was saved', () => {
      render(<PxHarness />);
      expect(screen.getByTestId('panel').style.maxWidth).toBe('calc(100vw - 48px)');
    });

    test('clampPx keeps the width within the limits', () => {
      expect(clampPx(100, 380, 900)).toBe(380);
      expect(clampPx(2000, 380, 900)).toBe(900);
      expect(clampPx(512.4, 380, 900)).toBe(512);
    });

    test('starts at the default width and exposes it on the separator', () => {
      render(<PxHarness />);
      expect(screen.getByTestId('panel').style.width).toBe('480px');
      const sep = screen.getByRole('separator');
      expect(sep.getAttribute('aria-valuenow')).toBe('480');
      expect(sep.getAttribute('aria-valuemin')).toBe('380');
      expect(sep.getAttribute('aria-valuemax')).toBe('900');
    });

    test('dragging measures from the right edge of the container, clamps, and saves on release', () => {
      render(<PxHarness />); // mocked row: right edge at 1000
      const sep = screen.getByRole('separator');
      fireEvent.pointerDown(sep, { clientX: 520, button: 0 });
      expect(sep.getAttribute('data-dragging')).toBe('true');
      fireEvent.pointerMove(sep, { clientX: 400 });
      expect(screen.getByTestId('panel').style.width).toBe('600px');
      fireEvent.pointerMove(sep, { clientX: 10 });
      expect(screen.getByTestId('panel').style.width).toBe('900px');
      fireEvent.pointerMove(sep, { clientX: 990 });
      expect(screen.getByTestId('panel').style.width).toBe('380px');
      fireEvent.pointerMove(sep, { clientX: 300 });
      expect(useUIStore.getState().panelSplits['px-test']).toBeUndefined();
      fireEvent.pointerUp(sep);
      expect(useUIStore.getState().panelSplits['px-test']).toBe(700);
      expect(sep.getAttribute('data-dragging')).toBe('false');
    });

    test('arrow keys move in 20px steps, double-click resets', () => {
      render(<PxHarness />);
      const sep = screen.getByRole('separator');
      fireEvent.keyDown(sep, { key: 'ArrowLeft' });
      expect(screen.getByTestId('panel').style.width).toBe('500px');
      fireEvent.keyDown(sep, { key: 'ArrowRight' });
      fireEvent.keyDown(sep, { key: 'ArrowRight' });
      expect(screen.getByTestId('panel').style.width).toBe('460px');
      fireEvent.doubleClick(sep);
      expect(screen.getByTestId('panel').style.width).toBe('480px');
    });

    test('a saved width is used, and an out-of-range one is clamped', () => {
      act(() => useUIStore.setState({ panelSplits: { 'px-test': 650 } }));
      const { unmount } = render(<PxHarness />);
      expect(screen.getByTestId('panel').style.width).toBe('650px');
      unmount();
      act(() => useUIStore.setState({ panelSplits: { 'px-test': 5000 } }));
      render(<PxHarness />);
      expect(screen.getByTestId('panel').style.width).toBe('900px');
    });

    test('dragging restores the page cursor and text selection afterwards', () => {
      render(<PxHarness />);
      const sep = screen.getByRole('separator');
      fireEvent.pointerDown(sep, { clientX: 520, button: 0 });
      expect(document.body.style.cursor).toBe('col-resize');
      fireEvent.pointerUp(sep);
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
    });
  });
});
