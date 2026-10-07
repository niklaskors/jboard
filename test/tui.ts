// Drives the interactive board in the test process: keys go in through the Tui's key handler as readline would
// report them, and what it draws is read back as plain text, row by row, as the terminal would show it.

import { expect, onTestFinished, vi } from "vitest";
import { Board } from "../src/board.ts";
import { Tui } from "../src/tui/app.ts";
import type { Key } from "../src/tui/dialog.ts";
import { BOARD_ID } from "./fakes/jira.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const NAMED: Record<string, Key & { str?: string }> = {
  enter: { name: "return", str: "\r" }, esc: { name: "escape", str: "\x1b" }, tab: { name: "tab", str: "\t" },
  "S-tab": { name: "tab", shift: true }, bs: { name: "backspace", str: "\x7f" }, space: { name: "space", str: " " },
  up: { name: "up" }, down: { name: "down" }, left: { name: "left" }, right: { name: "right" },
  pagedown: { name: "pagedown" }, pageup: { name: "pageup" },
};

/** A key as readline reports it: "j", "G", "<enter>", "<S-tab>", "<C-s>". */
function parseKey(spec: string): [string | undefined, Key] {
  const named = /^<(.+)>$/.exec(spec)?.[1];
  if (named?.startsWith("C-")) return [undefined, { name: named.slice(2), ctrl: true }];
  if (named) {
    const { str, ...key } = NAMED[named] ?? {};
    if (!key.name) throw new Error(`unknown key ${spec}`);
    return [str, key];
  }
  if (/^[a-z]$/.test(spec)) return [spec, { name: spec }];
  if (/^[A-Z]$/.test(spec)) return [spec, { name: spec.toLowerCase(), shift: true }];
  if (/^[0-9]$/.test(spec)) return [spec, { name: spec }];
  return [spec, {}];
}

export class Driver {
  tui: Tui;
  frames: string[];

  constructor(tui: Tui, frames: string[]) {
    this.tui = tui;
    this.frames = frames;
  }

  /** The screen as last drawn, a string per row, trailing spaces removed. */
  rows(): string[] {
    const frame = this.frames.at(-1);
    if (!frame) return [];
    return frame.split(/\x1b\[\d+;1H/).slice(1).map((row) => stripAnsi(row).trimEnd());
  }

  screen(): string {
    return this.rows().join("\n");
  }

  /** The status line at the bottom. */
  status(): string {
    return this.rows().at(-1)?.trim() ?? "";
  }

  /** The whole status message, also the part a narrow screen cuts off. */
  message(): string {
    return this.tui.msg;
  }

  /** The rows inside the dialog box on screen, without its borders. */
  box(): string[] {
    return this.rows().flatMap((row) => {
      const inside = /│(.*?)│/.exec(row)?.[1];
      return inside === undefined ? [] : [inside.trim()];
    });
  }

  /** The key of the selected card or subtask. */
  selected(): string | undefined {
    return this.tui.current()?.issue.key;
  }

  /** Press keys one after another, each handled completely (Jira calls included) before the next. */
  async press(...keys: string[]): Promise<void> {
    for (const spec of keys) {
      const [str, key] = parseKey(spec);
      await this.tui.onKey(str, key);
    }
  }

  /** Type text into whatever has the keys, a character at a time. */
  async type(text: string): Promise<void> {
    await this.press(...[...text]);
  }

  /** Wait until the screen shows this (things load in the background, as on a real board). */
  async waitFor(text: string | RegExp): Promise<void> {
    await vi.waitFor(() => {
      if (typeof text === "string") expect(this.screen()).toContain(text);
      else expect(this.screen()).toMatch(text);
    }, { timeout: 5000, interval: 10 });
  }

  /** Put the cursor on an issue, opening its story first when it is a subtask. */
  select(key: string): void {
    const story = this.tui.board.cards.find((card) => card.subs.some((sub) => sub.key === key));
    if (story) this.tui.expanded.add(story.key);
    this.tui.rebuild();
    this.tui.reselect(key);
    if (this.selected() !== key) throw new Error(`${key} is not on the board`);
    this.tui.draw();
  }
}

export function setTerminalSize(columns: number, rows: number): void {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
}

/** The board as `jboard` opens it, loaded from the fake Jira, drawn once. */
export async function openBoard({ mine = false, all = false, columns = [] as string[], width = 160, height = 40 } = {}): Promise<Driver> {
  setTerminalSize(width, height);
  const board = new Board(BOARD_ID, columns);
  await board.reload();
  const tui = new Tui(board, mine, all);
  // switching the terminal in and out of raw mode needs a real terminal; leaving it for the editor still happens
  vi.spyOn(tui, "enterScreen").mockImplementation(() => {});
  vi.spyOn(tui, "leaveScreen").mockImplementation(() => {});

  // keep what this board draws; a board of an earlier test, finishing something in the background, draws nothing
  const frames: string[] = [];
  let finished = false;
  onTestFinished(() => {
    finished = true;
  });
  const draw = tui.draw.bind(tui);
  tui.draw = () => {
    if (finished) return;
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      frames.push(String(chunk));
      return true;
    });
    try {
      draw();
    } finally {
      write.mockRestore();
    }
  };
  tui.draw();
  return new Driver(tui, frames);
}
