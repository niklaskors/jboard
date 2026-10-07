// jboard and the bench tool: the commands it runs, how it reads their answers, and questions from ssh and git.

import { execFile } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { askpassEnv, startAskpass } from "../src/askpass.ts";
import {
  benchedIssues, benchesFor, branchName, BenchError, listBenches, listBranches, listRepos, openBench, removeBench,
} from "../src/bench.ts";
import { Board } from "../src/board.ts";
import type { Issue } from "../src/jira/types.ts";
import { markHandled, notifications } from "../src/notify.ts";
import { BOARD_ID } from "./fakes/jira.ts";
import { bench, mr } from "./harness.ts";

const issue = (key: string, summary: string, type = "Story"): Issue => ({
  key, fields: { summary, status: { id: "1", name: "To Do" }, assignee: null, issuetype: { name: type }, updated: "" },
});

describe("bench", () => {
  test("lists the benches of some issues, with their merge requests", async () => {
    const benches = await listBenches({ mrs: true, keys: ["PROJ-1", "PROJ-4"] });
    expect(benches.map((b) => b.branch)).toEqual(["fix/PROJ-4-crash-on-empty-board", "feat/PROJ-1-login-with-sso"]);
    expect(benches[0].mr).toMatchObject({ id: "!12", state: "merged" });
    expect(bench.calls()).toEqual([["ls", "--json", "--all", "--mr", "--match", "(^|[^a-z0-9])(PROJ-1|PROJ-4)(?![0-9])"]]);
  });

  test("lists nothing, without running bench, for no issues", async () => {
    expect(await listBenches({ keys: [] })).toEqual([]);
    expect(bench.calls()).toEqual([]);
  });

  test("lists nothing when bench fails or isn't installed", async () => {
    bench.set((s) => (s.fail.ls = "broken"));
    expect(await listBenches()).toEqual([]);
  });

  test("marks issues by their benches: open merge requests first, PROJ-12 is not PROJ-1", async () => {
    bench.set((s) => s.benches.push(
      { repo: "web", branch: "feat/PROJ-1-login-with-sso", path: "/old", removed: "2026-09-01", mr: mr("!3", "closed", "First try") },
      { repo: "web", branch: "feat/PROJ-5-upgrade-node", path: "/gone", removed: "2026-09-01" },
      { repo: "web", branch: "feat/PROJ-6-dark-mode", path: "/gone", removed: "2026-09-01", mr: mr("!9", "merged", "Dark mode") },
    ));
    const benched = benchedIssues(await listBenches({ mrs: true }), ["PROJ-1", "PROJ-4", "PROJ-5", "PROJ-6", "PROJ-12"]);
    expect(benched.get("PROJ-1")).toEqual({ bench: true, mr: expect.objectContaining({ id: "!7" }) });
    expect(benched.get("PROJ-4")).toEqual({ bench: true, mr: expect.objectContaining({ id: "!12" }) });
    expect(benched.has("PROJ-5")).toBe(false); // only a removed bench, without a merge request
    expect(benched.get("PROJ-6")).toEqual({ bench: false, mr: expect.objectContaining({ id: "!9" }) });
    expect(benched.get("PROJ-12")).toEqual({ bench: true, mr: null });
  });

  test("lists repos, the default first, and branches, fetched ones on request", async () => {
    expect((await listRepos()).map((r) => [r.name, r.isDefault])).toEqual([["web", true], ["api", false]]);
    expect((await listBranches("web")).map((b) => b.name)).not.toContain("release/2.0");
    expect((await listBranches("web", true)).map((b) => b.name)).toContain("release/2.0");
    expect(bench.calls().at(-1)).toEqual(["branches", "--json", "--repo", "web", "--fetch"]);
  });

  test("names branches after the issue: fix for bugs, the summary as a slug", () => {
    expect(branchName(issue("PROJ-7", "Fix the café login!", "Bug"))).toBe("fix/PROJ-7-fix-the-cafe-login");
    expect(branchName(issue("PROJ-8", "A very long summary that goes on and on about many things"))).toBe("feat/PROJ-8-a-very-long-summary-that-goes-on-and-on");
  });

  test("makes a new bench in the default repo, reporting bench's progress", async () => {
    const progress: string[] = [];
    const message = await openBench(issue("PROJ-5", "Upgrade Node", "Task"), undefined, (line) => progress.push(line));
    expect(message).toBe("PROJ-5: new bench feat/PROJ-5-upgrade-node in web");
    expect(progress).toEqual(["fetching origin", "making the worktree"]);
    expect(bench.calls().at(-1)).toEqual(["new", "feat/PROJ-5-upgrade-node", "--json", "--open", "tab", "--title", "PROJ-5 Upgrade Node"]);
    expect(await benchesFor(issue("PROJ-5", ""))).toHaveLength(1);
  });

  test("opens the bench an issue has, in its repo", async () => {
    const message = await openBench(issue("PROJ-1", "Login with SSO"), undefined, () => {});
    expect(message).toBe("PROJ-1: opened bench feat/PROJ-1-login-with-sso in api");
    expect(bench.calls().at(-1)).toContain("--repo");
  });

  test("makes a removed bench again on its old branch, so its commits carry on", async () => {
    bench.set((s) => s.benches.push({ repo: "web", branch: "feat/PROJ-5-old-name", path: "/x", removed: "2026-09-01" }));
    const message = await openBench(issue("PROJ-5", "Upgrade Node"), undefined, () => {});
    expect(message).toBe("PROJ-5: bench again for feat/PROJ-5-old-name in web");
  });

  test("makes a bench in another repo from another branch", async () => {
    const message = await openBench(issue("PROJ-1", "Login with SSO"), "web", () => {}, "release/2.0");
    expect(message).toBe("PROJ-1: new bench feat/PROJ-1-login-with-sso in web from release/2.0");
    expect(bench.calls().at(-1)).toEqual(expect.arrayContaining(["--repo", "web", "--from", "release/2.0"]));
  });

  test("passes bench's own error on", async () => {
    bench.set((s) => (s.fail.new = "web has no remote origin"));
    await expect(openBench(issue("PROJ-5", "x"), undefined, () => {})).rejects.toThrow(new BenchError("web has no remote origin"));
  });

  test("says how to get bench when it isn't installed", async () => {
    process.env.JBOARD_BENCH = "/nonexistent/bench";
    try {
      // the command is read when bench.ts loads, so load it again
      vi.resetModules();
      const fresh = await import("../src/bench.ts");
      await expect(fresh.openBench(issue("PROJ-5", "x"), undefined, () => {})).rejects.toThrow(
        '"/nonexistent/bench" not found: install bench (github.com/niklaskors/bench) or set "bench" in the config');
    } finally {
      process.env.JBOARD_BENCH = bench.command;
    }
  });

  test("removes a bench, deleting its branch when asked, and refuses one with uncommitted work", async () => {
    const [proj4] = await benchesFor(issue("PROJ-4", ""));
    expect(await removeBench(proj4, true)).toBe("removed the bench of fix/PROJ-4-crash-on-empty-board in web and its local branch");
    expect(bench.state().benches[0]).toMatchObject({ removed: expect.any(String), branchDeleted: true });

    bench.set((s) => (s.benches[1].dirty = true));
    const [proj1] = await benchesFor(issue("PROJ-1", ""));
    await expect(removeBench(proj1, false)).rejects.toThrow("feat/PROJ-1-login-with-sso has uncommitted changes, use --force to remove anyway");
  });
});

describe("questions from ssh and git", () => {
  /** Run the askpass program as ssh would, each `prompt` asked by the same program (a retry after a wrong answer). */
  const ssh = (...prompts: string[]): Promise<{ code: number; answers: string[] }> =>
    new Promise((resolve) => {
      // through a shell of its own, so each call is another program asking, as with every git run
      const script = `${prompts.map((_, i) => `"$SSH_ASKPASS" "$${i + 1}" || exit 1`).join("; ")}; exit 0`;
      execFile("/bin/sh", ["-c", script, "ssh", ...prompts], { env: { ...process.env, ...askpassEnv() } }, (error, stdout) =>
        resolve({ code: error ? Number(error.code) : 0, answers: stdout.split("\n").filter(Boolean) }));
    });

  test("are asked on the board and answered, a passphrase once per run", async () => {
    const asked: [string, boolean][] = [];
    const answers = ["wrong", "hunter2", "yes"];
    startAskpass(async (prompt, secret) => {
      asked.push([prompt, secret]);
      return answers.shift() ?? null;
    });
    expect(askpassEnv()).toMatchObject({ SSH_ASKPASS_REQUIRE: "force", GIT_ASKPASS: askpassEnv().SSH_ASKPASS });

    const passphrase = "Enter passphrase for key '/home/me/.ssh/id_ed25519':";
    // the same program asking again: the answer was wrong, so it is asked again
    expect(await ssh(passphrase, passphrase)).toEqual({ code: 0, answers: ["wrong", "hunter2"] });
    // another git run asking the same: the passphrase that worked, without asking
    expect(await ssh(passphrase)).toEqual({ code: 0, answers: ["hunter2"] });
    expect(asked).toEqual([[passphrase, true], [passphrase, true]]);

    // a yes/no question is not secret
    const confirm = "Are you sure you want to continue connecting (yes/no)?";
    process.env.SSH_ASKPASS_PROMPT = "confirm";
    try {
      expect(await ssh(confirm)).toEqual({ code: 0, answers: ["yes"] });
    } finally {
      delete process.env.SSH_ASKPASS_PROMPT;
    }
    expect(asked.at(-1)).toEqual([confirm, false]);
  });

  test("a cancelled question fails the program asking", async () => {
    startAskpass(async () => null);
    expect((await ssh("Password for 'https://gitlab.example.com':")).code).toBe(1);
  });
});

describe("notifications", () => {
  test("are the issues whose merge request was merged but which aren't done, until handled", async () => {
    const board = new Board(BOARD_ID);
    await board.reload();
    bench.set((s) => s.benches.push(
      // done already: nothing to do
      { repo: "web", branch: "feat/PROJ-21-cache-avatars", path: "/x", removed: "2026-09-01", mr: mr("!20", "merged", "Cache avatars") },
      { repo: "web", branch: "feat/PROJ-5-upgrade-node", path: "/y", mr: mr("!21", "merged", "Upgrade Node") },
    ));
    const benched = benchedIssues(await listBenches({ mrs: true, keys: board.keys() }), board.keys());
    expect(notifications(board, benched).map((n) => `${n.issue.key} ${n.mr.id}`)).toEqual(["PROJ-4 !12", "PROJ-5 !21"]);

    markHandled(notifications(board, benched)[0]);
    expect(notifications(board, benched).map((n) => n.issue.key)).toEqual(["PROJ-5"]);
  });
});
