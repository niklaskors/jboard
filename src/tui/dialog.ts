// Dialogs: modal boxes over the board that take all keys until they close.

import type { Benched } from "../bench.ts";
import type { Board } from "../board.ts";
import { lineLen, overlay, shorten, sliceLine, type Line, type Segment, type Style } from "../render/line.ts";
import { theme } from "../render/theme.ts";

/** A key press as Node's readline reports it. */
export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface Dialog {
  draw(rows: Line[]): void;
  key(str: string | undefined, key: Key): void | Promise<void>;
}

/** What a dialog may do with the board screen around it (implemented by the Tui). */
export interface DialogHost {
  readonly board: Board;
  readonly width: number;
  readonly height: number;
  readonly dialog: Dialog | null;
  /** The status line. */
  msg: string;
  close(): void;
  draw(): void;
  /** Close the dialog and run a Jira change while the board waits; shows the returned message or the failure. */
  perform(progress: string, work: () => Promise<string>, failure: (message: string) => string): Promise<void>;
  /** Leave the board screen while `run` uses the terminal (e.g. an editor), then come back. */
  outside<T>(run: () => T): T;
  /** Load the sprint and the backlog again, e.g. after an issue moved between them. */
  reload(): Promise<void>;
  /** Show an issue's change (e.g. its new status) on the board, keeping the cursor where it is. */
  changed(): void;
  /** Show a card's subtasks after the change. */
  expand(cardKey: string): void;
  /** Put the cursor on the first of these issues after the change, instead of where it was. */
  focus(...keys: string[]): void;
  /** Issues that have a bench (a worktree made by the bench tool), with its merge request. */
  readonly benched: Benched;
  /** Look up which issues have a bench again, in the background, and redraw. */
  showBenches(): void;
}

/** A printable character typed into a text field. */
export const isTyping = (str: string | undefined, key: Key) =>
  !!str && str.length === 1 && str >= " " && !key.ctrl && !key.meta;

/** A dialog box's size: its widest (borders included), and the space between its sides and the text
 * (`pad` columns left and right, `padY` blank lines above and below). */
export interface BoxShape {
  max?: number;
  pad?: number;
  padY?: number;
}

const boxWidth = (width: number, shape: BoxShape) => Math.min(shape.max ?? 64, width - 4);

/** Width available for text inside a dialog box. */
export const boxInner = (width: number, shape: BoxShape = {}) => boxWidth(width, shape) - 2 - 2 * (shape.pad ?? 1);

export type BoxRow = { line: Line; style?: Style } | "rule";

/** Draw a bordered box over the board rows; "rule" is a separator line. */
export function drawBox(rows: Line[], screen: { width: number; height: number }, title: string,
  body: BoxRow[], footer: string, shape: BoxShape = {}): void {
  const { width: w, height: h } = screen;
  const inner = boxInner(w, shape);
  const boxW = boxWidth(w, shape);
  const pad = " ".repeat(shape.pad ?? 1);
  const space: BoxRow[] = Array.from({ length: shape.padY ?? 0 }, () => ({ line: [] }));
  const x = Math.max(0, Math.floor((w - boxW) / 2));
  const [tl, tr, bl, br] = theme.corners;
  const border = (left: string, text: string, right: string, textStyle: string): Line => {
    if (!text) return [[left + "─".repeat(boxW - 2) + right, "box"]];
    return [[`${left}─ `, "box"], [text, textStyle], [` ${"─".repeat(Math.max(0, boxW - 5 - text.length))}${right}`, "box"]];
  };
  // panel background under everything, then the segment's own style, then the row's (selection)
  const row = (content: Line, style: Style = null): Line => {
    const text = sliceLine(content, 0, inner);
    const padded: Line = [...text, [" ".repeat(inner - lineLen(text)), null]];
    return [[`│${pad}`, "box"], ...padded.map(([t, s]): Segment => [t, ["panel", s, style].filter(Boolean).join("+")]),
      [`${pad}│`, "box"]];
  };

  const lines: Line[] = [
    border(tl, shorten(title, boxW - 6), tr, "boxtitle"),
    ...[...space, ...body, ...space].map((b) => (b === "rule" ? border("├", "", "┤", "box") : row(b.line, b.style ?? null))),
    border(bl, shorten(footer, boxW - 6), br, "box"),
  ];
  const y = Math.max(1, Math.floor((h - lines.length) / 3));
  lines.forEach((line, i) => {
    if (y + i < h - 1) rows[y + i] = overlay(rows[y + i], x, line);
  });
}
