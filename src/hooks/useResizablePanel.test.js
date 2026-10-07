import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import useResizablePanel, { clampFraction } from './useResizablePanel';
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
});
