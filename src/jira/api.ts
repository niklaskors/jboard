// The Jira operations jboard performs, apart from loading the board (see board.ts).

import { get, jiraMessage, JiraError, request } from "./client.ts";
import type { Transition, User } from "./types.ts";

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

export function setField(issueKey: string, field: string, value: unknown): Promise<void> {
  return request("PUT", `/rest/api/2/issue/${issueKey}`, { body: { fields: { [field]: value } } });
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
