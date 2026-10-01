// `p`: set or clear a story's points.

import { setField } from "../jira/api.ts";
import type { Card } from "../jira/types.ts";
import { formatPoints, type Item } from "../render/layout.ts";
import type { Line } from "../render/line.ts";
import { drawBox, type Dialog, type DialogHost, type Key } from "./dialog.ts";

class PointsDialog implements Dialog {
  host: DialogHost;
  card: Card;
  field: string;
  text: string;
  prefilled = true; // text is still the current value: the first digit replaces it

  constructor(host: DialogHost, card: Card, field: string) {
    this.host = host;
    this.card = card;
    this.field = field;
    this.text = card.points == null ? "" : formatPoints(card.points);
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    if (key.name === "escape") {
      this.host.close();
    } else if (key.name === "return" || key.name === "enter") {
      await this.save();
    } else if (key.name === "backspace") {
      this.text = this.text.slice(0, -1);
      this.prefilled = false;
    } else if (str && /^[0-9.,]$/.test(str)) {
      if (this.prefilled) this.text = "";
      this.prefilled = false;
      if (this.text.length < 6) this.text += str === "," ? "." : str; // accept a decimal comma
    }
  }

  async save(): Promise<void> {
    const text = this.text.trim();
    const value = text === "" ? null : Number(text);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      this.host.msg = `"${text}" is not a number of story points`;
      return;
    }
    const { card } = this;
    await this.host.perform(`saving story points for ${card.key}…`, async () => {
      await setField(card.key, this.field, value);
      card.points = value;
      return value === null ? `${card.key}: story points cleared` : `${card.key}: ${formatPoints(value)} story points`;
    }, (message) => `saving story points failed: ${message}`);
  }

  draw(rows: Line[]): void {
    const now = this.card.points == null ? "none" : formatPoints(this.card.points);
    drawBox(rows, this.host, `Story points for ${this.card.key}: ${this.card.fields.summary}`, [
      { line: [["currently ", "dim"], [now, "points"], ["  ·  usual: 1 2 3 5 8 13", "dim"]] },
      "rule",
      { line: [["› ", "dim"], [this.text, this.prefilled ? "rev" : null], ["█", "dim"]] },
    ], "⏎ save · type to replace · empty clears · esc cancel");
  }
}

export function openPoints(host: DialogHost, item: Item): Dialog | null {
  if (!host.board.pointsField) {
    host.msg = "this board does not estimate with a story points field";
    return null;
  }
  // points live on the story, not its subtasks
  return new PointsDialog(host, item.parent ?? (item.issue as Card), host.board.pointsField);
}
