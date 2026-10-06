// `d`: show an issue's description, rendered or as written, and edit it in $EDITOR.

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { loadDescription, setField } from "../jira/api.ts";
import type { Issue } from "../jira/types.ts";
import type { Item } from "../render/layout.ts";
import { lineLen, sliceLine, type Line } from "../render/line.ts";
import { renderMarkup, wrapLine, type Rendered } from "../render/markup.ts";
import { boxInner, drawBox, type BoxRow, type Dialog, type DialogHost, type Key } from "./dialog.ts";

/** Whether a program is on the PATH. */
const onPath = (name: string) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

export const EDITOR = process.env.VISUAL || process.env.EDITOR || (onPath("nvim") ? "nvim" : "vi");

/** The text as written, wrapped line by line, keeping blank lines and indentation. */
function rawLines(text: string, width: number): Rendered[] {
  return text.replace(/\t/g, "  ").trimEnd().split("\n").flatMap((line) => {
    const indent = /^ */.exec(line)![0].slice(0, Math.floor(width / 2));
    return wrapLine([[line.slice(indent.length), null]], width, [[indent, null]]).map((l) => ({ line: l }));
  });
}

const SHIFT = 8; // columns per h / l
const SHAPE = { max: 100, pad: 3, padY: 1 }; // wider than other dialogs, with room around the text for reading

/** Let the user edit `text` in their editor; the edited text, or null when the editor failed. */
export function editInEditor(host: DialogHost, issueKey: string, text: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "jboard-"));
  const file = join(dir, `${issueKey}.txt`);
  try {
    writeFileSync(file, text ? `${text}\n` : "");
    // through the shell, so EDITOR may carry arguments ("code -w")
    const res = host.outside(() => spawnSync(`${EDITOR} "${file}"`, { shell: true, stdio: "inherit" }));
    if (res.error || res.status !== 0) return null;
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

class DescriptionDialog implements Dialog {
  host: DialogHost;
  issue: Issue;
  text: string | null = null; // null until loaded
  status = "loading…";
  saving = false;
  raw = false; // the markup as written instead of rendered
  top = 0;
  left = 0; // how far code is scrolled sideways
  cache: { key: string; lines: Rendered[] } | null = null;

  constructor(host: DialogHost, issue: Issue) {
    this.host = host;
    this.issue = issue;
    loadDescription(issue.key).then((text) => {
      this.text = text;
      this.status = "";
    }, (e: Error) => {
      this.status = `loading the description failed: ${e.message}`;
    }).then(() => {
      if (host.dialog === this) host.draw();
    });
  }

  lines(): Rendered[] {
    if (!this.text) return [];
    const width = boxInner(this.host.width, SHAPE);
    const key = `${this.raw} ${width} ${this.text}`;
    if (this.cache?.key !== key) {
      this.cache = { key, lines: this.raw ? rawLines(this.text, width) : renderMarkup(this.text, width) };
    }
    return this.cache.lines;
  }

  /** How far the widest code line reaches past the box: how far code can scroll sideways. */
  wide(): number {
    const inner = boxInner(this.host.width, SHAPE);
    const widest = Math.max(0, ...this.lines().filter((l) => l.code).map((l) => lineLen(l.line)));
    return Math.max(0, Math.ceil((widest - inner) / SHIFT) * SHIFT);
  }

  /** A code line scrolled to the current offset, with ‹ › where it continues out of view. */
  shifted(line: Line): Line {
    const inner = boxInner(this.host.width, SHAPE);
    const before = this.left > 0;
    const after = lineLen(line) > this.left + inner;
    const out: Line = before ? [["‹", "dim"]] : [];
    out.push(...sliceLine(line, this.left + (before ? 1 : 0), this.left + inner - (after ? 1 : 0)));
    if (after) out.push(["›", "dim"]);
    return out;
  }

  /** Text rows that fit between the box's borders, leaving the header, status line and our own status free. */
  visible(): number {
    return Math.max(3, this.host.height - 6 - 2 * SHAPE.padY - (this.status ? 2 : 0));
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    if (this.saving) return;
    const max = Math.max(0, this.lines().length - this.visible());
    const page = this.visible() - 1;
    if (key.name === "escape" || str === "d" || str === "q") this.host.close();
    else if (str === "j" || key.name === "down") this.top = Math.min(max, this.top + 1);
    else if (str === "k" || key.name === "up") this.top = Math.max(0, this.top - 1);
    else if (str === " " || key.name === "pagedown") this.top = Math.min(max, this.top + page);
    else if (str === "b" || key.name === "pageup") this.top = Math.max(0, this.top - page);
    else if (str === "l" || key.name === "right") this.left = Math.min(this.wide(), this.left + SHIFT);
    else if (str === "h" || key.name === "left") this.left = Math.max(0, this.left - SHIFT);
    else if (str === "g") this.top = 0;
    else if (str === "G") this.top = max;
    else if (str === "r") {
      this.raw = !this.raw;
      this.top = 0;
      this.left = 0;
    } else if (str === "e" && this.text !== null) await this.edit(this.text);
  }

  async edit(before: string): Promise<void> {
    const edited = editInEditor(this.host, this.issue.key, before);
    if (edited === null) {
      this.status = `${EDITOR} did not exit cleanly, the description is unchanged`;
      return;
    }
    const after = edited.replace(/\s+$/, "");
    if (after === before.replace(/\s+$/, "")) {
      this.status = "no changes";
      return;
    }
    this.saving = true;
    this.status = "saving…";
    this.host.draw();
    try {
      await setField(this.issue.key, "description", after || null);
      this.text = after;
      this.top = Math.min(this.top, Math.max(0, this.lines().length - this.visible()));
      this.status = after ? "saved" : "description cleared";
    } catch (e) {
      this.status = `saving failed: ${(e as Error).message}`;
    } finally {
      this.saving = false;
    }
  }

  draw(rows: Line[]): void {
    const all = this.lines();
    const body: BoxRow[] = this.text === null ? [{ line: [[this.status, "dim"]] }]
      : all.length ? all.slice(this.top, this.top + this.visible()).map((l) => ({ line: l.code ? this.shifted(l.line) : l.line }))
      : [{ line: [["no description · press e to write one", "dim"]] }];
    if (this.text !== null && this.status) body.push("rule", { line: [[this.status, "dim"]] });
    const scroll = [all.length > this.visible() && "j/k", this.wide() && "h/l"].filter(Boolean).join(" ");
    const edit = this.text === null ? "" : `r ${this.raw ? "rendered" : "as written"} · e edit in ${EDITOR.split(" ")[0]} · `;
    drawBox(rows, this.host, `${this.issue.key}: ${this.issue.fields.summary}`, body,
      `${scroll ? `${scroll} scroll · ` : ""}${edit}esc close`, SHAPE);
  }
}

export const openDescription = (host: DialogHost, item: Item): Dialog => new DescriptionDialog(host, item.issue);
