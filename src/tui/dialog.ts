// Dialogs: modal boxes over the board that take all keys until they close.

import type { Board } from "../board.ts";
import { lineLen, overlay, shorten, sliceLine, type Line, type Segment, type Style } from "../render/line.ts";
import { theme } from "../render/theme.ts";

/** A key press as Node's readline reports it. */
export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
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
  /** Show a card's subtasks after the change. */
  expand(cardKey: string): void;
  /** Put the cursor on the first of these issues after the change, instead of where it was. */
  focus(...keys: string[]): void;
}

/** A printable character typed into a text field. */
export const isTyping = (str: string | undefined, key: Key) =>
  !!str && str.length === 1 && str >= " " && !key.ctrl && !key.meta;

/** Width available for text inside a dialog box. */
export const boxInner = (width: number) => Math.min(64, width - 4) - 4;

export type BoxRow = { line: Line; style?: Style } | "rule";

/** Draw a bordered box over the board rows; "rule" is a separator line. */
export function drawBox(rows: Line[], screen: { width: number; height: number }, title: string,
  body: BoxRow[], footer: string): void {
  const { width: w, height: h } = screen;
  const inner = boxInner(w);
  const boxW = inner + 4;
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
    return [["│ ", "box"], ...padded.map(([t, s]): Segment => [t, ["panel", s, style].filter(Boolean).join("+")]), [" │", "box"]];
  };

  const lines: Line[] = [
    border(tl, shorten(title, boxW - 6), tr, "boxtitle"),
    ...body.map((b) => (b === "rule" ? border("├", "", "┤", "box") : row(b.line, b.style ?? null))),
    border(bl, shorten(footer, boxW - 6), br, "box"),
  ];
  const y = Math.max(1, Math.floor((h - lines.length) / 3));
  lines.forEach((line, i) => {
    if (y + i < h - 1) rows[y + i] = overlay(rows[y + i], x, line);
  });
}
