// Changing issues from the board: each dialog, the Jira requests it makes, and what the board shows afterwards.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { POINTS_FIELD } from "./fakes/jira.ts";
import { bench, editor, jira, mr, opened } from "./harness.ts";
import { openBoard } from "./tui.ts";

describe("s: status", () => {
  test("moves the issue to the status chosen, typing to filter", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("s");
    expect(board.screen()).toContain("╭─ Move PROJ-4 (now In Progress)");
    await board.waitFor("Rejected");
    // where each status is on the board; rejecting comes last
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^To Do +→ To Do$/), expect.stringMatching(/^In Review +→ Review$/),
      expect.stringMatching(/^Archived +not on board$/), expect.stringMatching(/^Done +→ Done$/),
      expect.stringMatching(/^Rejected +→ Done$/),
    ]);
    await board.type("rev");
    expect(board.screen()).not.toContain("Archived");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-4 is now In Review");
    expect(jira.get("PROJ-4").status).toBe("10");
    expect(board.rows()[4]).toMatch(/IN PROGRESS +1 · 0 pts .* REVIEW +2 · 2 pts/);
    expect(board.selected()).toBe("PROJ-4"); // the cursor goes with it
  });

  test("a subtask's status changes under its story", async () => {
    const board = await openBoard();
    board.select("PROJ-2");
    await board.press("s");
    await board.waitFor("In Progress");
    await board.type("done");
    await board.press("<enter>");
    expect(board.screen()).toMatch(/PROJ-1 3 pts ▾ 2\/2/);
    expect(board.screen()).toMatch(/↳ PROJ-2 Done/);
  });

  test("a refused change says what Jira said, and how to do it in Jira", async () => {
    const board = await openBoard();
    jira.fail("POST", "/rest/api/2/issue/PROJ-1/transitions", 400, { errorMessages: [], errors: { resolution: "Resolution is required." } });
    await board.press("s");
    await board.waitFor("In Progress");
    await board.type("done");
    await board.press("<enter>");
    expect(board.message()).toMatch(/^status change failed: HTTP 400 .*: Resolution is required\. - details in .*\(needs extra fields\? press o to do it in Jira\)$/);
    expect(jira.get("PROJ-1").status).toBe("1");
  });

  test("esc changes nothing", async () => {
    const board = await openBoard();
    await board.press("s");
    await board.waitFor("In Progress");
    await board.press("<esc>");
    expect(board.screen()).not.toContain("╭─ Move");
    expect(jira.calls("POST", /transitions/)).toEqual([]);
  });
});

describe("A: assign", () => {
  test("lists the team, me first, and assigns", async () => {
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("A");
    expect(board.box().slice(1)).toEqual([
      "Unassigned ✓", expect.stringMatching(/^Jane Doe +me$/), expect.stringMatching(/^Alex Smith +team$/),
      expect.stringMatching(/^Bruce Wayne +team$/),
    ]);
    await board.press("<down>", "<enter>"); // it starts on me
    expect(board.status()).toContain("PROJ-5 assigned to Alex Smith");
    expect(jira.get("PROJ-5").assignee).toBe("asmith");
    expect(board.screen()).toMatch(/PROJ-5 \? pts +Alex/);
  });

  test("typing searches everyone in Jira", async () => {
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("A");
    await board.type("kent");
    expect(board.screen()).toContain("searching…");
    await board.waitFor(/│ Clark Kent +ckent │/);
    // once typing paused, not per key
    expect(jira.calls("GET", "/rest/api/2/user/assignable/search").map((r) => r.query.username)).toEqual(["kent"]);
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-5 assigned to Clark Kent");
    expect(board.screen()).toMatch(/PROJ-5 \? pts +Clark/);
  });

  test("unassigns", async () => {
    const board = await openBoard();
    await board.press("A", "<up>", "<enter>");
    expect(board.status()).toContain("PROJ-1 assigned to nobody");
    expect(jira.get("PROJ-1").assignee).toBeNull();
  });
});

describe("p: story points", () => {
  test("typing replaces the points, a decimal comma included", async () => {
    const board = await openBoard();
    await board.press("p");
    expect(board.screen()).toContain("currently 3");
    await board.type("1,5");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-1: 1.5 story points");
    expect(jira.calls("PUT", "/rest/api/2/issue/PROJ-1")[0].body).toEqual({ fields: { [POINTS_FIELD]: 1.5 } });
    expect(board.rows()[2]).toContain("9/12.5 pts done");
  });

  test("empty clears them", async () => {
    const board = await openBoard();
    await board.press("p", "<bs>", "<enter>");
    expect(board.status()).toContain("PROJ-1: story points cleared");
    expect(jira.get("PROJ-1").points).toBeNull();
    expect(board.screen()).toMatch(/PROJ-1 \? pts/);
  });

  test("on a subtask they go on its story", async () => {
    const board = await openBoard();
    board.select("PROJ-2");
    await board.press("p");
    expect(board.screen()).toContain("Story points for PROJ-1");
  });

  test("anything but a number is refused", async () => {
    const board = await openBoard();
    await board.press("p");
    await board.type("1..");
    await board.press("<enter>");
    expect(board.status()).toContain('"1.." is not a number of story points');
    expect(jira.calls("PUT", /issue/)).toEqual([]);
  });
});

describe("c: new subtasks", () => {
  test("creates a subtask per line, bullets dropped, and shows them", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("c");
    await board.type("- Reproduce it");
    await board.press("<enter>");
    await board.type("2. Fix it");
    await board.press("<enter>", "<enter>");
    expect(board.screen()).toContain("ctrl+s create 2");
    await board.press("<C-s>");
    expect(board.status()).toContain("created PROJ-100, PROJ-101 under PROJ-4");
    expect(jira.calls("POST", "/rest/api/2/issue/bulk")[0].body.issueUpdates.map((u: { fields: { summary: string } }) => u.fields.summary))
      .toEqual(["Reproduce it", "Fix it"]);
    expect(board.screen()).toMatch(/PROJ-4 2 pts ▾ 0\/2/);
    expect(board.screen()).toMatch(/↳ PROJ-100 To Do/);
    expect(board.selected()).toBe("PROJ-100");
  });

  test("reports the lines Jira rejected", async () => {
    const board = await openBoard();
    await board.press("c");
    await board.type("Good one");
    await board.press("<enter>");
    await board.type("FAIL this");
    await board.press("<C-s>");
    expect(board.status()).toContain('created PROJ-100 under PROJ-1 · failed: "FAIL this": Summary is invalid');
  });

  test("needs at least one line", async () => {
    const board = await openBoard();
    await board.press("c", "<C-s>");
    expect(board.status()).toContain("type at least one subtask, one per line");
  });

  test("not under a subtask whose story isn't in the sprint", async () => {
    const board = await openBoard();
    board.select("PROJ-9");
    await board.press("c");
    expect(board.status()).toContain("PROJ-9 is a subtask whose story is not in this sprint");
  });
});

describe("d: description", () => {
  test("shows it rendered, and as written with r", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    expect(board.screen()).toContain("╭─ PROJ-1: Login with SSO");
    expect(board.screen()).toContain("Goal");
    expect(board.screen()).not.toContain("h1.");
    await board.press("r");
    expect(board.screen()).toContain("h1. Goal");
    expect(board.screen()).toContain("Users sign in with *SSO*.");
    await board.press("q");
    expect(board.screen()).not.toContain("╭─ PROJ-1");
  });

  test("w opens the issue in the browser", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    await board.press("w");
    expect(board.screen()).toContain("opened PROJ-1 in the browser");
    await expect.poll(opened).toEqual([`${jira.url}/browse/PROJ-1`]);
  });

  test("e edits it in $EDITOR and saves it to Jira", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    editor.next({ text: "Users sign in with *SAML*.\n\n" });
    await board.press("e");
    expect(editor.seen()).toBe("h1. Goal\nUsers sign in with *SSO*.\n\n* one\n* two\n");
    expect(jira.get("PROJ-1").description).toBe("Users sign in with *SAML*.");
    await board.press("r"); // redraw
    expect(board.screen()).toContain("saved");
    expect(board.screen()).toContain("Users sign in with *SAML*.");
  });

  test("an editor that fails changes nothing", async () => {
    const board = await openBoard();
    await board.press("d");
    await board.waitFor("Users sign in with SSO.");
    editor.next({ text: "half-written", exit: 1 });
    await board.press("e", "j");
    expect(board.screen()).toContain("did not exit cleanly, the description is unchanged");
    expect(jira.calls("PUT", /issue/)).toEqual([]);
  });

  test("an issue without one can get one", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("d");
    await board.waitFor("no description · press e to write one");
    editor.next({ text: "Steps to reproduce" });
    await board.press("e", "j");
    expect(editor.seen()).toBe("");
    expect(jira.get("PROJ-4").description).toBe("Steps to reproduce");
  });
});

describe("S: move to a sprint", () => {
  test("moves a story with its subtasks to another sprint", async () => {
    const board = await openBoard();
    board.select("PROJ-2");
    await board.press("S");
    await board.waitFor("Sprint 13");
    expect(board.screen()).toContain("╭─ Move PROJ-1 (with its subtasks) to");
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^Sprint 12 ✓ +active · ends \d+ \w+$/), expect.stringMatching(/^Sprint 13 +future · starts \d+ \w+$/),
      expect.stringMatching(/^Backlog +no sprint$/),
    ]);
    await board.press("<enter>"); // it starts on the first sprint it isn't in
    expect(board.status()).toContain("PROJ-1 moved to Sprint 13");
    expect(jira.get("PROJ-2").sprint).toBe(101);
    expect(board.tui.board.keys()).not.toContain("PROJ-1");
    expect(board.rows()[4]).toMatch(/TO DO +0 · 0 pts/);
  });

  test("moves an issue back to the backlog, also shown in the backlog tab", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("S");
    await board.waitFor("Backlog");
    await board.type("back");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-4 moved to the backlog");
    await board.press("<tab>");
    expect(board.screen()).toContain("PROJ-4");
  });
});

describe("C: new issue", () => {
  test("creates a story in the backlog", async () => {
    const board = await openBoard();
    await board.press("C");
    await board.waitFor("╭─ New issue in PROJ");
    expect(board.screen()).toMatch(/ Story +Task +Bug /);
    await board.type("Export to CSV");
    await board.press("<enter>");
    expect(board.status()).toContain("created PROJ-100 (Story) in the backlog");
    expect(jira.get("PROJ-100")).toMatchObject({ summary: "Export to CSV", type: "Story", sprint: null });
  });

  test("creates a bug with a description in the active sprint, and selects it", async () => {
    const board = await openBoard();
    await board.press("C");
    await board.waitFor(/Story +Task +Bug/);
    await board.press("<right>", "<right>", "<down>");
    await board.waitFor(/sprint +‹ Sprint 12 › +active/);
    editor.next({ text: "It crashes.\n" });
    await board.press("<C-e>");
    expect(board.screen()).toContain("description: 1 line · ctrl+e to change");
    await board.type("Crash on login");
    await board.press("<enter>");
    expect(board.status()).toContain("created PROJ-100 (Bug) in Sprint 12");
    expect(jira.get("PROJ-100")).toMatchObject({ type: "Bug", sprint: 100, description: "It crashes." });
    expect(board.selected()).toBe("PROJ-100");
    expect(board.screen()).toMatch(/▌ ▲ PROJ-100/);
  });

  test("says so when it was created but could not be moved to the sprint", async () => {
    const board = await openBoard();
    jira.fail("POST", "/rest/agile/1.0/sprint/100/issue", 400, { errorMessages: ["Sprint is closed"] });
    await board.press("C");
    await board.waitFor(/Story +Task +Bug/);
    await board.press("<down>");
    await board.waitFor("‹ Sprint 12 ›");
    await board.type("Late addition");
    await board.press("<enter>");
    expect(board.message()).toMatch(/^created PROJ-100 \(Story\) in the backlog, but moving it to Sprint 12 failed: HTTP 400 .*Sprint is closed.*\(press S on it\)$/);
  });

  test("needs a summary", async () => {
    const board = await openBoard();
    await board.press("C");
    await board.waitFor(/Story +Task +Bug/);
    await board.press("<enter>");
    expect(board.screen()).toContain("type a summary first");
    expect(jira.calls("POST", "/rest/api/2/issue")).toEqual([]);
  });
});

describe("n: notifications", () => {
  const handledFile = () => join(process.env.XDG_STATE_HOME!, "jboard", "handled.json");

  test("a merged merge request of an issue that isn't done shows on the bell, and n moves the issue to done", async () => {
    const board = await openBoard();
    board.tui.showBenches();
    await board.waitFor("PROJ-4: !12 was merged · press n to move it to done");
    expect(board.rows()[0]).toMatch(/🔔 1$/);
    expect(board.screen()).toMatch(/PROJ-4 ⎇ !12/);

    await board.press("n");
    expect(board.screen()).toContain("╭─ Merged (1)");
    expect(board.screen()).toMatch(/PROJ-4  !12 merged +now In Progress → Done/);
    await board.press("<enter>");
    expect(jira.get("PROJ-4").status).toBe("10001");
    expect(board.status()).toContain("PROJ-4 is now Done");
    expect(board.screen()).not.toContain("╭─ Merged");
    expect(board.rows()[0]).toMatch(/🔔$/);
    expect(JSON.parse(readFileSync(handledFile(), "utf8"))).toEqual(["PROJ-4 https://gitlab.example.com/web/-/merge_requests/12"]);
  });

  /** Only these merged merge requests, not PROJ-4's from the fixture. */
  const merged = (...benches: [string, string][]) => bench.set((s) => {
    s.benches[0].mr = null;
    for (const [branch, id] of benches) s.benches.push({ repo: "web", branch, path: `/benches/${branch}`, mr: mr(id, "merged", branch) });
  });

  test("x dismisses one, o opens its merge request", async () => {
    merged(["feat/PROJ-5-upgrade-node", "!21"], ["feat/PROJ-2-saml", "!22"]);
    const board = await openBoard();
    board.tui.showBenches();
    await board.waitFor("2 merge requests were merged · press n");
    await board.press("n");
    expect(board.screen()).toMatch(/PROJ-2  !22 merged +now To Do → Done[^]*PROJ-5  !21 merged +now In Review → Done/);
    await board.press("x");
    expect(board.screen()).toContain("dismissed PROJ-2");
    expect(board.screen()).toContain("╭─ Merged (1)");
    await board.press("o");
    expect(board.screen()).toContain("opened !21 in the browser");
    await expect.poll(opened).toEqual(["https://gitlab.example.com/web/-/merge_requests/21"]);
    await board.press("x"); // the last one
    expect(board.screen()).not.toContain("╭─ Merged");
    expect(board.status()).toContain("dismissed PROJ-5");
    expect(jira.calls("POST", /transitions/)).toEqual([]);
  });

  test("an issue that can't reach done in one step is left for s", async () => {
    merged(["feat/PROJ-5-upgrade-node", "!31"]);
    const board = await openBoard();
    board.tui.showBenches();
    await board.waitFor("PROJ-5: !31 was merged");
    jira.fail("GET", "/rest/api/2/issue/PROJ-5/transitions", 200, { transitions: [] });
    await board.press("n", "<enter>");
    expect(board.screen()).toContain("PROJ-5 can't go from In Review to Done in one step: use s on its card");
    expect(board.tui.notifications()).toHaveLength(1);
  });
});
