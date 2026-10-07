// How the board looks: cards, subtasks, column headers and the sprint header, as styled lines.

import { firstName, type Board } from "../board.ts";
import { mrStatus, type Benched, type MergeRequest } from "../bench.ts";
import type { Card, Issue, User } from "../jira/types.ts";
import { fit, lineLen, shorten, sliceLine, wrap, type Line, type Segment } from "./line.ts";
import { columnSlot, PEOPLE_SLOTS, theme } from "./theme.ts";

/** The style slot of a column on this board; see columnSlot. */
const slot = (board: Board, idx: number) => columnSlot(idx, board.columns.length);

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
export function typeIcon(type: string): Segment {
  const kind = ISSUE_KINDS[type];
  return kind ? [theme.icons[kind], kind] : [theme.icons.other, "dim"];
}

export const legend = (): Line => [
  [theme.icons.story, "story"], [" story  ", "dim"], [theme.icons.task, "task"], [" task  ", "dim"],
  [theme.icons.bug, "bug"], [" bug  ", "dim"], ["▸ 2/5", "dim"], [" subtasks done/total", "dim"],
];

const preferredSlot = (name: string) => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % PEOPLE_SLOTS;

/** Colour slots per board, recomputed when a reload brings new cards. */
const slotsByCards = new WeakMap<object, Map<string, number>>();

/**
 * Give everyone on the board their own colour. Each name prefers the slot its hash picks, so it's the same on every
 * run; when two people would share one, the later of them in alphabetical order takes the next free slot.
 */
function peopleSlots(board: Board): Map<string, number> {
  let slots = slotsByCards.get(board.cards);
  if (slots) return slots;
  slots = new Map();
  const taken = new Set<number>();
  const names = board.team().map((u) => u.name).filter((n): n is string => !!n && n !== board.me).sort();
  for (const name of names) {
    let slot = preferredSlot(name);
    for (let tries = 0; tries < PEOPLE_SLOTS && taken.has(slot); tries++) slot = (slot + 1) % PEOPLE_SLOTS;
    taken.add(slot);
    slots.set(name, slot);
  }
  slotsByCards.set(board.cards, slots);
  return slots;
}

/** Everyone gets their own name colour, the same on every run; I am highlighted. */
function personStyle(board: Board, user: User | null): string {
  if (!user?.name) return "dim";
  if (user.name === board.me) return "me";
  // someone just assigned from here isn't in the colours yet
  if (!peopleSlots(board).has(user.name)) slotsByCards.delete(board.cards);
  return `person${peopleSlots(board).get(user.name) ?? preferredSlot(user.name)}`;
}

/** 3 -> "3", 0.5 -> "0.5", 1.25 -> "1.25" */
export const formatPoints = (n: number) => String(Math.round(n * 100) / 100);

const MR_STYLES: Record<string, string> = { open: "accent", draft: "dim", merged: "fgdone", closed: "dim" };
const mrStyle = (mr: MergeRequest) => MR_STYLES[mrStatus(mr)];

/** ⎇ for an issue with a bench, and the merge request of its benches (e.g. !123), coloured by state. */
function benchMarker(benched: Benched, key: string): Line {
  const mark = benched.get(key);
  if (!mark) return [];
  const line: Line = mark.bench ? [[` ${theme.icons.bench}`, "accent"]] : [];
  if (mark.mr) line.push([` ${mark.mr.id}`, mrStyle(mark.mr)]);
  return line;
}

/** Lines of summary on a card, below the line with its key; cards are this plus one line high. */
const SUMMARY_LINES = 2;

/** Characters of summary a compact line keeps before giving up what is on its right. */
const MIN_SUMMARY = 12;

/**
 * One line: `head`, the summary cut to fit, and against the right edge the first of `rights` that leaves room for
 * some summary (fuller ones first), or nothing in a narrow column.
 */
function listLine(head: Line, summary: string, summaryStyle: string | null, rights: Line[], width: number): Line {
  const right = rights.find((r) => lineLen(head) + 1 + MIN_SUMMARY + 1 + lineLen(r) <= width) ?? [];
  const room = width - lineLen(head) - lineLen(right) - 2;
  const text = room > 0 ? shorten(summary, room) : "";
  const gap = " ".repeat(Math.max(1, width - lineLen(head) - 1 - text.length - lineLen(right)));
  return sliceLine([...head, [" ", null], [text, summaryStyle], [gap, null], ...right], 0, width);
}

/** Where a compact line puts the points and the assignee, so they line up down the list. */
const pointsCell = (board: Board, card: Card): Line => {
  if (!board.pointsField || card.fields.issuetype.subtask) return [];
  return card.points == null ? [["  ? pts", "dim"]] : [[`${formatPoints(card.points)} pts`.padStart(7), "points"]];
};
const nameCell = (board: Board, user: User | null): Line => [["  ", null], [firstName(user).padEnd(12), personStyle(board, user)]];

/** `keyWidth`: in a compact list, keys are padded to this so the summaries line up. */
function cardLines(board: Board, card: Card, colIdx: number, width: number, expanded: boolean, benched: Benched,
  compact: boolean, keyWidth = 0): Line[] {
  const f = card.fields;
  const left: Line = [typeIcon(f.issuetype.name), [" ", null], [compact ? card.key.padEnd(keyWidth) : card.key, `col${slot(board, colIdx)}`]];
  left.push(...benchMarker(benched, card.key));
  if (compact) { // one line, like a list: key, summary, points, assignee
    if (card.subs.length) left.push([` ${expanded ? "▾" : "▸"}`, "dim"]);
    const points = pointsCell(board, card);
    const name = nameCell(board, f.assignee);
    return [listLine(left, f.summary, null, [[...points, ...name], name], width)];
  }
  if (board.pointsField && !f.issuetype.subtask) {
    left.push([" ", null], card.points == null ? ["? pts", "dim"] : [`${formatPoints(card.points)} pts`, "points"]);
  }
  if (card.subs.length) {
    const done = card.subs.filter((s) => board.isDone(s)).length;
    left.push([` ${expanded ? "▾" : "▸"} ${done}/${card.subs.length}`, "dim"]);
  }
  // always two summary lines, so every card is the same height
  const summary = wrap(f.summary, width - 2, SUMMARY_LINES);
  while (summary.length < SUMMARY_LINES) summary.push("");
  return [
    fit(left, firstName(f.assignee), width, personStyle(board, f.assignee)),
    ...summary.map((part): Line => [[`  ${part}`, null]]),
  ];
}

function subLines(board: Board, sub: Issue, width: number, benched: Benched, compact: boolean): Line[] {
  const f = sub.fields;
  const cidx = board.columnOf(sub);
  const left: Line = [["  ↳ ", "dim"], [sub.key, "bold"]];
  left.push(...benchMarker(benched, sub.key));
  left.push([" ", null], [f.status.name, cidx >= 0 ? `fg${slot(board, cidx)}` : "dim"]);
  if (compact) return [listLine(left, f.summary, "name", [nameCell(board, f.assignee)], width)];
  return [fit(left, firstName(f.assignee), width, personStyle(board, f.assignee)),
    [[`    ${shorten(f.summary, width - 4)}`, "name"]]];
}

/**
 * Selectable items of one column: cards, followed by their subtasks when expanded; `benched` issues get a marker.
 * `compact`: a line per card and subtask, like a list, instead of cards.
 */
export function columnItems(board: Board, bucket: Card[], colIdx: number, width: number, expanded: Set<string>,
  benched: Benched = new Map(), compact = false): Item[] {
  const items: Item[] = [];
  const keyWidth = Math.max(0, ...bucket.map((card) => card.key.length));
  for (const card of bucket) {
    const isOpen = expanded.has(card.key) && card.subs.length > 0;
    items.push({ issue: card, parent: null, lines: cardLines(board, card, colIdx, width, isOpen, benched, compact, keyWidth) });
    if (isOpen) {
      for (const sub of card.subs) items.push({ issue: sub, parent: card, lines: subLines(board, sub, width, benched, compact) });
    }
    if (!compact) items[items.length - 1].lines.push([]); // blank line between cards
  }
  return items;
}

export const columnWidth = (totalWidth: number, n: number) => Math.max(20, Math.floor((totalWidth - GAP * (n - 1)) / n));

/** Room for card text: themed cards spend two columns on the accent bar. */
export const cardWidth = (colW: number) => (theme.cards ? colW - 2 : colW);

/** Theme a card or subtask line to the full column width; blank lines between cards stay plain. `slot`: see columnSlot. */
export function decorate(line: Line, slot: string, colW: number, selected: boolean): Line {
  if (!line.length) return line;
  if (!theme.cards) { // classic: reverse video for the selection only
    if (!selected) return line;
    const padded: Line = [...line, [" ".repeat(Math.max(0, colW - lineLen(line))), null]];
    return padded.map(([t, s]): Segment => [t, s ? `${s}+rev` : "rev"]);
  }
  const base = selected ? "cardsel" : "card";
  return [
    [selected ? "▌" : "▎", `${base}+bar${slot}`], [" ", base],
    ...line.map(([t, s]): Segment => [t, s ? `${base}+${s}` : base]),
    [" ".repeat(Math.max(0, colW - 2 - lineLen(line))), base],
  ];
}

export function columnHeaderLine(board: Board, idx: number, count: number, points: number, active: boolean): Line {
  const name = board.columns[idx].name.toUpperCase();
  const s = slot(board, idx);
  const stats = `${count}${board.pointsField ? ` · ${formatPoints(points)} pts` : ""}`;
  if (!theme.cards) return [[` ${name} (${stats}) `, active ? `col${s}+rev` : `col${s}`]];
  if (active) return [[` ${theme.icons.dot} ${name}  ${stats} `, `pill${s}`]];
  return [[` ${theme.icons.dot} `, `fg${s}`], [name, `col${s}`], [`  ${stats} `, "name"]];
}

const day = (date: string) => new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** The sprints and the backlog as tabs, the shown one highlighted; names are cut to fit `width`. */
export function tabsLine(names: string[], current: number, width: number): Line {
  const room = Math.floor(width / Math.max(1, names.length)) - 3;
  const line: Line = [];
  names.forEach((name, i) => {
    const label = ` ${shorten(name, Math.max(6, room))} `;
    line.push(...(i ? [[" ", null] as Segment] : []), [label, i === current ? "key" : "name"]);
  });
  return line;
}

/** Sprint name, end date, days left and a story points progress bar. */
export function headerLine(board: Board, mine: boolean, cards: number, points: number[]): Line {
  const { name, endDate } = board.sprint;
  const line: Line = theme.icons.sprint ? [[` ${theme.icons.sprint} `, "accent"]] : [];
  line.push([name, "title"]);
  if (board.sprint.state === "future") {
    if (board.sprint.startDate) line.push([`   starts ${day(board.sprint.startDate)}`, "name"]);
  } else if (endDate) {
    const end = new Date(endDate);
    const days = Math.ceil((end.getTime() - Date.now()) / 86_400_000);
    line.push([`   ends ${day(endDate)} · `, "name"], [days >= 0 ? `${days}d left` : `${-days}d overdue`, days <= 2 ? "warn" : "name"]);
  }
  const total = points.reduce((sum, p) => sum + p, 0);
  if (board.kind === "backlog") {
    if (board.pointsField && total > 0) line.push([`   ${formatPoints(total)} pts`, "name"]);
  } else if (board.pointsField && total > 0) {
    const done = points[points.length - 1] ?? 0;
    const filled = Math.round((done / total) * 20);
    line.push(["   ", null], [theme.icons.full.repeat(filled), "progress"], [theme.icons.empty.repeat(20 - filled), "track"],
      [`  ${formatPoints(done)}/${formatPoints(total)} pts done`, "name"]);
  }
  line.push([`   ${cards} card${cards === 1 ? "" : "s"}`, "dim"]);
  if (mine) line.push(["  · mine", "me"]);
  return line;
}
