// jboard's Jira client and operations against the fake Jira: what they send, and how they handle Jira's errors.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Board } from "../src/board.ts";
import {
  assignIssue, boardProject, createIssue, createSubtasks, issueTypes, loadDescription, loadTransitions, moveToSprint,
  openSprints, searchAssignable, setField, transitionIssue,
} from "../src/jira/api.ts";
import { JiraError, onSignInProgress } from "../src/jira/client.ts";
import { BOARD_ID, POINTS_FIELD } from "./fakes/jira.ts";
import { errorLog, jira, opened } from "./harness.ts";

describe("the client", () => {
  test("retries what proxies fail intermittently, waiting as long as Retry-After says", async () => {
    jira.fail("GET", "/rest/api/2/issue/PROJ-1/transitions", 503, {}, { times: 2, headers: { "Retry-After": "0" } });
    const transitions = await loadTransitions("PROJ-1");
    expect(transitions.map((t) => t.to.name)).toContain("In Progress");
    expect(jira.calls("GET", "/rest/api/2/issue/PROJ-1/transitions")).toHaveLength(3);
  });

  test("gives up after three attempts, with Jira's message and the diagnostic headers", async () => {
    jira.fail("GET", "/rest/api/2/issue/PROJ-1/transitions", 429, { errorMessages: ["Rate limit exceeded"] },
      { times: 3, headers: { "Retry-After": "0", Via: "proxy-1" } });
    const error = await loadTransitions("PROJ-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraError);
    expect((error as Error).message).toBe("HTTP 429 on GET /rest/api/2/issue/PROJ-1/transitions after 3 attempt(s): "
      + `Rate limit exceeded (Retry-After: 0, Via: proxy-1) - details in ${errorLog()}`);
  });

  test("logs every failed attempt with its headers and body", async () => {
    jira.fail("GET", "/rest/api/2/issue/PROJ-1/transitions", 502, "<html>Bad gateway</html>", { headers: { "Retry-After": "0" } });
    await loadTransitions("PROJ-1");
    const log = readFileSync(errorLog(), "utf8");
    expect(log).toMatch(/attempt 1\/3 HTTP 502 GET http:\/\/127\.0\.0\.1:\d+\/jira\/rest\/api\/2\/issue\/PROJ-1\/transitions/);
    expect(log).toContain("retry-after: 0");
    expect(log).toContain("Bad gateway");
  });

  test("a 403 on a write is a real refusal, not retried", async () => {
    jira.fail("POST", "/rest/api/2/issue/PROJ-1/transitions", 403, { errorMessages: ["You may not move this issue"] });
    await expect(transitionIssue("PROJ-1", "t3")).rejects.toThrow(/HTTP 403 .* after 1 attempt\(s\): You may not move this issue/);
    expect(jira.calls("POST", "/rest/api/2/issue/PROJ-1/transitions")).toHaveLength(1);
    expect(jira.get("PROJ-1").status).toBe("1");
  });

  test("other client errors are not retried either", async () => {
    await expect(loadDescription("PROJ-404")).rejects.toThrow("HTTP 404 on GET /rest/api/2/issue/PROJ-404 after 1 attempt(s): Issue Does Not Exist");
    expect(jira.calls("GET", "/rest/api/2/issue/PROJ-404")).toHaveLength(1);
  });

  test("when SSO makes Jira refuse the token, signs in again in the browser and repeats the request", async () => {
    const progress: string[] = [];
    onSignInProgress((message) => progress.push(message));
    jira.ssoProbesNeeded = 1;
    const transitions = await loadTransitions("PROJ-1");
    expect(transitions.length).toBeGreaterThan(0);
    expect(progress).toEqual(["refreshing your Jira sign-in in the browser…", "signed in again"]);
    // in the background (where the OS allows), so the board keeps the focus
    const background = process.platform === "darwin" ? "-g " : "";
    expect(opened()).toEqual([`${background}${jira.url}/login.jsp?os_destination=%2Fsecure%2FDashboard.jspa`]);
  });
});

describe("operations", () => {
  test("moves an issue through its workflow", async () => {
    const step = (await loadTransitions("PROJ-1")).find((t) => t.to.name === "In Progress")!;
    await transitionIssue("PROJ-1", step.id);
    expect(jira.get("PROJ-1").status).toBe("3");
  });

  test("assigns and unassigns", async () => {
    const [clark] = await searchAssignable("PROJ-5", "kent");
    expect(clark).toEqual({ name: "ckent", displayName: "Kent, Clark" });
    expect(jira.calls("GET", "/rest/api/2/user/assignable/search")[0].query).toEqual({ issueKey: "PROJ-5", username: "kent", maxResults: "20" });
    await assignIssue("PROJ-5", clark);
    expect(jira.get("PROJ-5").assignee).toBe("ckent");
    await assignIssue("PROJ-5", null);
    expect(jira.get("PROJ-5").assignee).toBeNull();
  });

  test("reports why Jira refuses an assignee", async () => {
    await expect(assignIssue("PROJ-5", { name: "ghost" })).rejects.toThrow("User 'ghost' cannot be assigned issues.");
  });

  test("loads and changes descriptions and fields", async () => {
    jira.get("PROJ-4").description = "line one\r\nline two";
    expect(await loadDescription("PROJ-4")).toBe("line one\nline two");
    expect(await loadDescription("PROJ-5")).toBe("");
    await setField("PROJ-5", POINTS_FIELD, 8);
    expect(jira.get("PROJ-5").points).toBe(8);
  });

  test("lists the open sprints, the active one first", async () => {
    expect((await openSprints(BOARD_ID)).map((s) => s.name)).toEqual(["Sprint 12", "Sprint 13"]);
  });

  test("moves an issue with its subtasks to a sprint and back to the backlog", async () => {
    await moveToSprint("PROJ-1", 101);
    expect(["PROJ-1", "PROJ-2", "PROJ-3"].map((k) => jira.get(k).sprint)).toEqual([101, 101, 101]);
    await moveToSprint("PROJ-1", null);
    expect(jira.get("PROJ-1").sprint).toBeNull();
    expect(jira.calls("POST", "/rest/agile/1.0/backlog/issue")[0].body).toEqual({ issues: ["PROJ-1"] });
  });

  test("creates an issue in the board's project", async () => {
    const project = await boardProject(BOARD_ID, []);
    const story = (await issueTypes(project)).find((t) => t.name === "Story")!;
    const key = await createIssue(project, story.id, "Export to CSV", "As a user…");
    expect(key).toBe("PROJ-100");
    expect(jira.get(key)).toMatchObject({ summary: "Export to CSV", type: "Story", sprint: null, description: "As a user…" });
  });

  test("looks the issue types up once per project", async () => {
    await issueTypes("PROJ");
    await issueTypes("PROJ");
    expect(jira.calls("GET", /createmeta/).length).toBeLessThanOrEqual(1);
  });

  test("creates subtasks in one request, reporting the ones Jira rejects", async () => {
    const result = await createSubtasks("PROJ-4", ["Reproduce", "FAIL this one", "Fix it"]);
    expect(result).toEqual({ created: ["PROJ-100", "PROJ-101"], failed: [{ summary: "FAIL this one", reason: "Summary is invalid" }] });
    expect(jira.get("PROJ-100")).toMatchObject({ parent: "PROJ-4", type: "Sub-task", sprint: 100 });
    expect(jira.calls("POST", "/rest/api/2/issue/bulk")).toHaveLength(1);
  });
});

describe("loading the board", () => {
  test("the active sprint, with subtasks under their story and story points", async () => {
    const board = new Board(BOARD_ID);
    await board.reload();
    expect(board.sprint.name).toBe("Sprint 12");
    expect(board.columns.map((c) => c.name)).toEqual(["To Do", "In Progress", "Review", "Done"]);
    expect(board.me).toBe("jdoe");
    expect(board.pointsField).toBe(POINTS_FIELD);
    const story = board.cards.find((c) => c.key === "PROJ-1")!;
    expect(story.points).toBe(3);
    expect(story.subs.map((s) => s.key)).toEqual(["PROJ-2", "PROJ-3"]);
    // a subtask whose story is in another sprint is a card of its own
    expect(board.cards.find((c) => c.key === "PROJ-9")?.subs).toEqual([]);
    expect(board.cards.map((c) => c.key)).not.toContain("PROJ-2");
    expect(board.keys()).toHaveLength(12);
  });

  test("buckets cards by column, the latest 5 done cards unless all are asked for", async () => {
    const board = new Board(BOARD_ID);
    await board.reload();
    const { buckets, hidden, points } = board.buckets(false, false);
    expect(buckets.map((b) => b.map((c) => c.key))).toEqual([
      ["PROJ-1"], ["PROJ-4", "PROJ-9"], ["PROJ-5"], ["PROJ-24", "PROJ-23", "PROJ-22", "PROJ-21", "PROJ-20"],
    ]);
    expect(hidden).toBe(1);
    expect(points).toEqual([3, 2, 0, 9]);
    expect(board.buckets(false, true).buckets[3]).toHaveLength(6);
    expect(board.buckets(true, true).buckets.flat().map((c) => c.key).sort()).toEqual(["PROJ-1", "PROJ-21", "PROJ-24", "PROJ-9"]);
  });

  test("the team: me first, then everyone with work in the sprint by name", async () => {
    const board = new Board(BOARD_ID);
    await board.reload();
    expect(board.team().map((u) => u.name)).toEqual(["jdoe", "asmith", "bwayne"]);
  });

  test("reads every page of a big sprint", async () => {
    jira.pageSize = 4;
    const board = new Board(BOARD_ID);
    await board.reload();
    expect(board.keys()).toHaveLength(12);
    expect(jira.calls("GET", "/rest/agile/1.0/sprint/100/issue").map((r) => r.query.startAt)).toEqual(["0", "4", "8"]);
    expect(jira.calls("GET", "/rest/agile/1.0/sprint/100/issue")[0].query.fields).toBe(`summary,status,assignee,issuetype,updated,parent,${POINTS_FIELD}`);
  });

  test("another sprint by id", async () => {
    const board = new Board(BOARD_ID).view(101);
    await board.reload();
    expect(board.kind).toBe("sprint");
    expect(board.sprint.name).toBe("Sprint 13");
    expect(board.keys()).toEqual(["PROJ-30"]);
  });

  test("the backlog: one column of what isn't done", async () => {
    const board = new Board(BOARD_ID, ["Review"]).view(null);
    await board.reload();
    expect(board.kind).toBe("backlog");
    expect(board.columns.map((c) => c.name)).toEqual(["Backlog"]);
    // also issues in columns the sprint doesn't show; done ones are not in it
    const { buckets, hidden } = board.buckets(false, false);
    expect(buckets[0].map((c) => c.key)).toEqual(["PROJ-40", "PROJ-41"]);
    expect(hidden).toBe(0);
  });

  test("a failed reload keeps what was loaded", async () => {
    const board = new Board(BOARD_ID);
    await board.reload();
    jira.get("PROJ-1").summary = "Changed";
    jira.fail("GET", "/rest/agile/1.0/sprint/100/issue", 500, { errorMessages: ["Internal error"] });
    await expect(board.reload()).rejects.toThrow("Internal error");
    expect(board.cards.find((c) => c.key === "PROJ-1")?.fields.summary).toBe("Login with SSO");
    await board.reload();
    expect(board.cards.find((c) => c.key === "PROJ-1")?.fields.summary).toBe("Changed");
  });

  test("errors are logged under the home directory", async () => {
    jira.fail("GET", "/rest/api/2/myself", 500);
    await expect(new Board(BOARD_ID).reload()).rejects.toThrow(JiraError);
    expect(existsSync(errorLog())).toBe(true);
  });
});
