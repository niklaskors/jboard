// Benches from the board: b, B and F make or open one, M opens its merge request, D removes one; and ssh asking
// for a passphrase while bench runs.

import { describe, expect, test } from "vitest";
import { startAskpass } from "../src/askpass.ts";
import { bench, opened } from "./harness.ts";
import { openBoard } from "./tui.ts";

/** The bench commands run so far, the ones only listing benches left out. */
const changes = () => bench.calls().filter((args) => args[0] !== "ls");

describe("b: open the bench", () => {
  test("opens the bench an issue has", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("b");
    expect(board.status()).toContain("PROJ-4: opened bench fix/PROJ-4-crash-on-empty-board in web");
    expect(changes()).toEqual([["new", "fix/PROJ-4-crash-on-empty-board", "--json", "--open", "tab", "--title", "PROJ-4 Crash on empty board", "--repo", "web"]]);
  });

  test("makes a new one in the default repo, and marks the card", async () => {
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("b");
    expect(board.status()).toContain("PROJ-5: new bench feat/PROJ-5-upgrade-node in web");
    expect(bench.state().benches.map((b) => b.branch)).toContain("feat/PROJ-5-upgrade-node");
    await board.waitFor(/PROJ-5 ⎇ \? pts/);
  });

  test("on a story with subtasks, asks whether it is for the story or one of them", async () => {
    const board = await openBoard();
    await board.press("b");
    expect(board.screen()).toContain("╭─ Bench for PROJ-1 or one of its subtasks");
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^PROJ-1  Login with SSO +the story$/),
      expect.stringMatching(/^↳ PROJ-2  Add SAML config +To Do$/),
      expect.stringMatching(/^↳ PROJ-3  Write login tests +Done$/),
    ]);
    await board.press("<down>", "<enter>");
    expect(board.status()).toContain("PROJ-2: new bench feat/PROJ-2-add-saml-config in web");
  });

  test("shows bench's progress, and its error", async () => {
    bench.set((s) => (s.fail.new = "web: could not fetch origin"));
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("b");
    expect(board.status()).toContain("bench: web: could not fetch origin");
    expect(board.frames.some((f) => f.includes("PROJ-5: opening its bench…"))).toBe(true);
  });
});

describe("B and F: choose where", () => {
  test("B chooses the repo first", async () => {
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("B");
    await board.waitFor("web");
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^web +default · ~\/code\/web$/), expect.stringMatching(/^api +\/srv\/api$/),
    ]);
    await board.type("api");
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-5: new bench feat/PROJ-5-upgrade-node in api");
  });

  test("F chooses the repo and the branch to start from, also from the remote", async () => {
    const board = await openBoard();
    board.select("PROJ-2");
    await board.press("F");
    expect(board.screen()).toContain("Bench for PROJ-2 in");
    await board.waitFor("web");
    await board.press("<enter>");
    expect(board.screen()).toContain("╭─ New feat/PROJ-2-add-saml-config in web, from");
    await board.waitFor("release/2.0"); // after fetching
    // the story's branch first, then the ones with a bench, then the rest, newest first
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^feat\/PROJ-1-login-with-sso +the story's · local \+ remote · 5 h ago$/),
      expect.stringMatching(/^fix\/PROJ-4-crash-on-empty-board ✓ +local · 3 days ago$/),
      expect.stringMatching(/^main +local \+ remote · 3 h ago$/),
      expect.stringMatching(/^release\/2.0 +remote · 4 days ago$/),
    ]);
    await board.press("<enter>");
    expect(board.status()).toContain("PROJ-2: new bench feat/PROJ-2-add-saml-config in web from feat/PROJ-1-login-with-sso");
    expect(changes().at(-1)).toEqual(expect.arrayContaining(["--repo", "web", "--from", "feat/PROJ-1-login-with-sso"]));
  });

  test("F on an issue whose branch exists already sends you to b", async () => {
    const board = await openBoard();
    await board.press("F", "<down>"); // the story, not a subtask
    await board.press("<up>", "<enter>");
    await board.waitFor("web");
    await board.press("<enter>");
    await board.waitFor("feat/PROJ-1-login-with-sso already exists in web: b opens its bench");
    expect(board.tui.dialog).toBeNull();
  });
});

describe("M: merge request", () => {
  test("opens the merge request of the issue's bench", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("M");
    await board.waitFor("opened !12 (merged) in the browser: Fix crash on empty board");
    await expect.poll(opened).toEqual(["https://gitlab.example.com/web/-/merge_requests/12"]);
  });

  test("a subtask without a bench goes by its story's", async () => {
    const board = await openBoard();
    board.select("PROJ-3");
    await board.press("M");
    await board.waitFor("opened !7 (draft) in the browser: Login with SSO");
  });

  test("with several, asks which", async () => {
    bench.set((s) => s.benches.push({ repo: "web", branch: "fix/PROJ-4-follow-up", path: "/x", mr: { id: "!15", title: "Follow-up", state: "open", draft: false, url: "https://gitlab.example.com/web/-/merge_requests/15" } }));
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("M");
    await board.waitFor("!15 Follow-up");
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^!12 Fix crash on empty board +web · merged$/), expect.stringMatching(/^!15 Follow-up +web · open$/),
    ]);
    await board.press("<down>", "<enter>");
    expect(board.status()).toContain("opened !15 (open)");
  });

  test("says so when there is none", async () => {
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("M");
    await board.waitFor("PROJ-5 has no bench, so no merge request to find");
  });
});

describe("D: remove a bench", () => {
  test("removes it, keeping or deleting its branch", async () => {
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("D");
    await board.waitFor("keep the branch");
    expect(board.box().slice(1)).toEqual([
      expect.stringMatching(/^web  fix\/PROJ-4-crash-on-empty-board +keep the branch$/),
      expect.stringMatching(/^web  fix\/PROJ-4-crash-on-empty-board +and delete the branch$/),
    ]);
    await board.press("<down>", "<enter>");
    expect(board.status()).toContain("removed the bench of fix/PROJ-4-crash-on-empty-board in web and its local branch");
    expect(changes()).toEqual([["rm", "fix/PROJ-4-crash-on-empty-board", "--repo", "web", "--delete-branch"]]);
    await board.waitFor(/PROJ-4 !12 2 pts/); // its merge request is still known
  });

  test("bench refusing to remove uncommitted work says how to force it", async () => {
    bench.set((s) => (s.benches[0].dirty = true));
    const board = await openBoard();
    board.select("PROJ-4");
    await board.press("D");
    await board.waitFor("keep the branch");
    await board.press("<enter>");
    expect(board.message()).toBe("bench: fix/PROJ-4-crash-on-empty-board has uncommitted changes, bench rm --force in a terminal removes it anyway");
  });

  test("an issue without a bench has nothing to remove", async () => {
    const board = await openBoard();
    board.select("PROJ-5");
    await board.press("D");
    await board.waitFor("PROJ-5 has no bench");
  });
});

describe("questions from ssh while bench runs", () => {
  test("the passphrase is asked on the board, hidden, and bench goes on", async () => {
    bench.set((s) => (s.passphrase = "hunter2"));
    const board = await openBoard();
    startAskpass((prompt, secret) => board.tui.ask(prompt, secret));
    board.select("PROJ-5");
    const opening = board.press("b"); // bench waits for the answer
    await board.waitFor("╭─ bench needs your passphrase");
    expect(board.screen()).toContain("Enter passphrase for key '/home/me/.ssh/id_ed25519':");
    await board.type("hunter2");
    expect(board.screen()).toContain("› •••••••█");
    await board.press("<enter>");
    await opening;
    expect(board.status()).toContain("PROJ-5: new bench feat/PROJ-5-upgrade-node in web");
  });

  test("cancelling it fails bench", async () => {
    bench.set((s) => {
      s.passphrase = "hunter2";
      s.keyFile = "/home/me/.ssh/id_work"; // not one given before
    });
    const board = await openBoard();
    startAskpass((prompt, secret) => board.tui.ask(prompt, secret));
    board.select("PROJ-5");
    const opening = board.press("b");
    await board.waitFor("bench needs your passphrase");
    await board.press("<esc>");
    await opening;
    expect(board.status()).toContain("bench: git@gitlab.example.com: Permission denied (publickey).");
  });
});
