// The active sprint of one board: its columns, cards (with their subtasks) and story points.

import { get, JiraError } from "./jira/client.ts";
import type { Card, Column, Issue, Sprint, User } from "./jira/types.ts";

/** How many done cards are shown unless all are asked for. */
const DONE_LIMIT = 5;

export const assigneeName = (issue: Issue) => issue.fields.assignee?.name;

export function firstName(user: User | null): string {
  if (!user) return "-";
  let name = user.displayName || user.name || "?";
  if (name.includes(",")) name = name.slice(name.indexOf(",") + 1); // "Doe, Jane" -> Jane
  return name.trim().split(/\s+/)[0]?.slice(0, 12) || "?";
}

/** "Doe, Jane" -> "Jane Doe" */
export function fullName(user: User): string {
  const name = user.displayName || user.name || "?";
  const comma = name.indexOf(",");
  return comma < 0 ? name : `${name.slice(comma + 1).trim()} ${name.slice(0, comma).trim()}`;
}

export class Board {
  boardId: string;
  columns: Column[] = [];
  sprint: Sprint = { id: 0, name: "" };
  me = "";
  meUser: User = {};
  cards: Card[] = [];
  pointsField: string | null = null; // e.g. customfield_10002 "Story Points"

  /** Names of the board columns to show (any case), or all of them. */
  only: string[];

  constructor(boardId: string, only: string[] = []) {
    this.boardId = boardId;
    this.only = only;
  }

  async reload(): Promise<void> {
    type BoardConfig = {
      columnConfig: { columns: { name: string; statuses: { id: string }[] }[] };
      estimation?: { type: string; field?: { fieldId: string } };
    };
    const [config, sprints, me] = await Promise.all([
      get<BoardConfig>(`/rest/agile/1.0/board/${this.boardId}/configuration`),
      get<{ values: Sprint[] }>(`/rest/agile/1.0/board/${this.boardId}/sprint`, { state: "active" }),
      get<{ name: string; displayName: string }>("/rest/api/2/myself"),
    ]);
    const sprint = sprints.values[0];
    if (!sprint) throw new JiraError(`no active sprint on board ${this.boardId}`);
    // the same story points field the web board uses for estimation
    const pointsField = config.estimation?.type === "field" ? config.estimation.field?.fieldId ?? null : null;

    const issues: Issue[] = [];
    for (let start = 0; ;) {
      const page = await get<{ issues: Issue[]; total: number }>(`/rest/agile/1.0/sprint/${sprint.id}/issue`, {
        fields: ["summary,status,assignee,issuetype,updated,parent", pointsField].filter(Boolean).join(","),
        startAt: start, maxResults: 100,
      });
      issues.push(...page.issues);
      start += page.issues.length;
      if (!page.issues.length || start >= page.total) break;
    }
    if (pointsField) {
      for (const issue of issues) {
        const value = (issue.fields as Record<string, unknown>)[pointsField];
        issue.points = typeof value === "number" ? value : null;
      }
    }

    // subtasks hang under their parent card; orphans become cards themselves
    const keys = new Set(issues.map((i) => i.key));
    const subs = new Map<string, Issue[]>();
    const cards: Card[] = [];
    for (const issue of issues) {
      const parent = issue.fields.parent?.key;
      if (issue.fields.issuetype.subtask && parent && keys.has(parent)) {
        subs.set(parent, [...(subs.get(parent) ?? []), issue]);
      } else {
        cards.push({ ...issue, subs: [] });
      }
    }
    for (const card of cards) card.subs = subs.get(card.key) ?? [];

    // cards whose column isn't shown are left out, like cards with a status on no column
    const all = config.columnConfig.columns;
    const wanted = new Set(this.only.map((name) => name.toLowerCase()));
    const unknown = this.only.filter((name) => !all.some((c) => c.name.toLowerCase() === name.toLowerCase()));
    if (unknown.length) {
      throw new JiraError(`no column ${unknown.map((n) => `"${n}"`).join(", ")} on this board; it has: ${all.map((c) => c.name).join(", ")}`);
    }
    const columns = all.filter((c) => !wanted.size || wanted.has(c.name.toLowerCase()));

    // only replace state once everything loaded, so a failed refresh keeps the old board
    this.columns = columns.map((c) => ({ name: c.name, statuses: new Set(c.statuses.map((s) => s.id)) }));
    this.sprint = sprint;
    this.me = me.name;
    this.meUser = { name: me.name, displayName: me.displayName };
    this.cards = cards;
    this.pointsField = pointsField;
  }

  /** Me first, then everyone assigned to something in the sprint, by name. */
  team(): User[] {
    const users = new Map<string, User>();
    for (const card of this.cards) {
      for (const issue of [card, ...card.subs]) {
        const user = issue.fields.assignee;
        if (user?.name && user.name !== this.me) users.set(user.name, user);
      }
    }
    return [this.meUser, ...[...users.values()].sort((a, b) => fullName(a).localeCompare(fullName(b)))];
  }

  /** Keys of every card and subtask in the sprint. */
  keys(): string[] {
    return this.cards.flatMap((card) => [card.key, ...card.subs.map((sub) => sub.key)]);
  }

  /** Index of the board column showing this issue's status, or -1. */
  columnOf(issue: Issue): number {
    return this.columns.findIndex((c) => c.statuses.has(issue.fields.status.id));
  }

  isMine(card: Card): boolean {
    return [card, ...card.subs].some((i) => assigneeName(i) === this.me);
  }

  /** Cards per column, how many done cards were left out, and story points per column (hidden ones included). */
  buckets(mine: boolean, showAll: boolean): { buckets: Card[][]; hidden: number; points: number[] } {
    const buckets: Card[][] = this.columns.map(() => []);
    for (const card of this.cards) {
      const idx = this.columnOf(card);
      if (idx >= 0 && (!mine || this.isMine(card))) buckets[idx].push(card);
    }
    const points = buckets.map((b) => b.reduce((sum, card) => sum + (card.points ?? 0), 0));
    let hidden = 0;
    const last = buckets.length - 1;
    if (!showAll && buckets[last].length > DONE_LIMIT) {
      buckets[last].sort((a, b) => b.fields.updated.localeCompare(a.fields.updated));
      hidden = buckets[last].length - DONE_LIMIT;
      buckets[last] = buckets[last].slice(0, DONE_LIMIT);
    }
    return { buckets, hidden, points };
  }
}
