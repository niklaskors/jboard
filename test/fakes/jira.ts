// A small in-memory Jira (Server / Data Center REST API) with just the endpoints jboard uses, so the tests run
// jboard's real HTTP client against it. Every request is recorded, and failures can be injected per endpoint.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TOKEN = "test-token";
export const BOARD_ID = "7";
export const POINTS_FIELD = "customfield_10002";

export const STATUSES: Record<string, string> = {
  "1": "To Do", "3": "In Progress", "10": "In Review", "10001": "Done", "6": "Rejected", "99": "Archived",
};
/** The transition to each status, by its id. */
const TRANSITION_NAMES: Record<string, string> = {
  "1": "Back to do", "3": "Start progress", "10": "Request review", "10001": "Done", "6": "Reject", "99": "Archive",
};

export const USERS: Record<string, { name: string; displayName: string }> = {
  jdoe: { name: "jdoe", displayName: "Doe, Jane" },
  asmith: { name: "asmith", displayName: "Smith, Alex" },
  bwayne: { name: "bwayne", displayName: "Wayne, Bruce" },
  ckent: { name: "ckent", displayName: "Kent, Clark" },
};

/** The boards there are; the tests use the first. */
const BOARDS = [{ id: Number(BOARD_ID), name: "PROJ board", type: "scrum" }, { id: 8, name: "PROJ support", type: "kanban" }];

const TYPES = [
  { id: "10", name: "Story", subtask: false },
  { id: "11", name: "Task", subtask: false },
  { id: "12", name: "Bug", subtask: false },
  { id: "13", name: "Epic", subtask: false },
  { id: "15", name: "Sub-task", subtask: true },
];

export interface FakeSprint {
  id: number;
  name: string;
  state: "active" | "future" | "closed";
  startDate?: string;
  endDate?: string;
}

export interface FakeIssue {
  key: string;
  summary: string;
  status: string; // status id
  type: string; // issue type name
  assignee: string | null;
  sprint: number | null; // null: the backlog
  parent?: string;
  points?: number | null;
  description?: string | null;
  updated: string;
}

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
}

interface Failure {
  method: string;
  path: RegExp;
  status: number;
  body: unknown;
  headers: Record<string, string>;
  times: number;
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const at = (minute: number) => `2026-10-0${1 + Math.floor(minute / 60)}T09:${String(minute % 60).padStart(2, "0")}:00.000+0000`;

const issue = (key: string, summary: string, status: string, type: string, assignee: string | null, more: Partial<FakeIssue> = {}): FakeIssue =>
  ({ key, summary, status, type, assignee, sprint: 100, points: null, description: null, updated: at(Number(key.split("-")[1])), ...more });

/**
 * The board every test starts from: Sprint 12 is active, Sprint 13 comes next, and three issues are in the backlog.
 * PROJ-1 has two subtasks, PROJ-9 is a subtask whose story isn't in the sprint, and the done column has six cards.
 */
export function fixture(): { sprints: FakeSprint[]; issues: FakeIssue[] } {
  return {
    sprints: [
      // the future one first: jboard sorts the active one to the front itself
      { id: 101, name: "Sprint 13", state: "future", startDate: days(12), endDate: days(26) },
      { id: 100, name: "Sprint 12", state: "active", startDate: days(-4), endDate: days(10) },
    ],
    issues: [
      issue("PROJ-1", "Login with SSO", "1", "Story", "jdoe", { points: 3, description: "h1. Goal\nUsers sign in with *SSO*.\n\n* one\n* two" }),
      issue("PROJ-2", "Add SAML config", "1", "Sub-task", "jdoe", { parent: "PROJ-1" }),
      issue("PROJ-3", "Write login tests", "10001", "Sub-task", "asmith", { parent: "PROJ-1" }),
      issue("PROJ-4", "Crash on empty board", "3", "Bug", "asmith", { points: 2 }),
      issue("PROJ-5", "Upgrade Node", "10", "Task", null),
      issue("PROJ-9", "Fix flaky deploy", "3", "Sub-task", "jdoe", { parent: "PROJ-50" }), // its story is elsewhere
      // six done cards, one more than shown by default; PROJ-6 is the oldest
      issue("PROJ-6", "Dark mode", "10001", "Story", "bwayne", { points: 5 }),
      issue("PROJ-20", "Release notes", "10001", "Task", "asmith", { points: 1 }),
      issue("PROJ-21", "Cache avatars", "10001", "Story", "jdoe", { points: 2 }),
      issue("PROJ-22", "Retry uploads", "10001", "Story", "bwayne", { points: 1 }),
      issue("PROJ-23", "Remove old flag", "10001", "Task", "asmith"),
      issue("PROJ-24", "Wrong date format", "6", "Bug", "jdoe"),
      issue("PROJ-30", "Billing export", "1", "Story", "asmith", { sprint: 101, points: 8 }),
      issue("PROJ-40", "Search filters", "1", "Story", null, { sprint: null, points: 3 }),
      issue("PROJ-41", "Typo in footer", "3", "Bug", "bwayne", { sprint: null }),
      issue("PROJ-42", "Closed long ago", "10001", "Task", null, { sprint: null }),
    ],
  };
}

export class FakeJira {
  server: Server;
  url = "";
  sprints: FakeSprint[] = [];
  issues: FakeIssue[] = [];
  /** The projects of the board. */
  projects: { key: string; name: string }[] = [];
  requests: RecordedRequest[] = [];
  failures: Failure[] = [];
  /** Issues per page, whatever maxResults asks for (Jira caps it too). */
  pageSize = 100;
  /** Answer the token with an SSO-style 403 until this many sign-in probes (GET /myself) were made. */
  ssoProbesNeeded = 0;
  private nextKey = 100;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.reset();
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/jira`;
    return this.url;
  }

  reset(): void {
    ({ sprints: this.sprints, issues: this.issues } = fixture());
    this.projects = [{ key: "PROJ", name: "Project" }];
    this.requests = [];
    this.failures = [];
    this.pageSize = 100;
    this.ssoProbesNeeded = 0;
    this.nextKey = 100;
  }

  /** Answer the next `times` requests matching method and path with this error instead. */
  fail(method: string, path: string | RegExp, status: number, body: unknown = {}, { times = 1, headers = {} } = {}): void {
    const pattern = typeof path === "string" ? new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : path;
    this.failures.push({ method, path: pattern, status, body, headers, times });
  }

  get(key: string): FakeIssue {
    const found = this.issues.find((i) => i.key === key);
    if (!found) throw new Error(`no issue ${key}`);
    return found;
  }

  /** The requests made with this method to paths matching `path`. */
  calls(method: string, path: string | RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && (typeof path === "string" ? r.path === path : path.test(r.path)));
  }

  // -- the REST API

  private toJson(i: FakeIssue, fields?: string): unknown {
    const type = TYPES.find((t) => t.name === i.type)!;
    const all: Record<string, unknown> = {
      summary: i.summary,
      status: { id: i.status, name: STATUSES[i.status] },
      assignee: i.assignee ? USERS[i.assignee] : null,
      issuetype: { name: type.name, subtask: type.subtask },
      updated: i.updated,
      ...i.parent ? { parent: { key: i.parent } } : {},
      [POINTS_FIELD]: i.points ?? null,
      description: i.description ?? null,
    };
    const wanted = fields?.split(",");
    return { key: i.key, fields: wanted ? Object.fromEntries(Object.entries(all).filter(([k]) => wanted.includes(k))) : all };
  }

  private page(list: FakeIssue[], q: Record<string, string>) {
    const start = Number(q.startAt ?? 0);
    const size = Math.min(Number(q.maxResults ?? 50), this.pageSize);
    return { startAt: start, maxResults: size, total: list.length, issues: list.slice(start, start + size).map((i) => this.toJson(i, q.fields)) };
  }

  private transitions(i: FakeIssue) {
    return Object.keys(STATUSES).filter((id) => id !== i.status)
      .map((id) => ({ id: `t${id}`, name: TRANSITION_NAMES[id], to: { id, name: STATUSES[id] } }));
  }

  private move(keys: string[], sprint: number | null): void {
    for (const i of this.issues) {
      if (keys.includes(i.key) || (i.parent && keys.includes(i.parent))) i.sprint = sprint;
    }
  }

  private create(fields: any): FakeIssue | { error: string } {
    const type = TYPES.find((t) => t.id === fields.issuetype?.id);
    if (!type) return { error: "issue type is required" };
    if (!fields.summary || /FAIL/.test(fields.summary)) return { error: "Summary is invalid" };
    const parent = fields.parent?.key ? this.get(fields.parent.key) : undefined;
    const created: FakeIssue = {
      key: `${fields.project.key}-${this.nextKey++}`, summary: fields.summary, status: "1", type: type.name, assignee: null,
      sprint: parent ? parent.sprint : null, parent: parent?.key, points: null, description: fields.description ?? null,
      updated: new Date().toISOString(),
    };
    this.issues.push(created);
    return created;
  }

  private route(method: string, path: string, q: Record<string, string>, body: any): [number, unknown] {
    let m: RegExpMatchArray | null;
    const api = path.replace(/^\/jira/, "");
    const route = (verb: string, pattern: RegExp) => method === verb && (m = api.match(pattern));
    const notFound: [number, unknown] = [404, { errorMessages: ["Issue Does Not Exist"], errors: {} }];
    const find = (key: string) => this.issues.find((i) => i.key === key);

    if (route("GET", /^\/rest\/api\/2\/myself$/)) return [200, USERS.jdoe];
    if (route("GET", /^\/rest\/agile\/1\.0\/board$/)) {
      return [200, { values: BOARDS.filter((b) => b.name.toLowerCase().includes((q.name ?? "").toLowerCase())) }];
    }
    if (route("GET", /^\/rest\/agile\/1\.0\/board\/(\d+)$/)) {
      const board = BOARDS.find((b) => String(b.id) === m![1]);
      return board ? [200, board] : [404, { errorMessages: [`Board ${m![1]} does not exist`] }];
    }
    if (route("GET", /^\/rest\/agile\/1\.0\/board\/(\w+)\/configuration$/)) {
      if (m![1] !== BOARD_ID) return [404, { errorMessages: [`Board ${m![1]} does not exist`] }];
      return [200, {
        columnConfig: { columns: [
          { name: "To Do", statuses: [{ id: "1" }] },
          { name: "In Progress", statuses: [{ id: "3" }] },
          { name: "Review", statuses: [{ id: "10" }] },
          { name: "Done", statuses: [{ id: "10001" }, { id: "6" }] },
        ] },
        estimation: { type: "field", field: { fieldId: POINTS_FIELD, displayName: "Story Points" } },
      }];
    }
    if (route("GET", /^\/rest\/agile\/1\.0\/board\/\w+\/sprint$/)) {
      const states = (q.state ?? "active,future,closed").split(",");
      return [200, { isLast: true, values: this.sprints.filter((s) => states.includes(s.state)) }];
    }
    if (route("GET", /^\/rest\/agile\/1\.0\/sprint\/(\d+)$/)) {
      const sprint = this.sprints.find((s) => s.id === Number(m![1]));
      return sprint ? [200, sprint] : [404, { errorMessages: ["Sprint does not exist"] }];
    }
    if (route("GET", /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/)) {
      return [200, this.page(this.issues.filter((i) => i.sprint === Number(m![1])), q)];
    }
    if (route("GET", /^\/rest\/agile\/1\.0\/board\/\w+\/backlog$/)) {
      return [200, this.page(this.issues.filter((i) => i.sprint === null), q)];
    }
    if (route("GET", /^\/rest\/agile\/1\.0\/board\/\w+\/project$/)) return [200, { values: this.projects }];
    if (route("GET", /^\/rest\/api\/2\/issue\/createmeta\/(\w+)\/issuetypes$/)) return [200, { values: TYPES }];
    if (route("GET", /^\/rest\/api\/2\/user\/assignable\/search$/)) {
      const query = (q.username ?? "").toLowerCase();
      return [200, Object.values(USERS).filter((u) => `${u.name} ${u.displayName}`.toLowerCase().includes(query))];
    }
    if (route("GET", /^\/rest\/api\/2\/issue\/([\w-]+)\/transitions$/)) {
      const i = find(m![1]);
      return i ? [200, { transitions: this.transitions(i) }] : notFound;
    }
    if (route("POST", /^\/rest\/api\/2\/issue\/([\w-]+)\/transitions$/)) {
      const i = find(m![1]);
      if (!i) return notFound;
      const step = this.transitions(i).find((t) => t.id === body?.transition?.id);
      if (!step) return [400, { errorMessages: ["Transition id is not valid"], errors: {} }];
      i.status = step.to.id;
      i.updated = new Date().toISOString();
      return [204, null];
    }
    if (route("PUT", /^\/rest\/api\/2\/issue\/([\w-]+)\/assignee$/)) {
      const i = find(m![1]);
      if (!i) return notFound;
      if (body.name !== null && !USERS[body.name]) return [400, { errorMessages: [], errors: { assignee: `User '${body.name}' cannot be assigned issues.` } }];
      i.assignee = body.name;
      return [204, null];
    }
    if (route("GET", /^\/rest\/api\/2\/issue\/([\w-]+)$/)) {
      const i = find(m![1]);
      return i ? [200, this.toJson(i, q.fields)] : notFound;
    }
    if (route("PUT", /^\/rest\/api\/2\/issue\/([\w-]+)$/)) {
      const i = find(m![1]);
      if (!i) return notFound;
      const fields = body.fields as Record<string, unknown>;
      if ("description" in fields) i.description = fields.description as string | null;
      if (POINTS_FIELD in fields) i.points = fields[POINTS_FIELD] as number | null;
      i.updated = new Date().toISOString();
      return [204, null];
    }
    if (route("POST", /^\/rest\/api\/2\/issue$/)) {
      const created = this.create(body.fields);
      if ("error" in created) return [400, { errorMessages: [], errors: { summary: created.error } }];
      return [201, { id: "1", key: created.key, self: "" }];
    }
    if (route("POST", /^\/rest\/api\/2\/issue\/bulk$/)) {
      const issues: { key: string }[] = [];
      const errors: unknown[] = [];
      (body.issueUpdates as { fields: unknown }[]).forEach(({ fields }, n) => {
        const created = this.create(fields);
        if ("error" in created) {
          errors.push({ status: 400, failedElementNumber: n, elementErrors: { errorMessages: [], errors: { summary: created.error } } });
        } else {
          issues.push({ key: created.key });
        }
      });
      return [201, { issues, errors }];
    }
    if (route("POST", /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/)) {
      this.move(body.issues, Number(m![1]));
      return [204, null];
    }
    if (route("POST", /^\/rest\/agile\/1\.0\/backlog\/issue$/)) {
      this.move(body.issues, null);
      return [204, null];
    }
    return [404, { errorMessages: [`no route for ${method} ${api}`] }];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://localhost");
    const query = Object.fromEntries(url.searchParams);
    const body = raw ? JSON.parse(raw) : undefined;
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/^\/jira/, "");
    this.requests.push({ method, path, query, body });

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...payload === null ? {} : { "Content-Type": "application/json" }, ...headers });
      res.end(payload === null ? undefined : JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { errorMessages: ["You are not logged in"] });
    if (this.ssoProbesNeeded > 0) {
      if (method === "GET" && path === "/rest/api/2/myself") {
        this.ssoProbesNeeded--;
        if (!this.ssoProbesNeeded) return send(200, USERS.jdoe);
      }
      return send(403, { errorMessages: ["You do not have sufficient permissions to view this"] }, { "X-AUSERNAME": "jdoe" });
    }
    const failure = this.failures.find((f) => f.method === method && f.path.test(path));
    if (failure) {
      if (--failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      return send(failure.status, failure.body, failure.headers);
    }
    const [status, payload] = this.route(method, url.pathname, query, body);
    send(status, payload);
  }
}
