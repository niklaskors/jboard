// `C`: create a story, task or bug. It is always created in the backlog, then moved to a sprint when one is chosen.

import { boardProject, createIssue, issueTypes, moveToSprint, openSprints, type IssueType } from "../jira/api.ts";
import type { Sprint } from "../jira/types.ts";
import { shorten, type Line, type Segment } from "../render/line.ts";
import { EDITOR, editInEditor } from "./description.ts";
import { boxInner, drawBox, isTyping, type BoxRow, type Dialog, type DialogHost, type Key } from "./dialog.ts";

const SHAPE = { max: 80, pad: 2, padY: 1 };

/** Stories, tasks and bugs, in that order; every other non-subtask type when a project has none of those. */
export function creatable(types: IssueType[]): IssueType[] {
  const rank = (t: IssueType) => ["story", "task", "bug"].findIndex((kind) => t.name.toLowerCase().includes(kind));
  const main = types.filter((t) => !t.subtask && rank(t) >= 0).sort((a, b) => rank(a) - rank(b));
  return main.length ? main : types.filter((t) => !t.subtask);
}

class CreateDialog implements Dialog {
  host: DialogHost;
  project: string | null = null;
  types: IssueType[] = [];
  type = 0;
  /** The backlog (null), then the open sprints; the backlog is the default. */
  sprints: (Sprint | null)[] = [null];
  sprint = 0;
  summary = "";
  description = "";
  status = "loading issue types…";

  constructor(host: DialogHost) {
    this.host = host;
    boardProject(host.board.boardId, host.board.keys()).then(async (project) => {
      this.types = creatable(await issueTypes(project));
      this.project = project;
      this.status = this.types.length ? "" : `project ${project} has no issue types to create`;
    }).catch((e: Error) => {
      this.status = `loading issue types failed: ${e.message}`;
    }).then(() => {
      if (host.dialog === this) host.draw();
    });
    openSprints(host.board.boardId).then((sprints) => {
      this.sprints = [null, ...sprints];
      if (host.dialog === this) host.draw();
    }, () => {}); // without them it goes in the backlog
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    const ready = !!this.project && this.types.length > 0;
    if (key.name === "escape") return this.host.close();
    if (!ready) return;
    this.status = "";
    if (key.name === "tab" || key.name === "right" || key.name === "left") {
      const d = key.name === "left" || key.shift ? -1 : 1;
      this.type = (this.type + d + this.types.length) % this.types.length;
    } else if (key.name === "up" || key.name === "down") {
      const d = key.name === "up" ? -1 : 1;
      this.sprint = (this.sprint + d + this.sprints.length) % this.sprints.length;
    } else if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "s")) await this.create();
    else if (key.ctrl && key.name === "e") this.editDescription();
    else if (key.name === "backspace") this.summary = this.summary.slice(0, -1);
    else if (isTyping(str, key)) this.summary += str;
  }

  editDescription(): void {
    const edited = editInEditor(this.host, "new-issue", this.description);
    if (edited === null) this.status = `${EDITOR} did not exit cleanly, the description is unchanged`;
    else {
      this.description = edited.replace(/\s+$/, "");
      this.status = "";
    }
  }

  async create(): Promise<void> {
    const summary = this.summary.trim();
    if (!summary) {
      this.status = "type a summary first";
      return;
    }
    const { project, description } = this;
    const type = this.types[this.type];
    const sprint = this.sprints[this.sprint];
    await this.host.perform(`creating a ${type.name.toLowerCase()} in the backlog…`, async () => {
      const key = await createIssue(project!, type.id, summary, description);
      let message = `created ${key} (${type.name}) in the backlog`;
      if (sprint) {
        this.host.msg = `moving ${key} to ${sprint.name}…`;
        this.host.draw();
        try {
          await moveToSprint(key, sprint.id);
          message = `created ${key} (${type.name}) in ${sprint.name}`;
        } catch (e) {
          message += `, but moving it to ${sprint.name} failed: ${(e as Error).message} (press S on it)`;
        }
      }
      await this.host.reload(); // shows it where it went, when that is shown
      this.host.focus(key);
      return message;
    }, (message) => `creating the ${type.name.toLowerCase()} failed: ${message}`);
  }

  draw(rows: Line[]): void {
    const inner = boxInner(this.host.width, SHAPE);
    const tabs: Line = [];
    this.types.forEach((t, i) => tabs.push(...(i ? [["  ", null] as Segment] : []), [` ${t.name} `, i === this.type ? "rev" : "dim"]));
    // show the end of a long summary while it is being typed
    const summary = this.summary.length > inner - 3 ? `…${this.summary.slice(-(inner - 4))}` : this.summary;
    const lines = this.description ? this.description.split("\n").length : 0;
    const sprint = this.sprints[this.sprint];
    const where = sprint?.name ?? "Backlog";
    const body: BoxRow[] = [
      { line: tabs.length ? tabs : [[this.status, "dim"]] },
      "rule",
      { line: [["› ", "dim"], [summary, null], ["█", "dim"]] },
      { line: [] },
      { line: [["sprint  ", "dim"], ["‹ ", "dim"], [where, sprint ? "accent" : null], [" ›", "dim"],
        [sprint?.state === "active" ? "  active" : sprint ? "  future" : "  no sprint", "dim"]] },
      { line: [[lines ? `description: ${lines} line${lines === 1 ? "" : "s"} · ctrl+e to change` : "no description · ctrl+e to write one in " + EDITOR.split(" ")[0], "dim"]] },
    ];
    if (tabs.length && this.status) body.push("rule", { line: [[shorten(this.status, inner), "dim"]] });
    drawBox(rows, this.host, `New issue in ${this.project ?? "…"}`, body,
      "←→ type · ↑↓ sprint · ⏎ create · ctrl+e description · esc cancel", SHAPE);
  }
}

export const openCreate = (host: DialogHost): Dialog => new CreateDialog(host);
