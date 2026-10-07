// `jboard --create SUMMARY`: a small wizard that creates one issue, for other tools such as punch. Step by step it
// asks the project (only when the board has several), the type, and where it goes, then the summary, typed in
// already. It draws on the terminal itself (/dev/tty), so whoever runs it reads the new key from stdout:
// key=$(jboard --create "Export to CSV").

import { openSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";
import { boardProjects, createIssue, issueTypes, moveToSprint, openSprints, type IssueType, type Project } from "../jira/api.ts";
import { JiraError } from "../jira/client.ts";
import type { Sprint } from "../jira/types.ts";
import { typeIcon } from "../render/layout.ts";
import { lineLen, shorten, sliceLine, type Line, type Segment } from "../render/line.ts";
import { ansi, theme } from "../render/theme.ts";
import { creatable } from "./create.ts";
import { boxInner, drawBox, isTyping, type BoxRow, type Key } from "./dialog.ts";

const SHAPE = { max: 72, pad: 2, padY: 1 };

type Step = "project" | "type" | "where" | "summary";
const STEP_NAMES: Record<Step, string> = { project: "Project", type: "Type", where: "Where", summary: "Summary" };

/** Where the wizard draws: a terminal's size, and its output. */
export interface Screen {
  columns: number;
  rows: number;
  write(data: string): unknown;
}

export interface Created {
  key: string;
  /** What went wrong after it was created, e.g. moving it to the sprint; "" when nothing did. */
  warning: string;
}

interface Choice {
  label: Line;
  note: string;
}

export class CreateWizard {
  screen: Screen;
  boardId: string;
  finish: (created: Created | null) => void;
  projects: Project[] = [];
  project = 0;
  types: IssueType[] = [];
  type = 0;
  /** The backlog (null), then the open sprints; the backlog is the default, as with C on the board. */
  sprints: (Sprint | null)[] = [null];
  sprint = 0;
  summary: string;
  step: Step = "type";
  status = "loading…";
  /** Loading or creating: keys wait, apart from esc. */
  busy = true;
  creating = false;
  finished = false;

  constructor(screen: Screen, boardId: string, summary: string, finish: (created: Created | null) => void) {
    this.screen = screen;
    this.boardId = boardId;
    this.summary = summary.replace(/\s+/g, " ").trim();
    this.finish = finish;
    boardProjects(boardId).then(async (projects) => {
      if (!projects.length) throw new Error(`board ${boardId} has no project to create issues in`);
      this.projects = projects;
      if (projects.length > 1) {
        this.step = "project";
        this.busy = false;
        this.status = "";
        this.draw();
      } else await this.loadTypes();
    }).catch((e: Error) => {
      this.busy = false;
      this.status = `loading the board's projects failed: ${e.message}`;
      this.draw();
    });
    openSprints(boardId).then((sprints) => {
      this.sprints = [null, ...sprints];
      this.draw();
    }, () => {}); // without them it goes in the backlog
  }

  /** The steps there are: the project only when there is a choice. */
  get steps(): Step[] {
    return this.projects.length > 1 ? ["project", "type", "where", "summary"] : ["type", "where", "summary"];
  }

  /** The option selected in the step shown. */
  get sel(): number {
    return this.step === "project" ? this.project : this.step === "type" ? this.type : this.sprint;
  }

  set sel(i: number) {
    if (this.step === "project") this.project = i;
    else if (this.step === "type") this.type = i;
    else this.sprint = i;
  }

  done(created: Created | null): void {
    if (this.finished) return;
    this.finished = true;
    this.finish(created);
  }

  /** The chosen project's issue types; false when it has none to create. */
  async loadTypes(): Promise<boolean> {
    const project = this.projects[this.project].key;
    this.busy = true;
    this.status = `loading the issue types of ${project}…`;
    this.draw();
    try {
      this.types = creatable(await issueTypes(project));
      this.type = 0;
      this.status = this.types.length ? "" : `project ${project} has no issue types to create`;
    } catch (e) {
      this.types = [];
      this.status = `loading issue types failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
    this.draw();
    return this.types.length > 0;
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    if (key.ctrl && key.name === "c") return this.done(null);
    if (key.name === "escape") return this.back();
    if (this.busy) return;
    if (this.step === "summary") return this.summaryKey(str, key);
    const count = this.choices().length;
    const name = key.name && key.name.length > 1 ? key.name : str;
    if (name === "up" || name === "k" || (key.shift && name === "tab")) this.sel = Math.max(0, this.sel - 1);
    else if (name === "down" || name === "j" || name === "tab") this.sel = Math.min(count - 1, this.sel + 1);
    else if (name === "return" || name === "enter" || name === "right" || name === "l") await this.next();
    else if (name === "left" || name === "h") this.back();
  }

  async next(): Promise<void> {
    if (this.step === "project" && !(await this.loadTypes())) return;
    if (this.step === "type" && !this.types.length) return;
    this.step = this.steps[this.steps.indexOf(this.step) + 1];
  }

  /** One step back; from the first, cancel. */
  back(): void {
    if (this.creating) return;
    const i = this.steps.indexOf(this.step);
    if (i <= 0) return this.done(null);
    this.step = this.steps[i - 1];
    this.status = "";
  }

  async summaryKey(str: string | undefined, key: Key): Promise<void> {
    this.status = "";
    if (key.name === "return" || key.name === "enter") await this.create();
    else if (key.name === "backspace") this.summary = this.summary.slice(0, -1);
    else if (key.ctrl && key.name === "u") this.summary = "";
    else if (key.ctrl && key.name === "w") this.summary = this.summary.replace(/\S*\s*$/, "");
    else if (key.name === "left") this.back();
    else if (isTyping(str, key)) this.summary += str;
  }

  where(): string {
    return this.sprints[this.sprint]?.name ?? "the backlog";
  }

  async create(): Promise<void> {
    const summary = this.summary.trim();
    if (!summary) {
      this.status = "type a summary first";
      return;
    }
    const project = this.projects[this.project].key;
    const type = this.types[this.type];
    const sprint = this.sprints[this.sprint];
    const kind = type.name.toLowerCase();
    this.busy = this.creating = true;
    this.status = `creating a ${kind} in ${this.where()}…`;
    this.draw();
    let key: string;
    try {
      key = await createIssue(project, type.id, summary, "");
    } catch (e) {
      this.busy = this.creating = false;
      this.status = `creating the ${kind} failed: ${(e as Error).message}`;
      return;
    }
    let warning = "";
    if (sprint) {
      try {
        await moveToSprint(key, sprint.id);
      } catch (e) {
        warning = `created ${key} in the backlog, but moving it to ${sprint.name} failed: ${(e as Error).message}`;
      }
    }
    this.done({ key, warning });
  }

  /** The options of the step shown. */
  choices(): Choice[] {
    if (this.step === "project") return this.projects.map((p) => ({ label: [[p.key, null]], note: p.name }));
    if (this.step === "type") return this.types.map((t) => ({ label: [typeIcon(t.name), [` ${t.name}`, null]], note: "" }));
    return this.sprints.map((s) => ({ label: [[s?.name ?? "Backlog", null]], note: s ? s.state ?? "" : "no sprint" }));
  }

  /** The steps along the top: what was chosen in those done, the one shown highlighted, those to come dimmed. */
  trail(): Line {
    const steps = this.steps;
    const at = steps.indexOf(this.step);
    const chosen: Record<Step, () => string> = {
      project: () => this.projects[this.project]?.key ?? "",
      type: () => this.types[this.type]?.name ?? "",
      where: () => this.sprints[this.sprint]?.name ?? "Backlog",
      summary: () => "",
    };
    return steps.flatMap((step, i): Line => [
      ...(i ? [[" › ", "dim"] as Segment] : []),
      i < at ? [chosen[step](), "accent"] : i === at ? [` ${STEP_NAMES[step]} `, "rev"] : [STEP_NAMES[step], "dim"],
    ]);
  }

  draw(): void {
    if (this.finished) return;
    const width = this.screen.columns || 80;
    const height = this.screen.rows || 24;
    const inner = boxInner(width, SHAPE);
    const rows: Line[] = Array.from({ length: height }, () => []);
    rows[0] = [[theme.icons.sprint ? ` ${theme.icons.sprint} ` : "", "accent"], ["jboard", "title"], ["   new issue", "name"]];

    const body: BoxRow[] = [{ line: this.trail() }, "rule"];
    if (this.step === "summary") {
      const shown = this.summary.length > inner - 3 ? `…${this.summary.slice(-(inner - 4))}` : this.summary;
      const type = this.types[this.type];
      body.push(
        { line: [["› ", "dim"], [shown, null], ["█", "dim"]] },
        { line: [] },
        { line: [typeIcon(type.name), [` ${type.name} in ${this.where()}`, "dim"]] },
      );
    } else {
      const choices = this.choices();
      choices.forEach((c, i) => {
        const note = shorten(c.note, Math.floor(inner / 2) - 2);
        const label = sliceLine(c.label, 0, inner - note.length - 1);
        const gap = " ".repeat(Math.max(1, inner - lineLen(label) - note.length));
        body.push({ line: [...label, [gap, null], [note, "dim"]], style: i === this.sel ? "rev" : null });
      });
      if (!choices.length && !this.status) body.push({ line: [["nothing to choose from", "dim"]] });
    }
    if (this.status) body.push("rule", { line: [[shorten(this.status, inner), "dim"]] });

    const first = this.steps.indexOf(this.step) === 0;
    const footer = this.step === "summary" ? "⏎ create · ^U clear · esc back"
      : `↑↓ choose · ⏎ next · esc ${first ? "cancel" : "back"}`;
    const title = `New issue in ${this.step === "project" ? "…" : this.projects[this.project]?.key ?? "…"}`;
    drawBox(rows, { width, height }, title, body, footer, SHAPE);

    // as the board draws: a synchronized update, every row positioned explicitly and cleared to the right
    const frame = rows.map((row, y) => `\x1b[${y + 1};1H${ansi(sliceLine(row, 0, width))}\x1b[K`).join("");
    this.screen.write(`\x1b[?2026h${frame}\x1b[?2026l`);
  }
}

/** The terminal, also when stdin or stdout is a pipe (as when another program reads the key). */
function terminal(): { input: ReadStream; output: WriteStream; own: boolean } {
  if (process.stdin.isTTY && process.stdout.isTTY) return { input: process.stdin, output: process.stdout, own: false };
  try {
    return { input: new ReadStream(openSync("/dev/tty", "r")), output: new WriteStream(openSync("/dev/tty", "w")), own: true };
  } catch {
    throw new JiraError("--create needs a terminal to ask in");
  }
}

/** Run the wizard on the terminal; resolves with the new issue, or null when it was cancelled. */
export function runCreate(boardId: string, summary: string): Promise<Created | null> {
  const { input, output, own } = terminal();
  return new Promise((resolve) => {
    let shown = true;
    const leave = () => {
      if (!shown) return;
      shown = false;
      input.setRawMode(false);
      output.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
    };
    const wizard = new CreateWizard(output, boardId, summary, (created) => {
      leave();
      input.pause();
      if (own) {
        input.destroy();
        output.destroy();
      }
      resolve(created);
    });
    // alternate screen, hidden cursor, no line wrapping, keys one by one; undone on any exit
    output.write("\x1b[?1049h\x1b[?25l\x1b[?7l");
    input.setRawMode(true);
    process.on("exit", leave);
    // readline only reads escapeCodeTimeout from its interface argument; 50ms makes esc go back promptly
    emitKeypressEvents(input, { escapeCodeTimeout: 50 } as never);
    input.on("keypress", (str: string | undefined, key: Key | undefined) => {
      void wizard.key(str, key ?? {}).then(() => wizard.draw());
    });
    output.on("resize", () => wizard.draw());
    input.resume();
    wizard.draw();
  });
}
