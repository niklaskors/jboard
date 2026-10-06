// `/`: search the shown tab by key or summary, jumping to matches as you type. Not a dialog: the board stays in view.

import type { Card, Issue } from "../jira/types.ts";
import type { Item } from "../render/layout.ts";
import type { Line } from "../render/line.ts";
import { isTyping, type Key } from "./dialog.ts";

/** What search needs from the board (implemented by the Tui). */
export interface SearchHost {
  readonly buckets: Card[][];
  readonly expanded: Set<string>;
  current(): Item | undefined;
  rebuild(): void;
  reselect(...keys: (string | undefined)[]): void;
}

interface Match {
  key: string;
  parent: string | null; // a subtask's story, opened to show it
}

/** Every issue shown in the tab, cards and their subtasks, in the order they appear. */
function issuesInOrder(buckets: Card[][]): { issue: Issue; parent: string | null }[] {
  return buckets.flat().flatMap((card) => [
    { issue: card, parent: null },
    ...card.subs.map((issue) => ({ issue, parent: card.key })),
  ]);
}

export class Search {
  host: SearchHost;
  query = "";
  /** Typing a query; false once it is kept with enter, for ctrl+n / ctrl+p from the board. */
  active = false;
  /** Where the search started: where esc goes back to, and where matches are counted from. */
  from: string | undefined;
  /** A story opened to show a matching subtask, closed again when the search moves on. */
  opened: string | null = null;
  index = -1; // of the current match

  constructor(host: SearchHost) {
    this.host = host;
  }

  matches(): Match[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return [];
    return issuesInOrder(this.host.buckets)
      .filter(({ issue }) => `${issue.key} ${issue.fields.summary}`.toLowerCase().includes(q))
      .map(({ issue, parent }) => ({ key: issue.key, parent }));
  }

  start(): void {
    this.active = true;
    this.query = "";
    this.from = this.host.current()?.issue.key;
    this.opened = null;
    this.index = -1;
  }

  /** The first match at or after `key` (wrapping around), or the first one. */
  firstFrom(key: string | undefined, matches: Match[]): number {
    const order = issuesInOrder(this.host.buckets).map(({ issue }) => issue.key);
    const at = key ? order.indexOf(key) : 0;
    const i = matches.findIndex((m) => order.indexOf(m.key) >= at);
    return matches.length ? Math.max(0, i) : -1;
  }

  jump(matches: Match[], index: number): void {
    this.index = index;
    const match = matches[index];
    if (this.opened && this.opened !== match?.parent) {
      this.host.expanded.delete(this.opened);
      this.opened = null;
    }
    if (match?.parent && !this.host.expanded.has(match.parent)) {
      this.host.expanded.add(match.parent);
      this.opened = match.parent;
    }
    this.host.rebuild();
    this.host.reselect(match?.key ?? this.from);
  }

  /** ctrl+n / ctrl+p, while typing or after: the next or previous match, from the cursor. */
  next(d: number): string {
    const matches = this.matches();
    if (!matches.length) return this.query ? `no match for "${this.query}"` : "nothing searched yet: press /";
    const cur = this.host.current()?.issue.key;
    let i = matches.findIndex((m) => m.key === cur);
    i = i < 0 ? this.firstFrom(cur, matches) - (d > 0 ? 1 : 0) : i;
    if (!this.active) this.opened = null; // after the search, stories it opened stay open
    this.jump(matches, (i + d + matches.length) % matches.length);
    return `${this.index + 1}/${matches.length} for "${this.query}"`;
  }

  /** A key while typing the query; returns whether the search is still being typed. */
  key(str: string | undefined, key: Key): boolean {
    if (key.name === "escape") { // back to where it started
      this.query = "";
      this.jump([], -1);
      this.active = false;
    } else if (key.name === "return" || key.name === "enter") {
      this.active = false;
    } else if ((key.ctrl && key.name === "n") || key.name === "down") {
      if (this.matches().length) this.next(1);
    } else if ((key.ctrl && key.name === "p") || key.name === "up") {
      if (this.matches().length) this.next(-1);
    } else if (key.name === "backspace" || isTyping(str, key)) {
      this.query = key.name === "backspace" ? this.query.slice(0, -1) : this.query + str;
      const matches = this.matches();
      this.jump(matches, this.firstFrom(this.from, matches));
    }
    return this.active;
  }

  /** The status line while typing. */
  line(): Line {
    const count = this.matches().length;
    const found = !this.query ? "type a key or part of a summary"
      : count ? `${this.index + 1}/${count}` : "no match";
    return [[" / ", "key"], [" ", null], [this.query, "msg"], ["█", "dim"], [`  ${found}`, count || !this.query ? "dim" : "warn"],
      ["   ⏎ keep · ctrl+n/p next/previous · esc back", "keylabel"]];
  }
}
