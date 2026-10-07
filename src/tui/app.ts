// The interactive board: navigation, drawing and key handling. Dialogs live in their own modules.

import { emitKeypressEvents } from "node:readline";
import { benchedIssues, branchHasKey, listBenches, type Benched } from "../bench.ts";
import type { Board } from "../board.ts";
import { openUrl } from "../browser.ts";
import { boardUrl, issueUrl } from "../config.ts";
import { startAskpass } from "../askpass.ts";
import { onSignInProgress } from "../jira/client.ts";
import { openSprints } from "../jira/api.ts";
import type { Card, Issue, Sprint } from "../jira/types.ts";
import { notifications, type Notification } from "../notify.ts";
import { cardWidth, columnHeaderLine, columnItems, columnWidth, decorate, GAP, headerLine, tabsLine, type Item } from "../render/layout.ts";
import { lineLen, overlay, place, sliceLine, type Line } from "../render/line.ts";
import { ansi, columnSlot, shade, theme } from "../render/theme.ts";
import { openAssign } from "./assign.ts";
import { benchChoices, openBaseBranch, openBenchIssue, openBenchRepo, openMergeRequest, openRemoveBench, startBench } from "./bench.ts";
import { openCreate } from "./create.ts";
import { openDescription } from "./description.ts";
import type { Dialog, DialogHost, Key } from "./dialog.ts";
import { openHelp } from "./help.ts";
import { openNotifications } from "./notifications.ts";
import { openPoints } from "./points.ts";
import { PromptDialog } from "./prompt.ts";
import { Search } from "./search.ts";
import { openSprint } from "./sprint.ts";
import { openStatus } from "./status.ts";
import { openSubtasks } from "./subtasks.ts";

/** How often merge requests are looked up again while the board is open, to notice merges. */
const MR_POLL_MS = 30 * 60_000;

/** Rows above the cards: tabs, a blank line, sprint stats, a blank line, column headers and their rules. */
const BODY_TOP = 6;

const KEY_HINTS: [string, string][] = [
  ["?", "keys"], ["/", "search"], ["n", "notifications"], ["⇥", "next sprint"], ["hjkl", "move"], ["⏎", "subtasks"], ["s", "status"], ["A", "assign"], ["p", "points"], ["c", "new subtasks"], ["C", "new issue"], ["S", "move to sprint"],
  ["d", "description"], ["b", "bench"], ["^C", "quit"], ["e", "expand all"], ["o", "open"], ["w", "board in browser"], ["m", "mine"], ["v", "list view"], ["a", "all done"], ["r", "refresh"],
  ["D", "remove bench"],
];

/** A tab on top: one of the board's open sprints, or the backlog (no sprint); its board is loaded when first shown. */
interface Tab {
  sprint: Sprint | null;
  board: Board | null;
}

const tabKey = (tab: Tab) => (tab.sprint ? String(tab.sprint.id) : "backlog");

export class Tui implements DialogHost {
  /** What is shown: one of the sprints, or the backlog. */
  board: Board;
  /** The active sprint, where notifications come from. */
  sprint: Board;
  tabs: Tab[];
  tab = 0;
  /** Per tab, the issue the cursor was on, to come back to. */
  cursors = new Map<string, string>();
  /** Every tab as a list, a line per issue, instead of cards; until v is pressed, only the backlog is. */
  compactAll: boolean | null = null;
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
  benched: Benched = new Map();
  benchLookups = 0;
  search = new Search(this);
  /** Questions from ssh or git while bench runs, asked one at a time over everything else. */
  prompts: PromptDialog[] = [];

  constructor(board: Board, mine: boolean, showAll: boolean) {
    this.board = board;
    this.sprint = board;
    this.tabs = [{ sprint: board.sprint, board }, { sprint: null, board: null }];
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
    const compact = this.compact();
    this.items = this.buckets.map((b, i) => columnItems(this.board, b, i, cardWidth(this.colW), this.expanded, this.benched, compact));
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

  changed(): void {
    this.rebuildKeepingCursor();
  }

  /** Merged merge requests of issues that aren't done yet, not handled before. */
  notifications(): Notification[] {
    return notifications(this.sprint, this.benched); // the sprint's, also while the backlog is shown
  }

  expand(cardKey: string): void {
    this.expanded.add(cardKey);
  }

  focus(...keys: string[]): void {
    this.focusKeys = keys;
  }

  /** Mark the cards that have a bench, without holding up the board: first the benches, then their merge requests. */
  showBenches(): void {
    const lookup = ++this.benchLookups;
    const show = (benched: Benched) => {
      if (lookup !== this.benchLookups) return; // a newer lookup is under way
      const known = new Set(this.notifications().map((n) => n.mr.url));
      this.benched = benched;
      const fresh = this.notifications().filter((n) => !known.has(n.mr.url));
      if (fresh.length && !this.dialog && !this.busy) {
        this.msg = fresh.length === 1 ? `${fresh[0].issue.key}: ${fresh[0].mr.id} was merged · press n to move it to done`
          : `${fresh.length} merge requests were merged · press n`;
      }
      this.rebuildKeepingCursor();
      if (!this.busy) this.draw();
    };
    const keys = this.views().flatMap((b) => b.keys());
    void listBenches({ keys }).then((benches) => {
      // keep merge requests already known until the slower lookup brings fresh ones
      const quick = benchedIssues(benches, keys);
      for (const [key, mark] of this.benched) {
        if (!mark.mr) continue;
        const now = quick.get(key);
        if (now) now.mr ??= mark.mr;
        else if (benches.some((b) => branchHasKey(b.branch, key))) quick.set(key, { bench: false, mr: mark.mr });
      }
      show(quick);
      return listBenches({ mrs: true, keys });
    }).then((benches) => show(benchedIssues(benches, keys)));
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

  /** Ask a question from ssh or git (see askpass.ts); resolves to the answer, or null when cancelled. */
  ask(prompt: string, secret: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      const dialog = new PromptDialog(this, prompt, secret, (answer) => {
        this.prompts = this.prompts.filter((p) => p !== dialog);
        resolve(answer);
      });
      this.prompts.push(dialog);
      this.draw();
    });
  }

  /** Rows of cards on screen. */
  viewHeight(): number {
    return Math.max(1, this.height - BODY_TOP - 1);
  }

  /** ctrl+d / ctrl+u: half a screen down or up, counted in issues of the selected one's height. */
  halfPage(d: number): void {
    const height = this.current()?.lines.length || 1;
    this.move(d * Math.max(1, Math.floor(this.viewHeight() / 2 / height)));
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

  /**
   * b / B / F: the selected issue's bench; B chooses the repo first, F the repo and the branch to start from.
   * A subtask gets its own; on a story with subtasks, choose the story or one of them first.
   */
  async benchCurrent(how: "open" | "repo" | "from"): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    const forIssue = async (issue: Issue) => {
      if (how === "repo") this.dialog = openBenchRepo(this, issue);
      else if (how === "from") this.dialog = openBenchRepo(this, issue, (repo) => {
        this.dialog = openBaseBranch(this, issue, repo);
      });
      else await startBench(this, issue);
    };
    const choices = benchChoices(cur);
    if (choices.length > 1) this.dialog = openBenchIssue(this, cur.issue, choices, forIssue);
    else await forIssue(cur.issue);
  }

  toggleMine(): void {
    this.mine = !this.mine;
    this.rebuildKeepingCursor();
    if (!this.current()) this.jumpToFirstColumn();
  }

  /** Whether the tab shown is a list rather than cards. */
  compact(): boolean {
    return this.compactAll ?? this.board.kind === "backlog";
  }

  /** v: cards, or a line per issue, in every tab. */
  toggleCompact(): void {
    this.compactAll = !this.compact();
    this.rebuildKeepingCursor();
  }

  toggleDone(): void {
    this.showAll = !this.showAll;
    this.rebuildKeepingCursor();
  }

  /** The sprints and the backlog loaded so far. */
  views(): Board[] {
    return this.tabs.flatMap((t) => (t.board ? [t.board] : []));
  }

  async reload(): Promise<void> {
    await Promise.all(this.views().map((b) => b.reload()));
    this.showBenches();
  }

  /** Fill the tabs with the board's open sprints, in the background; until then there are the active one and the backlog. */
  loadTabs(): void {
    void openSprints(this.sprint.boardId).then((sprints) => {
      const loaded = new Map(this.tabs.map((t) => [tabKey(t), t.board]));
      const shown = tabKey(this.tabs[this.tab]);
      this.tabs = [...sprints.map((sprint): Tab => ({ sprint, board: null })), { sprint: null, board: null }];
      for (const t of this.tabs) t.board = loaded.get(tabKey(t)) ?? null;
      this.tab = Math.max(0, this.tabs.findIndex((t) => tabKey(t) === shown));
      if (!this.busy) this.draw();
    }, () => {}); // keep the tabs there are
  }

  /** Tab / shift+tab: show the next or previous sprint, or the backlog; each is loaded the first time. */
  async switchView(d: number): Promise<void> {
    const cur = this.current();
    if (cur) this.cursors.set(tabKey(this.tabs[this.tab]), cur.issue.key);
    const next = (this.tab + d + this.tabs.length) % this.tabs.length;
    const tab = this.tabs[next];
    if (!tab.board) {
      this.busy = true;
      this.msg = `loading ${tab.sprint?.name ?? "the backlog"}…`;
      this.draw();
      try {
        const board = this.sprint.view(tab.sprint?.id ?? null);
        await board.reload();
        tab.board = board;
        this.showBenches();
        this.msg = "";
      } catch (e) {
        this.msg = `loading ${tab.sprint?.name ?? "the backlog"} failed: ${(e as Error).message}`;
        return;
      } finally {
        this.busy = false;
      }
    }
    this.tab = next;
    this.board = tab.board;
    this.col = 0;
    this.sel = [];
    this.top = [];
    this.rebuild();
    const back = this.cursors.get(tabKey(tab));
    if (back) this.reselect(back);
    if (!this.current()) this.jumpToFirstColumn();
  }

  async refresh(): Promise<void> {
    this.busy = true;
    this.msg = "refreshing…";
    this.draw();
    try {
      await this.reload();
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
    if (this.search.active) return this.search.line();
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
    // tabs, a blank line, sprint stats, a blank line, column headers, their rules, cards, status line
    const bodyTop = BODY_TOP;
    const viewH = this.viewHeight();
    const n = this.items.length;
    const rows: Line[] = Array.from({ length: h }, () => []);
    const shown = this.buckets.reduce((sum, b) => sum + b.length, 0) + this.hidden;

    rows[0] = tabsLine(this.tabs.map((t) => t.sprint?.name ?? "Backlog"), this.tab, w - 10); // room for the bell
    rows[2] = headerLine(this.board, this.mine, shown, this.points);
    this.items.forEach((items, c) => {
      const x = c * (this.colW + GAP);
      const slot = columnSlot(c, n);
      const total = this.buckets[c].length + (c === n - 1 ? this.hidden : 0);
      place(rows[4], x, sliceLine(columnHeaderLine(this.board, c, total, this.points[c] ?? 0, c === this.col), 0, this.colW));

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
      place(rows[5], x, [[rule, c === this.col ? `fg${slot}` : `rule${slot}`]]);

      lines.slice(top, top + viewH).forEach(([line, selected, isCard], r) => {
        place(rows[bodyTop + r], x, isCard ? decorate(line, slot, this.colW, selected) : line);
      });
    });
    if (this.dialog || this.prompts.length) rows.forEach((row, y) => (rows[y] = shade(row))); // focus on the dialog
    // the bell top right, also behind a dialog: n opens the notifications
    const count = this.notifications().length;
    const bell: Line = count ? [[` ${theme.icons.bell} ${count} `, "alert"], [" ", null]] : [[`${theme.icons.bell}  `, "dim"]];
    rows[0] = overlay(rows[0], Math.max(0, w - lineLen(bell)), bell);
    rows[h - 1] = this.footer();
    this.dialog?.draw(rows);
    this.prompts[0]?.draw(rows);

    // synchronized update, every row positioned explicitly and cleared to the right
    const frame = rows.map((row, y) => `\x1b[${y + 1};1H${ansi(sliceLine(row, 0, w))}\x1b[K`).join("");
    process.stdout.write(`\x1b[?2026h${frame}\x1b[?2026l`);
  }

  // -- input

  async onKey(str: string | undefined, key: Key): Promise<void> {
    if (key.ctrl && key.name === "c") process.exit(0);
    if (this.prompts.length) { // also while busy: bench waits for the answer
      this.prompts[0].key(str, key);
      this.draw();
      return;
    }
    if (this.busy) return;
    this.msg = "";
    if (this.dialog) {
      await this.dialog.key(str, key);
      this.draw();
      return;
    }
    if (this.search.active) {
      this.search.key(str, key);
      this.draw();
      return;
    }
    if (key.ctrl) { // ctrl+letter arrives as a control character, so by name
      const ctrl: Record<string, () => void> = {
        d: () => this.halfPage(1), u: () => this.halfPage(-1),
        n: () => (this.msg = this.search.next(1)), p: () => (this.msg = this.search.next(-1)),
      };
      ctrl[key.name ?? ""]?.();
      this.draw();
      return;
    }
    // special keys by name, letters as typed (so g and G differ)
    const name = key.name && key.name.length > 1 ? key.name : str;
    const actions: Record<string, () => void | Promise<void>> = {
      h: () => this.moveCol(-1), left: () => this.moveCol(-1),
      l: () => this.moveCol(1), right: () => this.moveCol(1),
      j: () => this.move(1), down: () => this.move(1),
      k: () => this.move(-1), up: () => this.move(-1),
      g: () => this.move(-1e6), G: () => this.move(1e6),
      pagedown: () => this.halfPage(1), pageup: () => this.halfPage(-1),
      "/": () => this.search.start(),
      return: () => this.toggle(), enter: () => this.toggle(), space: () => this.toggle(),
      e: () => this.toggleAll(), o: () => this.openCurrent(), w: () => this.openBoardInBrowser(),
      r: () => this.refresh(), m: () => this.toggleMine(), a: () => this.toggleDone(), v: () => this.toggleCompact(),
      s: () => this.openDialog(openStatus), A: () => this.openDialog(openAssign),
      p: () => this.openDialog(openPoints), c: () => this.openDialog(openSubtasks),
      d: () => this.openDialog(openDescription),
      "?": () => {
        this.dialog = openHelp(this);
      },
      b: () => this.benchCurrent("open"), B: () => this.benchCurrent("repo"), F: () => this.benchCurrent("from"), D: () => this.openDialog(openRemoveBench),
      M: () => this.openDialog(openMergeRequest),
      tab: () => this.switchView(key.shift ? -1 : 1),
      S: () => this.openDialog(openSprint),
      C: () => {
        this.dialog = openCreate(this);
      },
      n: () => {
        this.dialog = openNotifications(this, this.sprint, () => this.notifications());
      },
    };
    const action = name ? actions[name] : undefined;
    if (!action) return;
    await action();
    this.draw();
  }

  /** Alternate screen, hidden cursor, no line wrapping, keys one by one. */
  enterScreen(): void {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l");
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  leaveScreen(): void {
    process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
  }

  outside<T>(run: () => T): T {
    this.leaveScreen();
    process.stdin.pause(); // the program gets the keys
    try {
      return run();
    } finally {
      this.enterScreen();
      this.draw();
    }
  }

  start(): void {
    const { stdin, stdout } = process;
    this.enterScreen();
    process.on("exit", () => this.leaveScreen()); // undone on any exit
    // readline only reads escapeCodeTimeout from its interface argument; 50ms makes esc close dialogs promptly
    emitKeypressEvents(stdin, { escapeCodeTimeout: 50 } as never);
    stdin.on("keypress", (str: string | undefined, key: Key) => void this.onKey(str, key));
    startAskpass((prompt, secret) => this.ask(prompt, secret));
    onSignInProgress((message) => {
      this.msg = message;
      this.draw();
    });
    stdout.on("resize", () => {
      this.rebuildKeepingCursor();
      this.draw();
    });
    this.draw();
    this.showBenches();
    this.loadTabs();
    setInterval(() => { // notice merges while the board is open
      if (!this.busy) this.showBenches();
    }, MR_POLL_MS).unref();
  }
}
