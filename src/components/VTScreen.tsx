import React, { useLayoutEffect, useRef } from 'react';
import { ansiToHtml } from '../utils/ansi';

// Cell metrics of .vt-screen: font-size 13px × line-height 1.2, padding 2px/4px.
const CELL_H = 13 * 1.2;
const PAD_Y = 4; // 2px top + 2px bottom

interface Props {
  lines: string[];
  // cursorRow drives the keyboard-follow offset below. cursorCol is retained
  // for API compatibility but not used for rendering: the daemon bakes a block
  // cursor directly into the VT ANSI (reverse video on the cursor cell, see
  // rysh-cli 2b45d27), so the cursor renders at the correct visual column via
  // ansiToHtml. The previous manual overlay split at a character index that
  // ignored embedded ANSI escapes and therefore mispositioned the cursor on
  // styled lines.
  cursorRow?: number;
  cursorCol?: number;
  // Predictive local-echo overlay: dim pending chars positioned at (row,col).
  // Rendered as an absolutely-positioned span over the grid — never written into
  // `lines` — so a wrong guess can't corrupt the screen. Positioned with
  // font-relative units (1.2em line-height, 1ch cell width) matching the
  // monospace .vt-screen metrics.
  echo?: { text: string; row: number; col: number };
}

export const VTScreen = React.memo(function VTScreen({ lines, cursorRow, echo }: Props) {
  const innerRef = useRef<HTMLDivElement | null>(null);

  // Keep the cursor row (e.g. claude's input line, drawn near the bottom of
  // the TUI) visible when the VT content is taller than the on-screen box.
  // Port of rysh-mobile InteractiveTerminal's applyScrollOffset: shift the
  // content up via translateY so the cursor sits just above the bottom edge;
  // .vt-screen has overflow:hidden, so the shifted-off top rows are clipped.
  //
  // This happens on a phone while the soft keyboard is up: the pane view is
  // sized to the visual viewport (see useVisualViewport), and until the PTY
  // re-fit lands — or for remote panes whose source PTY we cannot resize at
  // all — the screen overflows the shrunken box. Normally content fits
  // (usePaneResize keeps the PTY matched to this box) and the offset is 0.
  // Re-runs on every write (`lines` changes — the cursor moves when the
  // program redraws, mirroring rysh-mobile's writeBatch hook) and on box
  // resizes (keyboard show/hide, rotation).
  useLayoutEffect(() => {
    const inner = innerRef.current;
    const outer = inner?.parentElement;
    if (!inner || !outer) return;
    const apply = () => {
      const viewH = outer.clientHeight - PAD_Y;
      const contentH = lines.length * CELL_H;
      let offset = 0;
      if (viewH > 0 && contentH > viewH) {
        const row = cursorRow ?? lines.length - 1;
        const cursorBottom = (row + 1) * CELL_H;
        offset = cursorBottom + CELL_H - viewH; // one row of breathing room
        if (offset < 0) offset = 0;
        const maxOffset = contentH - viewH;
        if (offset > maxOffset) offset = maxOffset;
      }
      inner.style.transform = offset > 0 ? `translateY(${-offset}px)` : '';
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(outer);
    return () => ro.disconnect();
  }, [lines, cursorRow]);

  return (
    <div className="vt-screen">
      <div ref={innerRef} style={{ position: 'relative' }}>
        {lines.map((line, row) => (
          <div key={row} className="vt-line" dangerouslySetInnerHTML={{ __html: ansiToHtml(line) }} />
        ))}
        {echo && echo.text ? (
          <span
            style={{
              position: 'absolute',
              top: `calc(${echo.row} * 1.2em)`,
              left: `${echo.col}ch`,
              fontSize: 13,
              lineHeight: 1.2,
              whiteSpace: 'pre',
              opacity: 0.55,
              color: '#d4d4d4',
              pointerEvents: 'none',
            }}
          >
            {echo.text}
          </span>
        ) : null}
      </div>
    </div>
  );
});
