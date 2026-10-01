// How the board looks: cards, subtasks, column headers and the sprint header, as styled lines.

import { firstName, type Board } from "../board.ts";
import type { Card, Issue, User } from "../jira/types.ts";
import { fit, lineLen, shorten, wrap, type Line, type Segment } from "./line.ts";
import { PEOPLE_SLOTS, theme } from "./theme.ts";

/** Columns between board columns. */
export const GAP = 3;

/** One selectable thing in a column: a card, or a subtask shown under its expanded card. */
export interface Item {
  issue: Issue;
  parent: Card | null;
  lines: Line[];
}

const ISSUE_KINDS: Record<string, "story" | "task" | "bug" | "epic"> = {
  "Bug": "bug", "User Story": "story", "Story": "story", "Task": "task", "Epic": "epic",
};

/** The theme's single-width marker for an issue type, coloured by kind. */
function typeIcon(type: string): Segment {
  const kind = ISSUE_KINDS[type];
  return kind ? [theme.icons[kind], kind] : [theme.icons.other, "dim"];
}

export const legend = (): Line => [
  [theme.icons.story, "story"], [" story  ", "dim"], [theme.icons.task, "task"], [" task  ", "dim"],
  [theme.icons.bug, "bug"], [" bug  ", "dim"], ["▸ 2/5", "dim"], [" subtasks done/total", "dim"],
];

/** Everyone gets their own name colour, the same on every run; I am highlighted. */
function personStyle(board: Board, user: User | null): string {
  if (!user?.name) return "dim";
  if (user.name === board.me) return "me";
  const hash = [...user.name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return `person${hash % PEOPLE_SLOTS}`;
}

/** 3 -> "3", 0.5 -> "0.5", 1.25 -> "1.25" */
export const formatPoints = (n: number) => String(Math.round(n * 100) / 100);

function cardLines(board: Board, card: Card, colIdx: number, width: number, expanded: boolean): Line[] {
  const f = card.fields;
  const left: Line = [typeIcon(f.issuetype.name), [" ", null], [card.key, `col${colIdx}`]];
  if (board.pointsField && !f.issuetype.subtask) {
    left.push([" ", null], card.points == null ? ["? pts", "dim"] : [`${formatPoints(card.points)} pts`, "points"]);
  }
  if (card.subs.length) {
    const done = card.subs.filter((s) => board.columnOf(s) === board.columns.length - 1).length;
    left.push([` ${expanded ? "▾" : "▸"} ${done}/${card.subs.length}`, "dim"]);
  }
  return [
    fit(left, firstName(f.assignee), width, personStyle(board, f.assignee)),
    ...wrap(f.summary, width - 2, 2).map((part): Line => [[`  ${part}`, null]]),
  ];
}

function subLines(board: Board, sub: Issue, width: number): Line[] {
  const f = sub.fields;
  const cidx = board.columnOf(sub);
  const left: Line = [["  ↳ ", "dim"], [sub.key, "bold"], [" ", null],
    [f.status.name, cidx >= 0 ? `fg${cidx}` : "dim"]];
  return [fit(left, firstName(f.assignee), width, personStyle(board, f.assignee)),
    [[`    ${shorten(f.summary, width - 4)}`, "name"]]];
}

/** Selectable items of one column: cards, followed by their subtasks when expanded. */
export function columnItems(board: Board, bucket: Card[], colIdx: number, width: number, expanded: Set<string>): Item[] {
  const items: Item[] = [];
  for (const card of bucket) {
    const isOpen = expanded.has(card.key) && card.subs.length > 0;
    items.push({ issue: card, parent: null, lines: cardLines(board, card, colIdx, width, isOpen) });
    if (isOpen) {
      for (const sub of card.subs) items.push({ issue: sub, parent: card, lines: subLines(board, sub, width) });
    }
    items[items.length - 1].lines.push([]); // blank line between cards
  }
  return items;
}

export const columnWidth = (totalWidth: number, n: number) => Math.max(20, Math.floor((totalWidth - GAP * (n - 1)) / n));

/** Room for card text: themed cards spend two columns on the accent bar. */
export const cardWidth = (colW: number) => (theme.cards ? colW - 2 : colW);

/** Theme a card or subtask line to the full column width; blank lines between cards stay plain. */
export function decorate(line: Line, colIdx: number, colW: number, selected: boolean): Line {
  if (!line.length) return line;
  if (!theme.cards) { // classic: reverse video for the selection only
    if (!selected) return line;
    const padded: Line = [...line, [" ".repeat(Math.max(0, colW - lineLen(line))), null]];
    return padded.map(([t, s]): Segment => [t, s ? `${s}+rev` : "rev"]);
  }
  const base = selected ? "cardsel" : "card";
  return [
    [selected ? "▌" : "▎", `${base}+bar${colIdx}`], [" ", base],
    ...line.map(([t, s]): Segment => [t, s ? `${base}+${s}` : base]),
    [" ".repeat(Math.max(0, colW - 2 - lineLen(line))), base],
  ];
}

export function columnHeaderLine(board: Board, idx: number, count: number, points: number, active: boolean): Line {
  const name = board.columns[idx].name.toUpperCase();
  const stats = `${count}${board.pointsField ? ` · ${formatPoints(points)} pts` : ""}`;
  if (!theme.cards) return [[` ${name} (${stats}) `, active ? `col${idx}+rev` : `col${idx}`]];
  if (active) return [[` ${theme.icons.dot} ${name}  ${stats} `, `pill${idx}`]];
  return [[` ${theme.icons.dot} `, `fg${idx}`], [name, `col${idx}`], [`  ${stats} `, "name"]];
}

/** Sprint name, end date, days left and a story points progress bar. */
export function headerLine(board: Board, mine: boolean, cards: number, points: number[]): Line {
  const { name, endDate } = board.sprint;
  const line: Line = theme.icons.sprint ? [[` ${theme.icons.sprint} `, "accent"]] : [];
  line.push([name, "title"]);
  if (endDate) {
    const end = new Date(endDate);
    const days = Math.ceil((end.getTime() - Date.now()) / 86_400_000);
    const when = end.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    line.push([`   ends ${when} · `, "name"], [days >= 0 ? `${days}d left` : `${-days}d overdue`, days <= 2 ? "warn" : "name"]);
  }
  const total = points.reduce((sum, p) => sum + p, 0);
  if (board.pointsField && total > 0) {
    const done = points[points.length - 1] ?? 0;
    const filled = Math.round((done / total) * 20);
    line.push(["   ", null], [theme.icons.full.repeat(filled), "progress"], [theme.icons.empty.repeat(20 - filled), "track"],
      [`  ${formatPoints(done)}/${formatPoints(total)} pts done`, "name"]);
  }
  line.push([`   ${cards} card${cards === 1 ? "" : "s"}`, "dim"]);
  if (mine) line.push(["  · mine", "me"]);
  return line;
}
