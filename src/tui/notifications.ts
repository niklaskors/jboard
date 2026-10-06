// `n`: the notifications: issues whose merge request was merged, each with moving it to done as the suggested action.

import type { Board } from "../board.ts";
import { openUrl } from "../browser.ts";
import { loadTransitions, transitionIssue } from "../jira/api.ts";
import type { Transition } from "../jira/types.ts";
import { markHandled, type Notification } from "../notify.ts";
import { shorten, type Line } from "../render/line.ts";
import { boxInner, drawBox, type BoxRow, type Dialog, type DialogHost, type Key } from "./dialog.ts";
import { rejects } from "./status.ts";

const SHAPE = { max: 96, pad: 2, padY: 1 };

class NotificationsDialog implements Dialog {
  host: DialogHost;
  board: Board; // the sprint, also while the backlog is shown
  list: () => Notification[];
  sel = 0;
  status = "";
  working = false;

  constructor(host: DialogHost, board: Board, list: () => Notification[]) {
    this.host = host;
    this.board = board;
    this.list = list;
  }

  /** The last column, where merged work goes. */
  get done() {
    const { columns } = this.board;
    return columns[columns.length - 1];
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    if (this.working) return;
    const list = this.list();
    const n = list[this.sel];
    this.status = "";
    if (key.name === "escape" || str === "n" || str === "q") this.host.close();
    else if (str === "j" || key.name === "down") this.sel = Math.min(list.length - 1, this.sel + 1);
    else if (str === "k" || key.name === "up") this.sel = Math.max(0, this.sel - 1);
    else if (!n) return;
    else if (key.name === "return" || key.name === "enter" || str === "y") await this.moveToDone(n);
    else if (str === "x") {
      markHandled(n);
      this.status = `dismissed ${n.issue.key}`;
    } else if (str === "o") {
      openUrl(n.mr.url);
      this.status = `opened ${n.mr.id} in the browser`;
    }
    if (n && !this.list().length) { // the last one was just handled
      this.host.close();
      this.host.msg = this.status || "no more notifications";
    }
  }

  /** The step to the done column, preferring one called done or resolved; never a rejection. */
  doneStep(transitions: Transition[]): Transition | undefined {
    const steps = transitions.filter((t) => this.done.statuses.has(t.to.id) && !rejects(t));
    return steps.find((t) => /done|resolv/i.test(t.to.name)) ?? steps[0];
  }

  async moveToDone(n: Notification): Promise<void> {
    const { issue } = n;
    this.working = true;
    this.status = `moving ${issue.key} to ${this.done.name}…`;
    this.host.draw();
    try {
      const step = this.doneStep(await loadTransitions(issue.key));
      if (!step) {
        this.status = `${issue.key} can't go from ${issue.fields.status.name} to ${this.done.name} in one step: use s on its card`;
        return;
      }
      await transitionIssue(issue.key, step.id);
      issue.fields.status = { id: step.to.id, name: step.to.name };
      issue.fields.updated = new Date().toISOString(); // shows first among the done cards
      markHandled(n);
      this.host.changed();
      this.status = `${issue.key} is now ${step.to.name}`;
    } catch (e) {
      const message = (e as Error).message;
      this.status = `moving ${issue.key} failed: ${message}${message.includes("HTTP 400") ? " (needs extra fields? press o on its card)" : ""}`;
    } finally {
      this.working = false;
    }
  }

  draw(rows: Line[]): void {
    const inner = boxInner(this.host.width, SHAPE);
    const list = this.list();
    this.sel = Math.max(0, Math.min(this.sel, list.length - 1));
    const visible = Math.max(1, Math.floor((this.host.height - 10) / 2));
    const top = Math.max(0, Math.min(this.sel - Math.floor(visible / 2), list.length - visible));

    const body: BoxRow[] = [];
    if (!list.length) body.push({ line: [["nothing new: merged merge requests of issues that aren't done show up here", "dim"]] });
    list.slice(top, top + visible).forEach(({ issue, mr }, i) => {
      const style = top + i === this.sel ? "rev" : null;
      const head = `${issue.key}  ${mr.id} merged`;
      const now = `now ${issue.fields.status.name} → ${this.done.name}`;
      body.push(
        { line: [[head, "bold"], [" ".repeat(Math.max(1, inner - head.length - now.length)), null], [now, "dim"]], style },
        { line: [[shorten(issue.fields.summary, inner), null]], style },
      );
    });
    if (list.length > visible) body.push({ line: [[`${list.length} in all · j/k for more`, "dim"]] });
    if (this.status) body.push("rule", { line: [[shorten(this.status, inner), "dim"]] });
    const footer = list.length ? `⏎ move to ${this.done.name} · x dismiss · o open MR · esc close` : "esc close";
    drawBox(rows, this.host, `Merged (${list.length})`, body, footer, SHAPE);
  }
}

export const openNotifications = (host: DialogHost, board: Board, list: () => Notification[]): Dialog =>
  new NotificationsDialog(host, board, list);
