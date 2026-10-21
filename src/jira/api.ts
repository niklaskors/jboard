// The Jira operations jboard performs, apart from loading the board (see board.ts).

import { get, jiraMessage, JiraError, JiraUnanswered, request } from "./client.ts";
import type { Sprint, Transition, User } from "./types.ts";

/** The workflow steps Jira allows from the issue's current status. */
export async function loadTransitions(issueKey: string): Promise<Transition[]> {
  return (await get<{ transitions: Transition[] }>(`/rest/api/2/issue/${issueKey}/transitions`)).transitions;
}

export function transitionIssue(issueKey: string, transitionId: string): Promise<void> {
  return request("POST", `/rest/api/2/issue/${issueKey}/transitions`, { body: { transition: { id: transitionId } } });
}

/** Users who may be assigned the issue and match a name or username. */
export function searchAssignable(issueKey: string, query: string): Promise<User[]> {
  return get<User[]>("/rest/api/2/user/assignable/search", { issueKey, username: query, maxResults: 20 });
}

/** Assign the issue, or unassign it with `null`. */
export function assignIssue(issueKey: string, user: User | null): Promise<void> {
  return request("PUT", `/rest/api/2/issue/${issueKey}/assignee`, { body: { name: user?.name ?? null } });
}

/** The issue's description as Jira stores it (wiki markup on Server and Data Center); "" when it has none. */
export async function loadDescription(issueKey: string): Promise<string> {
  const res = await get<{ fields: { description: string | null } }>(`/rest/api/2/issue/${issueKey}`, { fields: "description" });
  return (res.fields.description ?? "").replace(/\r\n?/g, "\n");
}

export function setField(issueKey: string, field: string, value: unknown): Promise<void> {
  return request("PUT", `/rest/api/2/issue/${issueKey}`, { body: { fields: { [field]: value } } });
}

/** The board's active and future sprints, active first. */
export async function openSprints(boardId: string): Promise<Sprint[]> {
  const res = await get<{ values: Sprint[] }>(`/rest/agile/1.0/board/${boardId}/sprint`, { state: "active,future", maxResults: 50 });
  return res.values.sort((a, b) => Number(a.state === "future") - Number(b.state === "future"));
}

/** Move an issue to a sprint, or back to the backlog with `null`; its subtasks go with it. */
export function moveToSprint(issueKey: string, sprintId: number | null): Promise<void> {
  const path = sprintId === null ? "/rest/agile/1.0/backlog/issue" : `/rest/agile/1.0/sprint/${sprintId}/issue`;
  return request("POST", path, { body: { issues: [issueKey] }, repeatable: true });
}

export interface IssueType {
  id: string;
  name: string;
  subtask: boolean;
}

const issueTypeCache = new Map<string, Promise<IssueType[]>>();

/** The issue types a project can create, looked up once. */
export function issueTypes(project: string): Promise<IssueType[]> {
  let types = issueTypeCache.get(project);
  if (!types) {
    types = get<{ values: IssueType[] }>(`/rest/api/2/issue/createmeta/${project}/issuetypes`).then((r) => r.values);
    types.catch(() => issueTypeCache.delete(project)); // try again next time
    issueTypeCache.set(project, types);
  }
  return types;
}

/** The issue type id for subtasks in a project (usually "Subtask" or "Sub-task"). */
async function subtaskTypeId(project: string): Promise<string> {
  const types = (await issueTypes(project)).filter((t) => t.subtask);
  const type = types.find((t) => /^sub-?task$/i.test(t.name)) ?? types[0];
  if (!type) throw new JiraError(`project ${project} has no subtask issue type`);
  return type.id;
}

export interface Project {
  key: string;
  name: string;
}

/** The projects whose issues a board shows. */
export async function boardProjects(boardId: string): Promise<Project[]> {
  return (await get<{ values: Project[] }>(`/rest/agile/1.0/board/${boardId}/project`)).values;
}

/** The project new issues of a board go in: its only project, else the one most of its issues are in. */
export async function boardProject(boardId: string, keys: string[]): Promise<string> {
  const values = await boardProjects(boardId);
  if (values.length === 1) return values[0].key;
  const count = (project: string) => keys.filter((k) => k.startsWith(`${project}-`)).length;
  const best = values.sort((a, b) => count(b.key) - count(a.key))[0];
  if (!best) throw new JiraError(`board ${boardId} has no project to create issues in`);
  return best.key;
}

const CREATE_ATTEMPTS = 3;

/**
 * Create an issue without a sprint, so it starts in the backlog; returns its key. When Jira doesn't answer,
 * it may have created the issue anyway, so that is looked up before the create is sent again.
 */
export async function createIssue(project: string, typeId: string, summary: string, description: string): Promise<string> {
  const fields: Record<string, unknown> = { project: { key: project }, issuetype: { id: typeId }, summary };
  if (description) fields.description = description;
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return (await request<{ key: string }>("POST", "/rest/api/2/issue", { body: { fields } })).key;
    } catch (e) {
      if (!(e instanceof JiraUnanswered)) throw e;
      const key = await findCreated(project, typeId, summary, started).catch(() => undefined);
      if (key) return key;
      if (key === undefined || attempt >= CREATE_ATTEMPTS) throw e; // unknown whether it exists, or out of tries
    }
  }
}

/** The issue with this summary and type that I created since `since`, or null when there is none. */
async function findCreated(project: string, typeId: string, summary: string, since: number): Promise<string | null> {
  const minutes = Math.ceil((Date.now() - since) / 60_000) + 1; // JQL counts back from Jira's clock, not ours
  const jql = `project = "${project}" AND issuetype = ${typeId} AND reporter = currentUser() AND created >= -${minutes}m`
    + " ORDER BY created DESC";
  const res = await get<{ issues: { key: string; fields: { summary: string } }[] }>("/rest/api/2/search",
    { jql, fields: "summary", maxResults: 20 });
  return res.issues.find((i) => i.fields.summary === summary)?.key ?? null;
}

interface BulkResult {
  issues: { key: string }[];
  errors?: { status: number; failedElementNumber: number; elementErrors: unknown }[];
}

/** Create subtasks under a story in one bulk request; Jira may reject some lines and still create the rest. */
export async function createSubtasks(parentKey: string, summaries: string[]):
  Promise<{ created: string[]; failed: { summary: string; reason: string }[] }> {
  const project = parentKey.slice(0, parentKey.lastIndexOf("-"));
  const typeId = await subtaskTypeId(project);
  const res = await request<BulkResult>("POST", "/rest/api/2/issue/bulk", {
    body: {
      issueUpdates: summaries.map((summary) => ({
        fields: { project: { key: project }, parent: { key: parentKey }, issuetype: { id: typeId }, summary },
      })),
    },
  });
  return {
    created: res.issues.map((i) => i.key),
    failed: (res.errors ?? []).map((e) => ({
      summary: summaries[e.failedElementNumber] ?? "?",
      reason: jiraMessage(JSON.stringify(e.elementErrors)) || `HTTP ${e.status}`,
    })),
  };
}
