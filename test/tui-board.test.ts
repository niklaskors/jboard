// The interactive board: what it shows, moving around, views, search, tabs and refreshing.

import { describe, expect, test } from "vitest";
import { onSignInProgress } from "../src/jira/client.ts";
import { jira, opened } from "./harness.ts";
import { openBoard } from "./tui.ts";

describe("the board", () => {
  test("shows the sprint's columns with their cards, the first card selected", async () => {
    const board = await openBoard();
    const [tabs, , header, , columns] = board.rows();
    expect(tabs).toMatch(/^ Sprint 12 +Backlog +🔔$/);
    expect(header).toMatch(/Sprint 12 +ends \d+ \w+ · 10d left +━+ +9\/14 pts done +10 cards/);
    expect(columns).toMatch(/TO DO +1 · 3 pts +● IN PROGRESS +2 · 2 pts +● REVIEW +1 · 0 pts +● DONE +6 · 9 pts/);
    expect(board.screen()).toMatch(/▌ ● PROJ-1 3 pts ▸ 1\/2 +Jane/); // the selected card's bar is thicker
    expect(board.screen()).toMatch(/▎ ▲ PROJ-4 2 pts +Alex/);
    expect(board.screen()).toContain("+1 more · press a");
    expect(board.status()).toMatch(/^\?  keys +\/  search +n  notifications/);
    expect(board.selected()).toBe("PROJ-1");
  });

  test("moves between columns and cards", async () => {
    const board = await openBoard();
    await board.press("l");
    expect(board.selected()).toBe("PROJ-4");
    await board.press("j");
    expect(board.selected()).toBe("PROJ-9");
    await board.press("j"); // stays on the last card
    expect(board.selected()).toBe("PROJ-9");
    await board.press("<right>", "<right>", "G");
    expect(board.selected()).toBe("PROJ-20");
    await board.press("g");
    expect(board.selected()).toBe("PROJ-24");
    await board.press("<left>", "<up>", "h", "h", "h");
    expect(board.selected()).toBe("PROJ-1");
  });

  test("scrolls a long column to keep the selected card in view", async () => {
    const board = await openBoard({ height: 16 });
    await board.press("l", "l", "l");
    expect(board.screen()).not.toContain("PROJ-20");
    expect(board.rows()[5]).toMatch(/─↓─$/);
    await board.press("G");
    expect(board.screen()).toContain("PROJ-20");
    expect(board.screen()).not.toContain("PROJ-24");
    expect(board.rows()[5]).toMatch(/↑$/);
    await board.press("<C-u>"); // half of 9 rows is one card of 3
    expect(board.selected()).toBe("PROJ-21");
    await board.press("<C-d>");
    expect(board.selected()).toBe("PROJ-20");
  });

  test("shows and hides a story's subtasks", async () => {
    const board = await openBoard();
    await board.press("<enter>");
    expect(board.screen()).toMatch(/PROJ-1 3 pts ▾ 1\/2/);
    expect(board.screen()).toMatch(/↳ PROJ-2 To Do +Jane/);
    expect(board.screen()).toMatch(/↳ PROJ-3 Done +Alex/);
    await board.press("j");
    expect(board.selected()).toBe("PROJ-2");
    await board.press("<space>"); // on a subtask: its story closes
    expect(board.screen()).not.toContain("↳ PROJ-2");
    expect(board.selected()).toBe("PROJ-1");

    await board.press("l", "<enter>");
    expect(board.status()).toContain("PROJ-4 has no subtasks");
  });

  test("e shows and hides all subtasks", async () => {
    const board = await openBoard();
    await board.press("e");
    expect(board.screen()).toContain("↳ PROJ-2");
    await board.press("e");
    expect(board.screen()).not.toContain("↳ PROJ-2");
  });

  test("m shows only my cards", async () => {
    const board = await openBoard();
    await board.press("l", "m");
    expect(board.rows()[2]).toMatch(/4 cards  · mine$/);
    expect(board.screen()).not.toContain("PROJ-4");
    expect(board.selected()).toBe("PROJ-9");
    await board.press("m");
    expect(board.screen()).toContain("PROJ-4");
    expect(board.selected()).toBe("PROJ-9");
  });

  test("a shows all done cards", async () => {
    const board = await openBoard();
    await board.press("a");
    expect(board.screen()).toContain("PROJ-6");
    expect(board.screen()).not.toContain("more · press a");
    await board.press("a");
    expect(board.screen()).not.toContain("PROJ-6");
  });

  test("v shows a line per issue instead of cards", async () => {
    const board = await openBoard({ width: 240 }); // room for points and names in a line
    await board.press("v");
    expect(board.screen()).toMatch(/● PROJ-1 ▸ Login with SSO +3 pts +Jane/);
    await board.press("<enter>");
    expect(board.screen()).toMatch(/↳ PROJ-2 To Do Add SAML config +Jane/);
    await board.press("v");
    expect(board.screen()).toMatch(/PROJ-1 3 pts ▾ 1\/2/);
  });

  test("? lists the keys", async () => {
    const board = await openBoard();
    await board.press("?");
    expect(board.screen()).toContain("╭─ Keys");
    expect(board.screen()).toMatch(/s +change status/);
    await board.press("<esc>");
    expect(board.screen()).not.toContain("╭─ Keys");
  });

  test("o and w open the issue and the board with it selected in the browser", async () => {
    const board = await openBoard();
    await board.press("l", "o");
    expect(board.status()).toContain("opened PROJ-4 in browser");
    await board.press("w");
    expect(board.status()).toContain("opened the board in the browser · press r to reload here");
    await expect.poll(() => opened().sort()).toEqual([`${jira.url}/browse/PROJ-4`, `${jira.url}/secure/RapidBoard.jspa?rapidView=7&selectedIssue=PROJ-4`]);
  });
});

describe("search", () => {
  test("jumps to matches by key or summary as you type, opening a story to show its subtask", async () => {
    const board = await openBoard();
    await board.press("/");
    expect(board.status()).toContain("type a key or part of a summary");
    await board.type("saml");
    expect(board.selected()).toBe("PROJ-2");
    expect(board.screen()).toContain("↳ PROJ-2");
    expect(board.status()).toMatch(/\/ +saml█ +1\/1/);
    await board.press("<bs>", "<bs>", "<bs>", "<bs>");
    await board.type("proj-2");
    expect(board.selected()).toBe("PROJ-2");
    expect(board.status()).toMatch(/1\/6/); // PROJ-2, PROJ-20 … PROJ-24
    await board.press("<C-n>");
    expect(board.selected()).toBe("PROJ-24");
    expect(board.screen()).not.toContain("↳ PROJ-2"); // the story opened for the last match closes again
  });

  test("enter keeps the match, and ctrl+n / ctrl+p go on from there", async () => {
    const board = await openBoard();
    await board.press("/");
    await board.type("crash");
    await board.press("<enter>");
    expect(board.selected()).toBe("PROJ-4");
    expect(board.status()).not.toContain("crash");
    await board.press("<C-n>");
    expect(board.status()).toContain('1/1 for "crash"');
  });

  test("esc goes back to where the search started", async () => {
    const board = await openBoard();
    await board.press("l", "/");
    await board.type("dark");
    expect(board.status()).toContain("no match"); // PROJ-6 is a hidden done card
    await board.press("<bs>", "<bs>", "<bs>", "<bs>");
    await board.type("tests");
    expect(board.selected()).toBe("PROJ-3");
    await board.press("<esc>");
    expect(board.selected()).toBe("PROJ-4");
    expect(board.screen()).not.toContain("↳ PROJ-3");
  });
});

describe("sprints and the backlog", () => {
  test("tab shows the next sprint and the backlog, loading each the first time", async () => {
    const board = await openBoard();
    board.tui.loadTabs();
    await board.waitFor(/^ Sprint 12 +Sprint 13 +Backlog/);

    await board.press("<tab>");
    expect(board.rows()[2]).toMatch(/Sprint 13 +starts \d+ \w+/);
    expect(board.screen()).toContain("PROJ-30");
    expect(board.screen()).not.toContain("PROJ-1 ");

    await board.press("<tab>");
    // the backlog is one list, without what is done
    expect(board.rows()[4]).toMatch(/BACKLOG +2 · 3 pts/);
    expect(board.screen()).toMatch(/● PROJ-40 Search filters +3 pts +-/);
    expect(board.screen()).toMatch(/▲ PROJ-41 Typo in footer +\? pts +Bruce/);
    expect(board.screen()).not.toContain("PROJ-42");

    await board.press("<tab>", "<tab>", "<tab>");
    expect(jira.calls("GET", "/rest/agile/1.0/board/7/backlog")).toHaveLength(1);
    expect(jira.calls("GET", "/rest/agile/1.0/sprint/101/issue")).toHaveLength(1);
  });

  test("coming back to a tab puts the cursor where it was", async () => {
    const board = await openBoard();
    await board.press("l", "j", "<tab>", "<S-tab>");
    expect(board.selected()).toBe("PROJ-9");
  });

  test("a tab that fails to load is not shown", async () => {
    const board = await openBoard();
    jira.fail("GET", "/rest/agile/1.0/board/7/backlog", 500, { errorMessages: ["Backlog unavailable"] });
    await board.press("<tab>");
    expect(board.status()).toContain("loading the backlog failed: HTTP 500");
    expect(board.rows()[2]).toContain("Sprint 12");
    await board.press("<tab>");
    expect(board.screen()).toContain("PROJ-40");
  });
});

describe("refreshing", () => {
  test("r loads the board again", async () => {
    const board = await openBoard();
    jira.get("PROJ-1").summary = "Login with SAML";
    jira.get("PROJ-5").status = "10001";
    await board.press("r");
    expect(board.status()).toContain("refreshed");
    expect(board.screen()).toContain("Login with SAML");
    expect(board.rows()[4]).toMatch(/REVIEW +0 · 0 pts/);
  });

  test("a failed refresh keeps the board as it was", async () => {
    const board = await openBoard();
    jira.get("PROJ-1").summary = "Login with SAML";
    jira.fail("GET", "/rest/agile/1.0/sprint/100/issue", 500, { errorMessages: ["Down for maintenance"] });
    await board.press("r");
    expect(board.status()).toContain("refresh failed: HTTP 500");
    expect(board.status()).toContain("Down for maintenance");
    expect(board.screen()).toContain("Login with SSO");
  });

  test("Jira refusing the token is fixed by signing in again, shown in the status line", async () => {
    const board = await openBoard();
    onSignInProgress((message) => { // as the board does when it starts
      board.tui.msg = message;
      board.tui.draw();
    });
    jira.ssoProbesNeeded = 1;
    await board.press("r");
    expect(board.status()).toContain("refreshed");
    expect(board.frames.map((f) => f.includes("refreshing your Jira sign-in in the browser"))).toContain(true);
  });
});
