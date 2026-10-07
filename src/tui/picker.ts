// A filter-as-you-type list; the assign and status dialogs are pickers with their own options.

import { shorten, type Line } from "../render/line.ts";
import { boxInner, drawBox, isTyping, type BoxRow, type BoxShape, type Dialog, type DialogHost, type Key } from "./dialog.ts";

export interface PickerOption {
  label: string;
  note: string; // dimmed, right-aligned
  current?: boolean; // marked with ✓
  dim?: boolean;
  choose(): Promise<void>;
}

/** What a picker lists and does; the picker itself only handles typing, moving and drawing. */
export interface PickerSource {
  title: string;
  action: string; // footer verb, e.g. "assign"
  options(query: string): PickerOption[];
  /** Shown when there is nothing to list. */
  empty(): string;
  /** Options are still being fetched. */
  loading(): boolean;
  queryChanged?(query: string): void;
  /** A wider box, e.g. for long branch names. */
  shape?: BoxShape;
  close?(): void;
}

export class Picker implements Dialog {
  host: DialogHost;
  source: PickerSource;
  query = "";
  sel: number;

  constructor(host: DialogHost, source: PickerSource, sel = 0) {
    this.host = host;
    this.source = source;
    this.sel = sel;
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    const options = this.source.options(this.query);
    if (key.name === "escape") {
      this.source.close?.();
      this.host.close();
    } else if (key.name === "return" || key.name === "enter") {
      const choice = options[this.sel];
      if (!choice) return;
      this.source.close?.();
      await choice.choose();
    } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
      this.sel = Math.max(0, this.sel - 1);
    } else if (key.name === "down" || key.name === "tab" || (key.ctrl && key.name === "n")) {
      this.sel = Math.min(options.length - 1, this.sel + 1);
    } else if (key.name === "backspace") {
      this.setQuery(this.query.slice(0, -1));
    } else if (isTyping(str, key)) {
      this.setQuery(this.query + str);
    }
  }

  setQuery(query: string): void {
    this.query = query;
    this.sel = 0;
    this.source.queryChanged?.(query);
  }

  draw(rows: Line[]): void {
    const inner = boxInner(this.host.width, this.source.shape);
    const options = this.source.options(this.query);
    this.sel = Math.max(0, Math.min(this.sel, options.length - 1));
    const visible = Math.max(1, Math.min(12, this.host.height - 12, options.length || 1));
    const top = Math.max(0, Math.min(this.sel - Math.floor(visible / 2), options.length - visible));

    const body: BoxRow[] = [{ line: [["› ", "dim"], [this.query, null], ["█", "dim"]] }, "rule"];
    if (!options.length) body.push({ line: [[this.source.empty(), "dim"]] });
    options.slice(top, top + visible).forEach((option, i) => {
      const note = shorten(option.note, Math.floor(inner / 2) - 2);
      const label = shorten(`${option.label}${option.current ? " ✓" : ""}`, inner - note.length - 1);
      const gap = " ".repeat(Math.max(1, inner - label.length - note.length));
      body.push({
        line: [[label, option.dim ? "dim" : null], [gap, null], [note, "dim"]],
        style: top + i === this.sel ? "rev" : null,
      });
    });
    const more = this.source.loading() && options.length ? "searching… · " : "";
    drawBox(rows, this.host, this.source.title, body, `${more}↑↓ select · ⏎ ${this.source.action} · esc cancel`, this.source.shape);
  }
}
