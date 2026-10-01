// `c`: create subtasks under a story from a typed or pasted list, in one bulk request.

import { createSubtasks } from "../jira/api.ts";
import type { Card } from "../jira/types.ts";
import type { Item } from "../render/layout.ts";
import { shorten, type Line, type Segment } from "../render/line.ts";
import { boxInner, drawBox, isTyping, type BoxRow, type Dialog, type DialogHost, type Key } from "./dialog.ts";

/** Summaries from a typed or pasted list: one per line, bullets/numbering and blank lines dropped. */
export function subtaskSummaries(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

class SubtasksDialog implements Dialog {
  host: DialogHost;
  parent: Card;
  lines = [""];

  constructor(host: DialogHost, parent: Card) {
    this.host = host;
    this.parent = parent;
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    const last = this.lines.length - 1;
    if (key.name === "escape") {
      this.host.close();
    } else if (key.ctrl && (key.name === "s" || key.name === "d")) {
      await this.create();
    } else if (key.name === "return" || key.name === "enter") {
      this.lines.push(""); // pasted lists arrive as text + return, one line each
    } else if (key.name === "backspace") {
      if (this.lines[last]) this.lines[last] = this.lines[last].slice(0, -1);
      else if (last > 0) this.lines.pop();
    } else if (isTyping(str, key)) {
      this.lines[last] += str;
    }
  }

  async create(): Promise<void> {
    const summaries = subtaskSummaries(this.lines);
    if (!summaries.length) {
      this.host.msg = "type at least one subtask, one per line";
      return;
    }
    const { host, parent } = this;
    await host.perform(`creating ${summaries.length} subtask(s) under ${parent.key}…`, async () => {
      const { created, failed } = await createSubtasks(parent.key, summaries);
      if (created.length) {
        await host.board.reload(); // new subtasks need their full fields from Jira
        host.expand(parent.key);
        host.focus(created[0], parent.key);
      }
      return (created.length ? `created ${created.join(", ")} under ${parent.key}` : "nothing created")
        + (failed.length ? ` · failed: ${failed.map((f) => `"${shorten(f.summary, 30)}": ${f.reason}`).join("; ")}` : "");
    }, (message) => `creating subtasks failed: ${message}`);
  }

  draw(rows: Line[]): void {
    const inner = boxInner(this.host.width);
    const count = subtaskSummaries(this.lines).length;
    const visible = Math.max(1, Math.min(12, this.host.height - 10));
    const shown = this.lines.slice(-visible); // keep the line being typed in view
    const body: BoxRow[] = [{ line: [["one subtask per line · paste a list · bullets are ignored", "dim"]] }, "rule"];
    if (this.lines.length > visible) body.push({ line: [[`… ${this.lines.length - visible} more above`, "dim"]] });
    shown.forEach((text, i) => {
      const isLast = i === shown.length - 1;
      // show the end of a long line while it is being typed
      const visibleText = isLast && text.length > inner - 3 ? `…${text.slice(-(inner - 4))}` : text;
      body.push({ line: [["• ", "dim"], [visibleText, null], ...(isLast ? [["█", "dim"] as Segment] : [])] });
    });
    drawBox(rows, this.host, `New subtasks for ${this.parent.key}: ${this.parent.fields.summary}`, body,
      `⏎ new line · ctrl+s create ${count} · esc cancel`);
  }
}

export function openSubtasks(host: DialogHost, item: Item): Dialog | null {
  const parent = item.parent ?? (item.issue as Card);
  if (parent.fields.issuetype.subtask) {
    host.msg = `${parent.key} is a subtask whose story is not in this sprint`;
    return null;
  }
  return new SubtasksDialog(host, parent);
}
