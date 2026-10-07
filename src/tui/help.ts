// `?`: every key, in a box over the board.

import type { Line } from "../render/line.ts";
import { boxInner, drawBox, type BoxRow, type Dialog, type DialogHost, type Key } from "./dialog.ts";

const KEYS: [string, [string, string][]][] = [
  ["Move", [
    ["h j k l", "between columns and cards"],
    ["← ↓ ↑ →", "the same"],
    ["g  G", "top / bottom of the column"],
    ["^d  ^u", "half a screen down / up (also page down / up)"],
    ["/", "search key or summary: ^n ^p next / previous, ⏎ keep, esc back"],
    ["^n  ^p", "after a search: next / previous match"],
    ["⏎  space", "show or hide a story's subtasks"],
    ["e", "show or hide all subtasks"],
  ]],
  ["Selected issue", [
    ["s", "change status"],
    ["A", "assign (your team first, type to search)"],
    ["p", "story points (empty clears)"],
    ["c", "create subtasks, one per line"],
    ["d", "description (e edits it in $EDITOR)"],
    ["S", "move to a sprint or the backlog"],
    ["o", "open in the browser"],
  ]],
  ["Notifications", [
    ["n", "merged merge requests: move their issue to done"],
  ]],
  ["Bench", [
    ["b", "open its bench in a new tab (made if needed); a story asks: it or a subtask"],
    ["B", "the same, choosing the repo first"],
    ["F", "new bench, its branch made from another branch"],
    ["M", "open its bench's merge request in the browser"],
    ["D", "remove one of its benches"],
  ]],
  ["Board", [
    ["tab  ⇧tab", "next / previous sprint, or the backlog"],
    ["C", "new story, task or bug, in the backlog or a sprint"],
    ["m", "only mine"],
    ["v", "cards or a list (a line per issue), in every tab"],
    ["a", "all done cards instead of the latest 5"],
    ["w", "open the board in the browser, on the selected issue"],
    ["r", "reload from Jira"],
    ["?", "this list"],
    ["ctrl+c", "quit"],
  ]],
];

const KEY_WIDTH = Math.max(...KEYS.flatMap(([, keys]) => keys.map(([k]) => k.length))) + 2;

class HelpDialog implements Dialog {
  host: DialogHost;
  top = 0;

  constructor(host: DialogHost) {
    this.host = host;
  }

  rows(): BoxRow[] {
    const width = boxInner(this.host.width) - KEY_WIDTH;
    const rows: BoxRow[] = [];
    KEYS.forEach(([section, keys], i) => {
      if (i) rows.push({ line: [] });
      rows.push({ line: [[section, "bold"]] });
      for (const [key, what] of keys) {
        const line: Line = [[key.padEnd(KEY_WIDTH), "accent"], [what.length > width ? `${what.slice(0, width - 1)}…` : what, null]];
        rows.push({ line });
      }
    });
    return rows;
  }

  /** Rows that fit between the box's borders, leaving the header and status line free. */
  visible(): number {
    return Math.max(3, this.host.height - 6);
  }

  key(str: string | undefined, key: Key): void {
    const max = Math.max(0, this.rows().length - this.visible());
    if (key.name === "escape" || str === "?") this.host.close();
    else if (str === "j" || key.name === "down") this.top = Math.min(max, this.top + 1);
    else if (str === "k" || key.name === "up") this.top = Math.max(0, this.top - 1);
  }

  draw(rows: Line[]): void {
    const all = this.rows();
    const shown = all.slice(this.top, this.top + this.visible());
    const scroll = all.length > shown.length ? "j/k scroll · " : "";
    drawBox(rows, this.host, "Keys", shown, `${scroll}? or esc close`);
  }
}

export const openHelp = (host: DialogHost): Dialog => new HelpDialog(host);
