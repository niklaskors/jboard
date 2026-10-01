// The interactive board: navigation, drawing and key handling. Dialogs live in their own modules.

import { emitKeypressEvents } from "node:readline";
import type { Board } from "../board.ts";
import { openUrl } from "../browser.ts";
import { boardUrl, issueUrl } from "../config.ts";
import { onSignInProgress } from "../jira/client.ts";
import type { Card } from "../jira/types.ts";
import { cardWidth, columnHeaderLine, columnItems, columnWidth, decorate, GAP, headerLine, type Item } from "../render/layout.ts";
import { lineLen, place, sliceLine, type Line } from "../render/line.ts";
import { ansi, theme } from "../render/theme.ts";
import { openAssign } from "./assign.ts";
import type { Dialog, DialogHost, Key } from "./dialog.ts";
import { openPoints } from "./points.ts";
import { openStatus } from "./status.ts";
import { openSubtasks } from "./subtasks.ts";

const KEY_HINTS: [string, string][] = [
  ["hjkl", "move"], ["⏎", "subtasks"], ["s", "status"], ["A", "assign"], ["p", "points"], ["c", "new subtasks"],
  ["q", "quit"], ["e", "expand all"], ["o", "open"], ["w", "board in browser"], ["m", "mine"], ["a", "all done"], ["r", "refresh"],
];

export class Tui implements DialogHost {
  board: Board;
  mine: boolean;
  showAll: boolean;
  expanded = new Set<string>();
  sel: number[] = [];
  top: number[] = [];
  col = 0;
  colW = 20;
  msg = "";
  busy = false;
  buckets: Card[][] = [];
  hidden = 0;
  points: number[] = [];
  items: Item[][] = [];
  dialog: Dialog | null = null;
  focusKeys: string[] | null = null;

  constructor(board: Board, mine: boolean, showAll: boolean) {
    this.board = board;
    this.mine = mine;
    this.showAll = showAll;
    this.rebuild();
    this.jumpToFirstColumn();
  }

  get width(): number {
    return process.stdout.columns || 80;
  }

  get height(): number {
    return process.stdout.rows || 24;
  }

  // -- state

  rebuild(): void {
    const n = this.board.columns.length;
    this.colW = columnWidth(this.width, n);
    ({ buckets: this.buckets, hidden: this.hidden, points: this.points } = this.board.buckets(this.mine, this.showAll));
    this.items = this.buckets.map((b, i) => columnItems(this.board, b, i, cardWidth(this.colW), this.expanded));
    for (let c = 0; c < n; c++) {
      this.sel[c] = Math.min(this.sel[c] ?? 0, Math.max(0, this.items[c].length - 1));
    }
  }

  current(): Item | undefined {
    return this.items[this.col]?.[this.sel[this.col]];
  }

  /** After a rebuild, put the cursor back on the first of `keys` still shown. */
  reselect(...keys: (string | undefined)[]): void {
    for (const key of keys) {
      for (let c = 0; c < this.items.length; c++) {
        const i = this.items[c].findIndex((item) => key && item.issue.key === key);
        if (i >= 0) {
          this.col = c;
          this.sel[c] = i;
          return;
        }
      }
    }
  }

  rebuildKeepingCursor(): void {
    const cur = this.current();
    this.rebuild();
    if (cur) this.reselect(cur.issue.key, cur.parent?.key);
  }

  jumpToFirstColumn(): void {
    this.col = -1;
    this.moveCol(1);
    this.col = Math.max(this.col, 0);
  }

  // -- DialogHost

  close(): void {
    this.dialog = null;
  }

  expand(cardKey: string): void {
    this.expanded.add(cardKey);
  }

  focus(...keys: string[]): void {
    this.focusKeys = keys;
  }

  async perform(progress: string, work: () => Promise<string>, failure: (message: string) => string): Promise<void> {
    this.dialog = null;
    this.busy = true;
    this.msg = progress;
    this.draw();
    try {
      this.msg = await work();
    } catch (e) {
      this.msg = failure((e as Error).message);
    } finally {
      this.busy = false;
    }
    const focus = this.focusKeys;
    this.focusKeys = null;
    if (focus) {
      this.rebuild();
      this.reselect(...focus);
    } else {
      this.rebuildKeepingCursor();
    }
  }

  // -- actions

  moveCol(d: number): void {
    for (let c = this.col + d; c >= 0 && c < this.items.length; c += d) {
      if (this.items[c].length) {
        this.col = c;
        return;
      }
    }
  }

  move(d: number): void {
    const items = this.items[this.col];
    if (items?.length) this.sel[this.col] = Math.max(0, Math.min(items.length - 1, this.sel[this.col] + d));
  }

  toggle(): void {
    const cur = this.current();
    if (!cur) return;
    const card = cur.parent ?? (cur.issue as Card);
    if (!card.subs.length) {
      this.msg = `${card.key} has no subtasks`;
      return;
    }
    if (!this.expanded.delete(card.key)) this.expanded.add(card.key);
    this.rebuild();
    this.reselect(card.key);
  }

  toggleAll(): void {
    const cards = this.buckets.flat().filter((c) => c.subs.length);
    if (cards.some((c) => !this.expanded.has(c.key))) cards.forEach((c) => this.expanded.add(c.key));
    else this.expanded.clear();
    this.rebuildKeepingCursor();
  }

  openCurrent(): void {
    const cur = this.current();
    if (!cur) return;
    openUrl(issueUrl(cur.issue.key));
    this.msg = `opened ${cur.issue.key} in browser`;
  }

  openBoardInBrowser(): void {
    openUrl(boardUrl(this.board.boardId));
    this.msg = "opened the board in the browser · press r to reload here";
  }

  /** Open a dialog for the selected card or subtask. */
  openDialog(open: (host: DialogHost, item: Item) => Dialog | null): void {
    const cur = this.current();
    if (cur) this.dialog = open(this, cur);
  }

  toggleMine(): void {
    this.mine = !this.mine;
    this.rebuildKeepingCursor();
    if (!this.current()) this.jumpToFirstColumn();
  }

  toggleDone(): void {
    this.showAll = !this.showAll;
    this.rebuildKeepingCursor();
  }

  async refresh(): Promise<void> {
    this.busy = true;
    this.msg = "refreshing…";
    this.draw();
    try {
      await this.board.reload();
      this.msg = "refreshed";
    } catch (e) { // keep the old data on network trouble
      this.msg = `refresh failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
    this.rebuildKeepingCursor();
  }

  // -- drawing

  /** Status message, or the keys as keycaps. */
  footer(): Line {
    if (this.msg) return [[theme.icons.info ? ` ${theme.icons.info} ` : "", "accent"], [this.msg, "msg"]];
    const line: Line = [];
    for (const [key, label] of KEY_HINTS) { // as many whole hints as fit, most important first
      const hint: Line = [[` ${key} `, "key"], [` ${label}  `, "keylabel"]];
      if (lineLen(line) + lineLen(hint) > this.width) break;
      line.push(...hint);
    }
    return line;
  }

  draw(): void {
    const { width: w, height: h } = this;
    const bodyTop = 4;
    const viewH = Math.max(1, h - 5);
    const n = this.items.length;
    const rows: Line[] = Array.from({ length: h }, () => []);
    const shown = this.buckets.reduce((sum, b) => sum + b.length, 0) + this.hidden;

    rows[0] = headerLine(this.board, this.mine, shown, this.points);
    this.items.forEach((items, c) => {
      const x = c * (this.colW + GAP);
      const total = this.buckets[c].length + (c === n - 1 ? this.hidden : 0);
      place(rows[2], x, sliceLine(columnHeaderLine(this.board, c, total, this.points[c] ?? 0, c === this.col), 0, this.colW));

      // [line, selected, part of a card]
      const lines: [Line, boolean, boolean][] = [];
      let selStart = 0;
      let selEnd = 0;
      items.forEach((item, i) => {
        const isSel = i === this.sel[c];
        if (isSel) {
          selStart = lines.length;
          selEnd = selStart + item.lines.filter((l) => l.length).length - 1;
        }
        for (const line of item.lines) lines.push([line, isSel && c === this.col && line.length > 0, true]);
      });
      if (c === n - 1 && this.hidden) lines.push([[[`  +${this.hidden} more · press a`, "dim"]], false, false]);
      if (!items.length) lines.push([[["  nothing here", "empty"]], false, false]);
      while (lines.length && !lines[lines.length - 1][0].length) lines.pop(); // nothing to scroll to

      // scroll each column independently so its selection stays visible
      let top = this.top[c] ?? 0;
      if (items.length) {
        top = Math.min(top, selStart);
        top = Math.max(top, selEnd - viewH + 1);
      }
      top = Math.max(0, Math.min(top, lines.length - viewH));
      this.top[c] = top;

      let rule = "─".repeat(this.colW);
      if (top > 0) rule = `${rule.slice(0, -1)}↑`;
      if (top + viewH < lines.length) rule = `${rule.slice(0, -2)}↓${rule.slice(-1)}`;
      place(rows[3], x, [[rule, c === this.col ? `fg${c}` : `rule${c}`]]);

      lines.slice(top, top + viewH).forEach(([line, selected, isCard], r) => {
        place(rows[bodyTop + r], x, isCard ? decorate(line, c, this.colW, selected) : line);
      });
    });
    rows[h - 1] = this.footer();
    this.dialog?.draw(rows);

    // synchronized update, every row positioned explicitly and cleared to the right
    const frame = rows.map((row, y) => `\x1b[${y + 1};1H${ansi(sliceLine(row, 0, w))}\x1b[K`).join("");
    process.stdout.write(`\x1b[?2026h${frame}\x1b[?2026l`);
  }

  // -- input

  async onKey(str: string | undefined, key: Key): Promise<void> {
    if (key.ctrl && key.name === "c") process.exit(0);
    if (this.busy) return;
    this.msg = "";
    if (this.dialog) {
      await this.dialog.key(str, key);
      this.draw();
      return;
    }
    if (str === "q" || key.name === "escape") process.exit(0);
    // special keys by name, letters as typed (so g and G differ)
    const name = key.name && key.name.length > 1 ? key.name : str;
    const actions: Record<string, () => void | Promise<void>> = {
      h: () => this.moveCol(-1), left: () => this.moveCol(-1),
      l: () => this.moveCol(1), right: () => this.moveCol(1),
      j: () => this.move(1), down: () => this.move(1),
      k: () => this.move(-1), up: () => this.move(-1),
      g: () => this.move(-1e6), G: () => this.move(1e6),
      return: () => this.toggle(), enter: () => this.toggle(), space: () => this.toggle(),
      e: () => this.toggleAll(), o: () => this.openCurrent(), w: () => this.openBoardInBrowser(),
      r: () => this.refresh(), m: () => this.toggleMine(), a: () => this.toggleDone(),
      s: () => this.openDialog(openStatus), A: () => this.openDialog(openAssign),
      p: () => this.openDialog(openPoints), c: () => this.openDialog(openSubtasks),
    };
    const action = name ? actions[name] : undefined;
    if (!action) return;
    await action();
    this.draw();
  }

  start(): void {
    const { stdin, stdout } = process;
    // alternate screen, hidden cursor, no line wrapping; undone on any exit
    stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l");
    process.on("exit", () => {
      stdin.setRawMode(false);
      stdout.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
    });
    // readline only reads escapeCodeTimeout from its interface argument; 50ms makes esc quit promptly
    emitKeypressEvents(stdin, { escapeCodeTimeout: 50 } as never);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", (str: string | undefined, key: Key) => void this.onKey(str, key));
    onSignInProgress((message) => {
      this.msg = message;
      this.draw();
    });
    stdout.on("resize", () => {
      this.rebuildKeepingCursor();
      this.draw();
    });
    this.draw();
  }
}
