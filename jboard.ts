#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// jboard - the active Jira sprint as an interactive kanban board.
// Runs directly with Node >= 22.18 (built-in type stripping), no dependencies.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { parseArgs } from "node:util";

const USAGE = `Usage: jboard [-m] [-a] [-b BOARD_ID] [-w] [-p] [-t THEME]
  -m, --mine     start with only my cards (assigned to me, or with a subtask of mine)
  -a, --all      show every card in the done column, not just the 5 latest
  -b, --board    board id, the rapidView=<id> in the board's URL (default: $JIRA_BOARD_ID)
  -w, --web      open the board in the browser instead
  -p, --print    print the board once instead of the interactive view
                 (automatic when output is not a terminal)
  -t, --theme    night (default, dark), day (light terminals) or classic (16 colours);
                 or set $JBOARD_THEME. 24-bit colour is used when $COLORTERM says so

Keys: h/j/k/l or arrows  move          enter/space  expand/collapse subtasks
      g/G                top/bottom    e            expand/collapse all
      o                  open the selected issue in the browser
      w                  open the whole board in the browser
      s                  change status of the selected story/subtask (type to filter)
      A                  assign the selected story/subtask (type to search, enter to assign)
      p                  set story points of the selected story (empty clears)
      c                  create subtasks under the selected story: one per line, ctrl+s to create
      m                  toggle mine   a            toggle all done cards
      r                  refresh       q/esc        quit

Environment:
  JIRA_SERVER     base URL, e.g. https://jira.example.com/jira            (required)
  JIRA_API_TOKEN  personal access token, sent as a bearer token           (required)
  JIRA_BOARD_ID   board to show, the rapidView=<id> in the board's URL     (or use --board)
  JIRA_SSO_URL    page that redoes your SSO sign-in when Jira suddenly refuses the token
                  (default: $JIRA_SERVER/login.jsp)
  JBOARD_THEME    night, day or classic`;

const SERVER = (process.env.JIRA_SERVER ?? "").replace(/\/+$/, "");
const TOKEN = process.env.JIRA_API_TOKEN ?? "";
const DONE_LIMIT = 5;
const GAP = 3;

// ---------------------------------------------------------------- types

/** A style name like "col1" or "dim", optionally combined: "col1+rev". */
type Style = string | null;
type Segment = [text: string, style: Style];
type Line = Segment[];

interface User {
  name?: string;
  displayName?: string;
}

interface Issue {
  key: string;
  fields: {
    summary: string;
    status: { id: string; name: string };
    assignee: User | null;
    issuetype: { name: string; subtask?: boolean };
    updated: string;
    parent?: { key: string };
  };
  points?: number | null; // story points, from the board's estimation field
}

interface Card extends Issue {
  subs: Issue[];
}

interface Item {
  issue: Issue;
  parent: Card | null;
  lines: Line[];
}

interface Column {
  name: string;
  statuses: Set<string>;
}

interface Sprint {
  id: number;
  name: string;
  endDate?: string;
}

interface Transition {
  id: string;
  name: string;
  to: { id: string; name: string };
}

// ---------------------------------------------------------------- browser

/** Open a URL in the default browser; `background` keeps it from taking focus where the OS allows (macOS). */
function openUrl(url: string, { background = false } = {}): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", background ? ["-g", url] : [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// ---------------------------------------------------------------- jira client

const RETRY_CODES = new Set([403, 429, 502, 503, 504]); // 403 included: some proxies/WAFs return it intermittently
const ATTEMPTS = 3;
const ERROR_LOG = join(homedir(), ".cache", "jboard", "errors.log");
const DIAG_HEADERS = ["X-Seraph-LoginReason", "X-Authentication-Denied-Reason", "X-AUSERNAME",
  "Retry-After", "Server", "Via", "X-Cache"];

class JiraError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function logError(res: Response, body: string, url: string, attempt: number): void {
  try {
    mkdirSync(dirname(ERROR_LOG), { recursive: true });
    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    const stamp = new Date().toLocaleString("sv-SE"); // 2026-10-01 09:33:24
    appendFileSync(ERROR_LOG,
      `--- ${stamp} attempt ${attempt}/${ATTEMPTS} HTTP ${res.status} ${url}\n${headers}\n\n${body.slice(0, 500)}\n\n`);
  } catch {
    // logging is best effort
  }
}

/** Opens Jira's SSO sign-in; set JIRA_SSO_URL when login.jsp doesn't (e.g. <jira>/plugins/servlet/samlsso). */
const SSO_URL = process.env.JIRA_SSO_URL
  || `${SERVER}/login.jsp?os_destination=${encodeURIComponent("/secure/Dashboard.jspa")}`;
const SIGN_IN_WAIT_MS = 30_000;
const SIGN_IN_POLL_MS = 2_000;

/** Where sign-in progress is reported; the interactive board shows it in its status line. */
let reportSignIn = (message: string) => console.error(`jboard: ${message}`);
let signIn: Promise<boolean> | null = null;

/**
 * Redo the SSO sign-in by opening Jira's login page ($JIRA_SSO_URL) in the background browser,
 * then wait until the token is accepted again. Requests failing at the same time share one attempt.
 */
function refreshSignIn(): Promise<boolean> {
  signIn ??= (async () => {
    reportSignIn("refreshing your Jira sign-in in the browser…");
    openUrl(SSO_URL, { background: true });
    for (const deadline = Date.now() + SIGN_IN_WAIT_MS; Date.now() < deadline;) {
      await sleep(SIGN_IN_POLL_MS);
      const probe = await fetch(`${SERVER}/rest/api/2/myself`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (probe?.ok) {
        reportSignIn("signed in again");
        return true;
      }
    }
    return false;
  })().finally(() => {
    signIn = null; // a later expiry gets its own attempt
  });
  return signIn;
}

/** Jira's own explanation from an error body, e.g. "User 'x' cannot be assigned issues." */
function jiraMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string> };
    return [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})].join("; ");
  } catch {
    return "";
  }
}

async function request<T>(method: "GET" | "PUT" | "POST", path: string,
  opts: { params?: Record<string, string | number>; body?: unknown } = {}): Promise<T> {
  const query = new URLSearchParams(Object.entries(opts.params ?? {}).map(([k, v]) => [k, String(v)])).toString();
  const url = `${SERVER}${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let signedInAgain = false;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new JiraError(`cannot reach Jira: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
    }
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const body = await res.text().catch(() => "");
    logError(res, body, `${method} ${url}`, attempt);
    // Jira with SAML SSO can refuse a valid token (user known, yet a "sufficient permissions" 403) until
    // the sign-in is redone in the browser; Jira refused before acting, so repeating is safe
    const user = decodeURIComponent(res.headers.get("x-ausername") ?? "");
    if (res.status === 403 && user && user !== "anonymous" && body.includes("sufficient permissions")) {
      if (!signedInAgain && await refreshSignIn()) {
        signedInAgain = true;
        attempt = 0; // the loop's attempt++ makes this a fresh first attempt
        continue;
      }
      throw new JiraError("Jira still refuses your token: finish signing in in the Jira browser tab, then try again");
    }
    // a 403 on a write is a real permission error, so only reads retry it
    const retryable = RETRY_CODES.has(res.status) && (method === "GET" || res.status !== 403);
    if (retryable && attempt < ATTEMPTS) {
      const retryAfter = res.headers.get("retry-after") ?? "";
      await sleep(/^\d+$/.test(retryAfter) ? Math.min(10, Number(retryAfter)) * 1000 : 1500 * attempt);
      continue;
    }
    const message = jiraMessage(body);
    const diag = DIAG_HEADERS.filter((h) => res.headers.get(h)).map((h) => `${h}: ${res.headers.get(h)}`);
    throw new JiraError(`HTTP ${res.status} on ${method} ${path} after ${attempt} attempt(s)`
      + (message ? `: ${message}` : "") + (diag.length ? ` (${diag.join(", ")})` : "") + ` - details in ${ERROR_LOG}`);
  }
}

const get = <T>(path: string, params: Record<string, string | number> = {}) => request<T>("GET", path, { params });

// ---------------------------------------------------------------- board data

const assigneeName = (issue: Issue) => issue.fields.assignee?.name;

function firstName(user: User | null): string {
  if (!user) return "-";
  let name = user.displayName || user.name || "?";
  if (name.includes(",")) name = name.slice(name.indexOf(",") + 1); // "Doe, Jane" -> Jane
  return name.trim().split(/\s+/)[0]?.slice(0, 12) || "?";
}

/** "Doe, Jane" -> "Jane Doe" */
function fullName(user: User): string {
  const name = user.displayName || user.name || "?";
  const comma = name.indexOf(",");
  return comma < 0 ? name : `${name.slice(comma + 1).trim()} ${name.slice(0, comma).trim()}`;
}

class Board {
  boardId: string;
  columns: Column[] = [];
  sprint: Sprint = { id: 0, name: "" };
  me = "";
  meUser: User = {};
  cards: Card[] = [];
  pointsField: string | null = null; // e.g. customfield_10002 "Story Points"

  constructor(boardId: string) {
    this.boardId = boardId;
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

    // only replace state once everything loaded, so a failed refresh keeps the old board
    this.columns = config.columnConfig.columns.map((c) => ({ name: c.name, statuses: new Set(c.statuses.map((s) => s.id)) }));
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

// ---------------------------------------------------------------- layout

const ISSUE_KINDS: Record<string, "story" | "task" | "bug" | "epic"> = {
  "Bug": "bug", "User Story": "story", "Story": "story", "Task": "task", "Epic": "epic",
};

/** The theme's single-width marker for an issue type, coloured by kind. */
function typeIcon(type: string): Segment {
  const kind = ISSUE_KINDS[type];
  return kind ? [theme.icons[kind], kind] : [theme.icons.other, "dim"];
}

const legend = (): Line => [
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

const lineLen = (line: Line) => line.reduce((n, [text]) => n + text.length, 0);

/** Left segments, then `right` right-aligned, truncated to width. */
function fit(left: Line, right: string, width: number, rightStyle: Style): Line {
  const room = width - right.length - 1;
  const out: Line = [];
  let used = 0;
  for (const [text, style] of left) {
    if (used >= room) break;
    const part = text.slice(0, room - used);
    out.push([part, style]);
    used += part.length;
  }
  out.push([" ".repeat(Math.max(0, width - used - right.length)), null], [right, rightStyle]);
  return out;
}

const shorten = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);

/** Greedy word wrap into at most maxLines lines, ending in … when cut. */
function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) { // hard-split words longer than a line
      if (cur) lines.push(cur);
      cur = "";
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length + 1 > width) {
    last = last.includes(" ") ? last.slice(0, last.lastIndexOf(" ")) : last.slice(0, width - 1);
  }
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/** 3 -> "3", 0.5 -> "0.5", 1.25 -> "1.25" */
const formatPoints = (n: number) => String(Math.round(n * 100) / 100);

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
function columnItems(board: Board, bucket: Card[], colIdx: number, width: number, expanded: Set<string>): Item[] {
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

const columnWidth = (totalWidth: number, n: number) => Math.max(20, Math.floor((totalWidth - GAP * (n - 1)) / n));

/** Room for card text: themed cards spend two columns on the accent bar. */
const cardWidth = (colW: number) => (theme.cards ? colW - 2 : colW);

/** Theme a card or subtask line to the full column width; blank lines between cards stay plain. */
function decorate(line: Line, colIdx: number, colW: number, selected: boolean): Line {
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

function columnHeaderLine(board: Board, idx: number, count: number, points: number, active: boolean): Line {
  const name = board.columns[idx].name.toUpperCase();
  const stats = `${count}${board.pointsField ? ` · ${formatPoints(points)} pts` : ""}`;
  if (!theme.cards) return [[` ${name} (${stats}) `, active ? `col${idx}+rev` : `col${idx}`]];
  if (active) return [[` ${theme.icons.dot} ${name}  ${stats} `, `pill${idx}`]];
  return [[` ${theme.icons.dot} `, `fg${idx}`], [name, `col${idx}`], [`  ${stats} `, "name"]];
}

/** Sprint name, end date, days left and a story points progress bar. */
function headerLine(board: Board, mine: boolean, cards: number, points: number[]): Line {
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

// ---------------------------------------------------------------- themes

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const REVERSE = "\x1b[7m";
const ACCENT_SLOTS = 12; // per-column style names (col3, pill3, ...) exist for this many columns
const PEOPLE_SLOTS = 8;

/** 24-bit colour where the terminal supports it, otherwise the nearest of the 256 xterm colours. */
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? "")
  || ["iTerm.app", "WezTerm", "ghostty", "vscode"].includes(process.env.TERM_PROGRAM ?? "")
  || process.env.JBOARD_TRUECOLOR === "1";

function to256(r: number, g: number, b: number): number {
  const steps = [0, 95, 135, 175, 215, 255];
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const cubeDist = (steps[cr] - r) ** 2 + (steps[cg] - g) ** 2 + (steps[cb] - b) ** 2;
  const gray = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gv = 8 + gray * 10;
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return grayDist < cubeDist ? 232 + gray : 16 + 36 * cr + 6 * cg + cb;
}

function rgb(hex: string, layer: 38 | 48): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return TRUECOLOR ? `\x1b[${layer};2;${r};${g};${b}m` : `\x1b[${layer};5;${to256(r, g, b)}m`;
}
const fg = (hex: string) => rgb(hex, 38);
const bg = (hex: string) => rgb(hex, 48);

interface Palette {
  text: string; muted: string; faint: string; // foregrounds
  card: string; cardSel: string; panel: string; optSel: string; // backgrounds
  accents: string[]; // per board column: to do, in progress, in review, done, ...
  onAccent: string; // text on an accent-filled pill
  story: string; task: string; bug: string; epic: string;
  people: string[];
  me: string; points: string; pointsBg: string; track: string; info: string;
}

interface Theme {
  cards: boolean; // tinted card blocks with an accent bar; false = classic reverse-video selection
  corners: string; // dialog corners: top-left, top-right, bottom-left, bottom-right
  icons: { story: string; task: string; bug: string; epic: string; other: string; dot: string;
    sprint: string; info: string; full: string; empty: string };
  codes: Record<string, string>; // style name -> escape codes
}

/** Dark: muted slate cards, warm accents. */
const NIGHT: Palette = {
  text: "#cdd6e0", muted: "#8b98a5", faint: "#5d6873",
  card: "#1d232b", cardSel: "#2e3743", panel: "#232a33", optSel: "#3a4656",
  accents: ["#8899aa", "#e0af4f", "#b48ef0", "#5fb86a", "#5aa2f0", "#e27aae"],
  onAccent: "#12161c",
  story: "#5fb86a", task: "#5aa2f0", bug: "#ec6a5e", epic: "#b48ef0",
  people: ["#f2a65a", "#6fb8ff", "#d8b4fe", "#8fd694", "#f7768e", "#7dcfff", "#e9c46a", "#f5a3c7"],
  me: "#7dcfff", points: "#a9d4ff", pointsBg: "#22344a", track: "#38424e", info: "#5aa2f0",
};

/** Light: soft grey cards for white terminals. */
const DAY: Palette = {
  text: "#1f2328", muted: "#59636e", faint: "#8c959f",
  card: "#f2f4f7", cardSel: "#dbe5f2", panel: "#f6f8fa", optSel: "#cfe0f7",
  accents: ["#6e7781", "#b07a00", "#8250df", "#1a7f37", "#0969da", "#bf3989"],
  onAccent: "#ffffff",
  story: "#1a7f37", task: "#0969da", bug: "#cf222e", epic: "#8250df",
  people: ["#bc4c00", "#0550ae", "#8250df", "#116329", "#a40e26", "#0a6c74", "#7d4e00", "#99286e"],
  me: "#0969da", points: "#0550ae", pointsBg: "#ddf4ff", track: "#d0d7de", info: "#0969da",
};

function paletteTheme(p: Palette): Theme {
  const codes: Record<string, string> = {
    text: fg(p.text), dim: fg(p.faint), name: fg(p.muted), bold: BOLD + fg(p.text), title: BOLD + fg(p.text),
    me: BOLD + fg(p.me), story: fg(p.story), task: fg(p.task), bug: fg(p.bug), epic: fg(p.epic),
    points: fg(p.points) + bg(p.pointsBg), warn: BOLD + fg(p.bug), accent: BOLD + fg(p.info),
    card: bg(p.card) + fg(p.text), cardsel: bg(p.cardSel) + fg(p.text),
    rev: BOLD + bg(p.optSel) + fg(p.text), panel: bg(p.panel) + fg(p.text),
    box: bg(p.panel) + fg(p.muted), boxtitle: BOLD + bg(p.panel) + fg(p.text),
    key: BOLD + bg(p.cardSel) + fg(p.text), keylabel: fg(p.muted), msg: BOLD + fg(p.text),
    progress: fg(p.accents[3 % p.accents.length]), track: fg(p.track), empty: ITALIC + fg(p.faint),
  };
  for (let i = 0; i < ACCENT_SLOTS; i++) {
    const accent = p.accents[i % p.accents.length];
    Object.assign(codes, {
      [`col${i}`]: BOLD + fg(accent), [`fg${i}`]: fg(accent), [`bar${i}`]: fg(accent),
      [`rule${i}`]: fg(p.track), [`pill${i}`]: BOLD + bg(accent) + fg(p.onAccent),
    });
  }
  for (let i = 0; i < PEOPLE_SLOTS; i++) codes[`person${i}`] = fg(p.people[i % p.people.length]);
  return {
    cards: true, corners: "╭╮╰╯", codes,
    icons: { story: "●", task: "■", bug: "▲", epic: "◆", other: "•", dot: "●", sprint: "◆", info: "●", full: "━", empty: "━" },
  };
}

/** The original look: the 16 basic terminal colours, reverse video for selection. */
function classicTheme(): Theme {
  const cols = ["\x1b[39m", "\x1b[33m", "\x1b[35m", "\x1b[32m", "\x1b[36m", "\x1b[34m"];
  const codes: Record<string, string> = {
    text: "", dim: DIM, name: DIM, bold: BOLD, title: BOLD, me: `${BOLD}\x1b[36m`,
    story: `${BOLD}\x1b[32m`, task: `${BOLD}\x1b[34m`, bug: `${BOLD}\x1b[31m`, epic: `${BOLD}\x1b[36m`,
    points: "\x1b[36m", warn: `${BOLD}\x1b[31m`, accent: BOLD, rev: REVERSE, panel: "", box: BOLD, boxtitle: BOLD,
    key: REVERSE, keylabel: DIM, msg: "", progress: "\x1b[32m", track: DIM, empty: DIM,
  };
  for (let i = 0; i < ACCENT_SLOTS; i++) {
    const c = cols[i % cols.length];
    Object.assign(codes, { [`col${i}`]: BOLD + c, [`fg${i}`]: c, [`bar${i}`]: c, [`rule${i}`]: c, [`pill${i}`]: BOLD + c + REVERSE });
  }
  for (let i = 0; i < PEOPLE_SLOTS; i++) codes[`person${i}`] = DIM;
  return {
    cards: false, corners: "┌┐└┘", codes,
    icons: { story: "S", task: "T", bug: "B", epic: "E", other: "•", dot: "", sprint: "", info: "", full: "█", empty: "░" },
  };
}

const THEMES: Record<string, () => Theme> = { night: () => paletteTheme(NIGHT), day: () => paletteTheme(DAY), classic: classicTheme };
let theme: Theme = THEMES.night(); // replaced in main() by --theme / $JBOARD_THEME

function styleCode(style: Style): string {
  return style ? style.split("+").map((s) => theme.codes[s] ?? "").join("") : "";
}

/** Render a line, padded with spaces to `width`. */
function ansi(line: Line, width = 0): string {
  const out = line.map(([text, style]) => (style && text ? `${styleCode(style)}${text}${RESET}` : text)).join("");
  return out + " ".repeat(Math.max(0, width - lineLen(line)));
}

/** The part of a line between character positions `from` and `to`. */
function sliceLine(line: Line, from: number, to = Infinity): Line {
  const out: Line = [];
  let pos = 0;
  for (const [text, style] of line) {
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + text.length);
    if (end > start) out.push([text.slice(start - pos, end - pos), style]);
    pos += text.length;
  }
  return out;
}

/** Draw segments over a row at column x, keeping what is left and right of them. */
function overlay(row: Line, x: number, segments: Line): Line {
  const len = lineLen(row);
  const head: Line = len < x ? [...row, [" ".repeat(x - len), null]] : sliceLine(row, 0, x);
  return [...head, ...segments, ...sliceLine(row, x + lineLen(segments))];
}

/** Append segments to a row starting at column x (rows are filled left to right). */
function place(row: Line, x: number, segments: Line): void {
  const len = lineLen(row);
  if (len < x) row.push([" ".repeat(x - len), null]);
  row.push(...segments);
}

// ---------------------------------------------------------------- static output

function printBoard(board: Board, mine: boolean, showAll: boolean): void {
  const { buckets, hidden, points } = board.buckets(mine, showAll);
  const n = buckets.length;
  const colW = columnWidth(Number(process.env.COLUMNS) || process.stdout.columns || 160, n);
  const rendered = buckets.map((bucket, idx) => {
    const total = bucket.length + (idx === n - 1 ? hidden : 0);
    const lines: Line[] = [
      sliceLine(columnHeaderLine(board, idx, total, points[idx], false), 0, colW),
      [["─".repeat(colW), `rule${idx}`]],
    ];
    for (const item of columnItems(board, bucket, idx, cardWidth(colW), new Set())) {
      lines.push(...item.lines.map((l) => decorate(l, idx, colW, false)));
    }
    if (idx === n - 1 && hidden) lines.push([[`+${hidden} more (jboard -a)`, "dim"]]);
    return lines.map((l) => ansi(l, colW));
  });

  const cards = buckets.reduce((sum, b) => sum + b.length, 0) + hidden;
  console.log(`\n${ansi(headerLine(board, mine, cards, points))}`);
  console.log(`${ansi([[" ", null], ...legend()])}\n`);
  const height = Math.max(...rendered.map((c) => c.length));
  for (let row = 0; row < height; row++) {
    console.log(rendered.map((c) => c[row] ?? " ".repeat(colW)).join(" ".repeat(GAP)).trimEnd());
  }
}

// ---------------------------------------------------------------- interactive

const KEY_HINTS: [string, string][] = [
  ["hjkl", "move"], ["⏎", "subtasks"], ["s", "status"], ["A", "assign"], ["p", "points"], ["c", "new subtasks"],
  ["q", "quit"], ["e", "expand all"], ["o", "open"], ["w", "board in browser"], ["m", "mine"], ["a", "all done"], ["r", "refresh"],
];

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** A dialog over the board: pick a new assignee or status for one issue. */
interface Picker {
  kind: "assign" | "status";
  issue: Issue;
  query: string;
  sel: number;
  remote: User[]; // assign: Jira search results for `query`, beyond the team
  searching: boolean; // assign: user search running; status: transitions loading
  transitions: Transition[]; // status: what the workflow allows from here
}

interface PickerOption {
  label: string;
  note: string;
  current: boolean; // marked with ✓
  dim: boolean;
  user?: User | null; // assign: null = unassign
  transition?: Transition; // status
}

/** The new-subtasks dialog: a plain list, one summary per line. */
interface Composer {
  parent: Card;
  lines: string[];
}

/** The story points dialog: a number for one story, empty to clear. */
interface PointsEditor {
  card: Card;
  text: string;
  prefilled: boolean; // text is still the current value: the first digit replaces it
}

interface BulkResult {
  issues: { key: string }[];
  errors?: { status: number; failedElementNumber: number; elementErrors: unknown }[];
}

/** Summaries from a typed or pasted list: one per line, bullets/numbering and blank lines dropped. */
function subtaskSummaries(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

const subtaskTypes = new Map<string, string>();

/** The issue type id for subtasks in a project (usually "Subtask" or "Sub-task"), looked up once. */
async function subtaskTypeId(project: string): Promise<string> {
  const cached = subtaskTypes.get(project);
  if (cached) return cached;
  const res = await get<{ values: { id: string; name: string; subtask: boolean }[] }>(
    `/rest/api/2/issue/createmeta/${project}/issuetypes`);
  const types = res.values.filter((t) => t.subtask);
  const type = types.find((t) => /^sub-?task$/i.test(t.name)) ?? types[0];
  if (!type) throw new JiraError(`project ${project} has no subtask issue type`);
  subtaskTypes.set(project, type.id);
  return type.id;
}

class Tui {
  board: Board;
  mine: boolean;
  showAll: boolean;
  expanded = new Set<string>();
  sel: number[] = [];
  top: number[] = [];
  col = 0;
  colW = 20;
  msg = "";
  busy = false;
  buckets: Card[][] = [];
  hidden = 0;
  points: number[] = [];
  items: Item[][] = [];
  picker: Picker | null = null;
  composer: Composer | null = null;
  pointsEditor: PointsEditor | null = null;
  searchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(board: Board, mine: boolean, showAll: boolean) {
    this.board = board;
    this.mine = mine;
    this.showAll = showAll;
    this.rebuild();
    this.jumpToFirstColumn();
  }

  get width(): number {
    return process.stdout.columns || 80;
  }

  get height(): number {
    return process.stdout.rows || 24;
  }

  // -- state

  rebuild(): void {
    const n = this.board.columns.length;
    this.colW = columnWidth(this.width, n);
    ({ buckets: this.buckets, hidden: this.hidden, points: this.points } = this.board.buckets(this.mine, this.showAll));
    this.items = this.buckets.map((b, i) => columnItems(this.board, b, i, cardWidth(this.colW), this.expanded));
    for (let c = 0; c < n; c++) {
      this.sel[c] = Math.min(this.sel[c] ?? 0, Math.max(0, this.items[c].length - 1));
    }
  }

  current(): Item | undefined {
    return this.items[this.col]?.[this.sel[this.col]];
  }

  /** After a rebuild, put the cursor back on the first of `keys` still shown. */
  reselect(...keys: (string | undefined)[]): void {
    for (const key of keys) {
      for (let c = 0; c < this.items.length; c++) {
        const i = this.items[c].findIndex((item) => key && item.issue.key === key);
        if (i >= 0) {
          this.col = c;
          this.sel[c] = i;
          return;
        }
      }
    }
  }

  rebuildKeepingCursor(): void {
    const cur = this.current();
    this.rebuild();
    if (cur) this.reselect(cur.issue.key, cur.parent?.key);
  }

  jumpToFirstColumn(): void {
    this.col = -1;
    this.moveCol(1);
    this.col = Math.max(this.col, 0);
  }

  // -- actions

  moveCol(d: number): void {
    for (let c = this.col + d; c >= 0 && c < this.items.length; c += d) {
      if (this.items[c].length) {
        this.col = c;
        return;
      }
    }
  }

  move(d: number): void {
    const items = this.items[this.col];
    if (items?.length) this.sel[this.col] = Math.max(0, Math.min(items.length - 1, this.sel[this.col] + d));
  }

  toggle(): void {
    const cur = this.current();
    if (!cur) return;
    const card = cur.parent ?? (cur.issue as Card);
    if (!card.subs.length) {
      this.msg = `${card.key} has no subtasks`;
      return;
    }
    if (!this.expanded.delete(card.key)) this.expanded.add(card.key);
    this.rebuild();
    this.reselect(card.key);
  }

  toggleAll(): void {
    const cards = this.buckets.flat().filter((c) => c.subs.length);
    if (cards.some((c) => !this.expanded.has(c.key))) cards.forEach((c) => this.expanded.add(c.key));
    else this.expanded.clear();
    this.rebuildKeepingCursor();
  }

  openCurrent(): void {
    const cur = this.current();
    if (!cur) return;
    openUrl(`${SERVER}/browse/${cur.issue.key}`);
    this.msg = `opened ${cur.issue.key} in browser`;
  }

  openBoardInBrowser(): void {
    openUrl(`${SERVER}/secure/RapidBoard.jspa?rapidView=${this.board.boardId}`);
    this.msg = "opened the board in the browser · press r to reload here";
  }

  toggleMine(): void {
    this.mine = !this.mine;
    this.rebuildKeepingCursor();
    if (!this.current()) this.jumpToFirstColumn();
  }

  toggleDone(): void {
    this.showAll = !this.showAll;
    this.rebuildKeepingCursor();
  }

  // -- assigning

  openAssign(): void {
    const cur = this.current();
    if (!cur) return;
    // start on "me" rather than "Unassigned", so a stray enter does no harm
    this.picker = { kind: "assign", issue: cur.issue, query: "", sel: 1, remote: [], searching: false, transitions: [] };
  }

  async openStatus(): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    const picker: Picker = { kind: "status", issue: cur.issue, query: "", sel: 0, remote: [], searching: true, transitions: [] };
    this.picker = picker;
    this.draw();
    try {
      const res = await get<{ transitions: Transition[] }>(`/rest/api/2/issue/${cur.issue.key}/transitions`);
      picker.transitions = res.transitions;
    } catch (e) {
      if (this.picker === picker) this.picker = null;
      this.msg = `could not load transitions: ${(e as Error).message}`;
      return;
    }
    picker.searching = false;
  }

  pickerOptions(picker: Picker): PickerOption[] {
    const q = picker.query.trim().toLowerCase();
    const has = (...texts: (string | undefined)[]) => !q || texts.some((s) => s?.toLowerCase().includes(q));

    if (picker.kind === "status") {
      // rejecting goes last, so the cursor never starts on it and a stray enter can't reject
      const rejects = (t: Transition) => /reject/i.test(`${t.name} ${t.to.name}`);
      return [...picker.transitions.filter((t) => !rejects(t)), ...picker.transitions.filter(rejects)]
        .map((t): PickerOption => {
          const col = this.board.columns.find((c) => c.statuses.has(t.to.id));
          return { label: t.to.name, note: col ? `→ ${col.name}` : "not on board", current: false,
            dim: !col || rejects(t), transition: t };
        })
        .filter((o) => has(o.label, o.note, o.transition?.name));
    }

    const options: PickerOption[] = [];
    const assignee = picker.issue.fields.assignee?.name;
    if (has("unassigned")) options.push({ label: "Unassigned", note: "", current: !assignee, dim: true, user: null });
    const seen = new Set<string>();
    for (const user of this.board.team()) {
      if (!user.name || !has(user.name, user.displayName, fullName(user))) continue;
      seen.add(user.name);
      options.push({ label: fullName(user), note: user.name === this.board.me ? "me" : "team",
        current: user.name === assignee, dim: false, user });
    }
    for (const user of picker.remote) {
      if (!user.name || seen.has(user.name)) continue;
      seen.add(user.name);
      options.push({ label: fullName(user), note: user.name, current: user.name === assignee, dim: false, user });
    }
    return options;
  }

  /** Search all assignable users once typing pauses; the team is matched locally right away. */
  searchSoon(): void {
    clearTimeout(this.searchTimer);
    const picker = this.picker;
    if (!picker || picker.kind !== "assign") return;
    picker.remote = [];
    picker.searching = picker.query.trim().length >= 2;
    if (!picker.searching) return;
    const query = picker.query.trim();
    this.searchTimer = setTimeout(async () => {
      let users: User[] = [];
      try {
        users = await get<User[]>("/rest/api/2/user/assignable/search",
          { issueKey: picker.issue.key, username: query, maxResults: 20 });
      } catch (e) {
        this.msg = `user search failed: ${(e as Error).message}`;
      }
      if (this.picker !== picker || picker.query.trim() !== query) return; // typed on meanwhile
      picker.remote = users;
      picker.searching = false;
      this.draw();
    }, 250);
  }

  async pickerKey(str: string | undefined, key: Key): Promise<void> {
    const picker = this.picker!;
    const options = this.pickerOptions(picker);
    if (key.name === "escape") {
      this.picker = null;
    } else if (key.name === "return" || key.name === "enter") {
      const choice = options[picker.sel];
      if (choice?.transition) await this.transition(picker.issue, choice.transition);
      else if (choice && choice.user !== undefined) await this.assign(picker.issue, choice.user);
      return;
    } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
      picker.sel = Math.max(0, picker.sel - 1);
    } else if (key.name === "down" || key.name === "tab" || (key.ctrl && key.name === "n")) {
      picker.sel = Math.min(options.length - 1, picker.sel + 1);
    } else if (key.name === "backspace") {
      picker.query = picker.query.slice(0, -1);
      picker.sel = 0;
      this.searchSoon();
    } else if (str && str.length === 1 && str >= " " && !key.ctrl && !key.meta) {
      picker.query += str;
      picker.sel = 0;
      this.searchSoon();
    }
  }

  async assign(issue: Issue, user: User | null): Promise<void> {
    clearTimeout(this.searchTimer);
    this.picker = null;
    this.busy = true;
    this.msg = `assigning ${issue.key}…`;
    this.draw();
    try {
      await request<void>("PUT", `/rest/api/2/issue/${issue.key}/assignee`, { body: { name: user?.name ?? null } });
      issue.fields.assignee = user;
      this.msg = `${issue.key} assigned to ${user ? fullName(user) : "nobody"}`;
    } catch (e) {
      this.msg = `assign failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
    this.rebuildKeepingCursor();
  }

  async transition(issue: Issue, transition: Transition): Promise<void> {
    this.picker = null;
    this.busy = true;
    this.msg = `moving ${issue.key} to ${transition.to.name}…`;
    this.draw();
    try {
      await request<void>("POST", `/rest/api/2/issue/${issue.key}/transitions`, { body: { transition: { id: transition.id } } });
      issue.fields.status = { id: transition.to.id, name: transition.to.name };
      issue.fields.updated = new Date().toISOString(); // shows first among the done cards
      this.msg = `${issue.key} is now ${transition.to.name}`;
    } catch (e) {
      const hint = (e as Error).message.includes("HTTP 400") ? " (needs extra fields? press o to do it in Jira)" : "";
      this.msg = `status change failed: ${(e as Error).message}${hint}`;
    } finally {
      this.busy = false;
    }
    this.rebuildKeepingCursor();
  }

  /** Width available for text inside a dialog box. */
  get boxInner(): number {
    return Math.min(64, this.width - 4) - 4;
  }

  /** Draw a bordered dialog over the board; "rule" is a separator line. */
  drawBox(rows: Line[], title: string, body: ({ line: Line; style?: Style } | "rule")[], footer: string): void {
    const { width: w, height: h } = this;
    const inner = this.boxInner;
    const boxW = inner + 4;
    const x = Math.max(0, Math.floor((w - boxW) / 2));
    const [tl, tr, bl, br] = theme.corners;
    const border = (left: string, text: string, right: string, textStyle: string): Line => {
      if (!text) return [[left + "─".repeat(boxW - 2) + right, "box"]];
      return [[`${left}─ `, "box"], [text, textStyle], [` ${"─".repeat(Math.max(0, boxW - 5 - text.length))}${right}`, "box"]];
    };
    // panel background under everything, then the segment's own style, then the row's (selection)
    const row = (content: Line, style: Style = null): Line => {
      const text = sliceLine(content, 0, inner);
      const padded: Line = [...text, [" ".repeat(inner - lineLen(text)), null]];
      return [["│ ", "box"], ...padded.map(([t, s]): Segment => [t, ["panel", s, style].filter(Boolean).join("+")]), [" │", "box"]];
    };

    const lines: Line[] = [
      border(tl, shorten(title, boxW - 6), tr, "boxtitle"),
      ...body.map((b) => (b === "rule" ? border("├", "", "┤", "box") : row(b.line, b.style ?? null))),
      border(bl, shorten(footer, boxW - 6), br, "box"),
    ];
    const y = Math.max(1, Math.floor((h - lines.length) / 3));
    lines.forEach((line, i) => {
      if (y + i < h - 1) rows[y + i] = overlay(rows[y + i], x, line);
    });
  }

  drawPicker(rows: Line[], picker: Picker): void {
    const inner = this.boxInner;
    const options = this.pickerOptions(picker);
    picker.sel = Math.max(0, Math.min(picker.sel, options.length - 1));
    const visible = Math.max(1, Math.min(12, this.height - 12, options.length || 1));
    const top = Math.max(0, Math.min(picker.sel - Math.floor(visible / 2), options.length - visible));
    const { key, fields } = picker.issue;
    const title = picker.kind === "assign" ? `Assign ${key}: ${fields.summary}` : `Move ${key} (now ${fields.status.name})`;
    const empty = picker.kind === "assign"
      ? (picker.searching ? "searching…" : "no matching users")
      : (picker.searching ? "loading transitions…" : picker.transitions.length ? "no matching status" : "no transitions available");
    const action = picker.kind === "assign" ? "assign" : "move";

    const body: ({ line: Line; style?: Style } | "rule")[] = [
      { line: [["› ", "dim"], [picker.query, null], ["█", "dim"]] },
      "rule",
    ];
    if (!options.length) body.push({ line: [[empty, "dim"]] });
    options.slice(top, top + visible).forEach((option, i) => {
      const note = shorten(option.note, Math.floor(inner / 2) - 2);
      const label = shorten(`${option.label}${option.current ? " ✓" : ""}`, inner - note.length - 1);
      const gap = " ".repeat(Math.max(1, inner - label.length - note.length));
      body.push({ line: [[label, option.dim ? "dim" : null], [gap, null], [note, "dim"]], style: top + i === picker.sel ? "rev" : null });
    });
    const more = picker.searching && options.length ? "searching… · " : "";
    this.drawBox(rows, title, body, `${more}↑↓ select · ⏎ ${action} · esc cancel`);
  }

  // -- story points

  openPoints(): void {
    const cur = this.current();
    if (!cur) return;
    if (!this.board.pointsField) {
      this.msg = "this board does not estimate with a story points field";
      return;
    }
    const card = cur.parent ?? (cur.issue as Card); // points live on the story, not its subtasks
    this.pointsEditor = { card, text: card.points == null ? "" : formatPoints(card.points), prefilled: true };
  }

  async pointsKey(str: string | undefined, key: Key): Promise<void> {
    const editor = this.pointsEditor!;
    if (key.name === "escape") {
      this.pointsEditor = null;
    } else if (key.name === "return" || key.name === "enter") {
      await this.savePoints(editor);
    } else if (key.name === "backspace") {
      editor.text = editor.text.slice(0, -1);
      editor.prefilled = false;
    } else if (str && /^[0-9.,]$/.test(str)) {
      if (editor.prefilled) editor.text = "";
      editor.prefilled = false;
      if (editor.text.length < 6) editor.text += str === "," ? "." : str; // accept a Dutch decimal comma
    }
  }

  async savePoints(editor: PointsEditor): Promise<void> {
    const text = editor.text.trim();
    const value = text === "" ? null : Number(text);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      this.msg = `"${text}" is not a number of story points`;
      return;
    }
    const { card } = editor;
    this.pointsEditor = null;
    this.busy = true;
    this.msg = `saving story points for ${card.key}…`;
    this.draw();
    try {
      await request<void>("PUT", `/rest/api/2/issue/${card.key}`, { body: { fields: { [this.board.pointsField!]: value } } });
      card.points = value;
      this.msg = value === null ? `${card.key}: story points cleared` : `${card.key}: ${formatPoints(value)} story points`;
    } catch (e) {
      this.msg = `saving story points failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
    this.rebuildKeepingCursor();
  }

  drawPoints(rows: Line[], editor: PointsEditor): void {
    const { card } = editor;
    const now = card.points == null ? "none" : formatPoints(card.points);
    this.drawBox(rows, `Story points for ${card.key}: ${card.fields.summary}`, [
      { line: [["currently ", "dim"], [now, "points"], ["  ·  usual: 1 2 3 5 8 13", "dim"]] },
      "rule",
      { line: [["› ", "dim"], [editor.text, editor.prefilled ? "rev" : null], ["█", "dim"]] },
    ], "⏎ save · type to replace · empty clears · esc cancel");
  }

  // -- creating subtasks

  openComposer(): void {
    const cur = this.current();
    if (!cur) return;
    const parent = cur.parent ?? (cur.issue as Card);
    if (parent.fields.issuetype.subtask) {
      this.msg = `${parent.key} is a subtask whose story is not in this sprint`;
      return;
    }
    this.composer = { parent, lines: [""] };
  }

  async composerKey(str: string | undefined, key: Key): Promise<void> {
    const composer = this.composer!;
    const last = composer.lines.length - 1;
    if (key.name === "escape") {
      this.composer = null;
    } else if (key.ctrl && (key.name === "s" || key.name === "d")) {
      await this.createSubtasks(composer);
    } else if (key.name === "return" || key.name === "enter") {
      composer.lines.push(""); // pasted lists arrive as text + return, one line each
    } else if (key.name === "backspace") {
      if (composer.lines[last]) composer.lines[last] = composer.lines[last].slice(0, -1);
      else if (last > 0) composer.lines.pop();
    } else if (str && str.length === 1 && str >= " " && !key.ctrl && !key.meta) {
      composer.lines[last] += str;
    }
  }

  async createSubtasks(composer: Composer): Promise<void> {
    const summaries = subtaskSummaries(composer.lines);
    if (!summaries.length) {
      this.msg = "type at least one subtask, one per line";
      return;
    }
    const parent = composer.parent;
    this.composer = null;
    this.busy = true;
    this.msg = `creating ${summaries.length} subtask(s) under ${parent.key}…`;
    this.draw();
    try {
      const project = parent.key.slice(0, parent.key.lastIndexOf("-"));
      const typeId = await subtaskTypeId(project);
      const res = await request<BulkResult>("POST", "/rest/api/2/issue/bulk", {
        body: {
          issueUpdates: summaries.map((summary) => ({
            fields: { project: { key: project }, parent: { key: parent.key }, issuetype: { id: typeId }, summary },
          })),
        },
      });
      const created = res.issues.map((i) => i.key);
      const failed = (res.errors ?? []).map((e) => {
        const reason = jiraMessage(JSON.stringify(e.elementErrors)) || `HTTP ${e.status}`;
        return `"${shorten(summaries[e.failedElementNumber] ?? "?", 30)}": ${reason}`;
      });
      this.msg = (created.length ? `created ${created.join(", ")} under ${parent.key}` : "nothing created")
        + (failed.length ? ` · failed: ${failed.join("; ")}` : "");
      if (created.length) {
        await this.board.reload(); // new subtasks need their full fields from Jira
        this.expanded.add(parent.key);
        this.rebuild();
        this.reselect(created[0], parent.key);
      }
    } catch (e) {
      this.msg = `creating subtasks failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
  }

  drawComposer(rows: Line[], composer: Composer): void {
    const inner = this.boxInner;
    const count = subtaskSummaries(composer.lines).length;
    const visible = Math.max(1, Math.min(12, this.height - 10));
    const shown = composer.lines.slice(-visible); // keep the line being typed in view
    const body: ({ line: Line; style?: Style } | "rule")[] = [
      { line: [["one subtask per line · paste a list · bullets are ignored", "dim"]] },
      "rule",
    ];
    if (composer.lines.length > visible) body.push({ line: [[`… ${composer.lines.length - visible} more above`, "dim"]] });
    shown.forEach((text, i) => {
      const isLast = i === shown.length - 1;
      // show the end of a long line while it is being typed
      const visibleText = isLast && text.length > inner - 3 ? `…${text.slice(-(inner - 4))}` : text;
      body.push({ line: [["• ", "dim"], [visibleText, null], ...(isLast ? [["█", "dim"] as Segment] : [])] });
    });
    this.drawBox(rows, `New subtasks for ${composer.parent.key}: ${composer.parent.fields.summary}`, body,
      `⏎ new line · ctrl+s create ${count} · esc cancel`);
  }

  async refresh(): Promise<void> {
    this.busy = true;
    this.msg = "refreshing…";
    this.draw();
    try {
      await this.board.reload();
      this.msg = "refreshed";
    } catch (e) { // keep the old data on network trouble
      this.msg = `refresh failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
    this.rebuildKeepingCursor();
  }

  // -- drawing

  /** Status message, or the keys as keycaps. */
  footer(): Line {
    if (this.msg) return [[theme.icons.info ? ` ${theme.icons.info} ` : "", "accent"], [this.msg, "msg"]];
    const line: Line = [];
    for (const [key, label] of KEY_HINTS) { // as many whole hints as fit, most important first
      const hint: Line = [[` ${key} `, "key"], [` ${label}  `, "keylabel"]];
      if (lineLen(line) + lineLen(hint) > this.width) break;
      line.push(...hint);
    }
    return line;
  }

  draw(): void {
    const { width: w, height: h } = this;
    const bodyTop = 4;
    const viewH = Math.max(1, h - 5);
    const n = this.items.length;
    const rows: Line[] = Array.from({ length: h }, () => []);
    const shown = this.buckets.reduce((sum, b) => sum + b.length, 0) + this.hidden;

    rows[0] = headerLine(this.board, this.mine, shown, this.points);
    this.items.forEach((items, c) => {
      const x = c * (this.colW + GAP);
      const total = this.buckets[c].length + (c === n - 1 ? this.hidden : 0);
      place(rows[2], x, sliceLine(columnHeaderLine(this.board, c, total, this.points[c] ?? 0, c === this.col), 0, this.colW));

      // [line, selected, part of a card]
      const lines: [Line, boolean, boolean][] = [];
      let selStart = 0;
      let selEnd = 0;
      items.forEach((item, i) => {
        const isSel = i === this.sel[c];
        if (isSel) {
          selStart = lines.length;
          selEnd = selStart + item.lines.filter((l) => l.length).length - 1;
        }
        for (const line of item.lines) lines.push([line, isSel && c === this.col && line.length > 0, true]);
      });
      if (c === n - 1 && this.hidden) lines.push([[[`  +${this.hidden} more · press a`, "dim"]], false, false]);
      if (!items.length) lines.push([[["  nothing here", "empty"]], false, false]);
      while (lines.length && !lines[lines.length - 1][0].length) lines.pop(); // nothing to scroll to

      // scroll each column independently so its selection stays visible
      let top = this.top[c] ?? 0;
      if (items.length) {
        top = Math.min(top, selStart);
        top = Math.max(top, selEnd - viewH + 1);
      }
      top = Math.max(0, Math.min(top, lines.length - viewH));
      this.top[c] = top;

      let rule = "─".repeat(this.colW);
      if (top > 0) rule = `${rule.slice(0, -1)}↑`;
      if (top + viewH < lines.length) rule = `${rule.slice(0, -2)}↓${rule.slice(-1)}`;
      place(rows[3], x, [[rule, c === this.col ? `fg${c}` : `rule${c}`]]);

      lines.slice(top, top + viewH).forEach(([line, selected, isCard], r) => {
        place(rows[bodyTop + r], x, isCard ? decorate(line, c, this.colW, selected) : line);
      });
    });
    rows[h - 1] = this.footer();
    if (this.picker) this.drawPicker(rows, this.picker);
    if (this.composer) this.drawComposer(rows, this.composer);
    if (this.pointsEditor) this.drawPoints(rows, this.pointsEditor);

    // synchronized update, every row positioned explicitly and cleared to the right
    const frame = rows.map((row, y) => `\x1b[${y + 1};1H${ansi(sliceLine(row, 0, w))}\x1b[K`).join("");
    process.stdout.write(`\x1b[?2026h${frame}\x1b[?2026l`);
  }

  async onKey(str: string | undefined, key: Key): Promise<void> {
    if (key.ctrl && key.name === "c") process.exit(0);
    if (this.busy) return;
    this.msg = "";
    if (this.picker) {
      await this.pickerKey(str, key);
      this.draw();
      return;
    }
    if (this.composer) {
      await this.composerKey(str, key);
      this.draw();
      return;
    }
    if (this.pointsEditor) {
      await this.pointsKey(str, key);
      this.draw();
      return;
    }
    if (str === "q" || key.name === "escape") process.exit(0);
    // special keys by name, letters as typed (so g and G differ)
    const name = key.name && key.name.length > 1 ? key.name : str;
    const actions: Record<string, () => void | Promise<void>> = {
      h: () => this.moveCol(-1), left: () => this.moveCol(-1),
      l: () => this.moveCol(1), right: () => this.moveCol(1),
      j: () => this.move(1), down: () => this.move(1),
      k: () => this.move(-1), up: () => this.move(-1),
      g: () => this.move(-1e6), G: () => this.move(1e6),
      return: () => this.toggle(), enter: () => this.toggle(), space: () => this.toggle(),
      e: () => this.toggleAll(), o: () => this.openCurrent(), r: () => this.refresh(),
      A: () => this.openAssign(), s: () => this.openStatus(), c: () => this.openComposer(),
      p: () => this.openPoints(),
      w: () => this.openBoardInBrowser(),
      m: () => this.toggleMine(), a: () => this.toggleDone(),
    };
    const action = name ? actions[name] : undefined;
    if (!action) return;
    await action();
    this.draw();
  }

  start(): void {
    const { stdin, stdout } = process;
    // alternate screen, hidden cursor, no line wrapping; undone on any exit
    stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l");
    process.on("exit", () => {
      stdin.setRawMode(false);
      stdout.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
    });
    // readline only reads escapeCodeTimeout from its interface argument; 50ms makes esc quit promptly
    emitKeypressEvents(stdin, { escapeCodeTimeout: 50 } as never);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", (str: string | undefined, key: Key) => void this.onKey(str, key));
    reportSignIn = (message) => {
      this.msg = message;
      this.draw();
    };
    stdout.on("resize", () => {
      this.rebuildKeepingCursor();
      this.draw();
    });
    this.draw();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        mine: { type: "boolean", short: "m" },
        all: { type: "boolean", short: "a" },
        board: { type: "string", short: "b" },
        web: { type: "boolean", short: "w" },
        print: { type: "boolean", short: "p" },
        theme: { type: "string", short: "t" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    console.error(`jboard: ${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const themeName = values.theme ?? process.env.JBOARD_THEME ?? "night";
  const makeTheme = THEMES[themeName];
  if (!makeTheme) {
    console.error(`jboard: unknown theme "${themeName}", choose from: ${Object.keys(THEMES).join(", ")}`);
    process.exit(2);
  }
  theme = makeTheme();
  if (!SERVER || !TOKEN) throw new JiraError("JIRA_SERVER and JIRA_API_TOKEN must be set");

  const boardId = values.board ?? process.env.JIRA_BOARD_ID;
  if (!boardId) throw new JiraError("no board: set JIRA_BOARD_ID or pass --board <id> (the rapidView=<id> in the board's URL)");
  if (values.web) {
    openUrl(`${SERVER}/secure/RapidBoard.jspa?rapidView=${boardId}`);
    return;
  }

  const board = new Board(boardId);
  await board.reload();
  if (values.print || !process.stdout.isTTY || !process.stdin.isTTY) {
    printBoard(board, !!values.mine, !!values.all);
  } else {
    new Tui(board, !!values.mine, !!values.all).start();
  }
}

main().catch((e: unknown) => {
  if (!(e instanceof JiraError)) throw e;
  console.error(`jboard: ${e.message}`);
  process.exit(1);
});
