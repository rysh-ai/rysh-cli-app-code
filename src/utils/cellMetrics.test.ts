import { afterEach, describe, expect, it } from 'vitest';
import {
  CELL_W_FALLBACK,
  VT_FONT_SIZE_PX,
  cellHeightForFontSize,
  cellHeightOf,
  measureVTCell,
} from './cellMetrics';

// The numbers every VT consumer has relied on since the web renderer began:
// 13px × line-height 1.2 = 15.6px rows, and a 7.8px column width when the
// font cannot be measured yet. Pinned so the refactor that gave them one
// owner cannot drift them.

let style: HTMLStyleElement | null = null;
afterEach(() => {
  style?.remove();
  style = null;
});

describe('cellMetrics', () => {
  it('pins today\'s 13px font: h = 15.6, w fallback = 7.8', () => {
    expect(VT_FONT_SIZE_PX).toBe(13);
    expect(cellHeightForFontSize(VT_FONT_SIZE_PX)).toBeCloseTo(15.6, 10);
    expect(CELL_W_FALLBACK).toBe(7.8);
  });

  it('measures the .vt-screen CSS font, with the fallback width when layout gives nothing', () => {
    style = document.createElement('style');
    style.textContent = '.vt-screen { font-size: 13px; }';
    document.head.appendChild(style);

    expect(measureVTCell()).toEqual({ w: 7.8, h: cellHeightForFontSize(13) });
  });

  it('reads a rendered element\'s font size, so a CSS change moves the cell height', () => {
    const el = document.createElement('div');
    el.style.fontSize = '20px';
    document.body.appendChild(el);
    expect(cellHeightOf(el)).toBeCloseTo(24, 10);
    el.remove();
  });
});
