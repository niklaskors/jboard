// The jboard command, run as a separate process against the fake Jira, as a user would run it.

import { execFile } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { TOKEN } from "./fakes/jira.ts";
import { bench, configFile, jira, opened, ROOT } from "./harness.ts";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Run jboard with these arguments; stdout is a pipe, so it prints the board instead of opening it. */
function jboard(args: string[], env: Record<string, string | undefined> = {}, input = ""): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "bin", "jboard.ts"), ...args],
      { env: { ...process.env, COLUMNS: "200", ...env } }, (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
      });
    child.stdin!.end(input); // answers to setup's questions
  });
}

/** The printed board's cells, one entry per card or subtask line with its key. */
const keysIn = (out: string) => [...out.matchAll(/PROJ-\d+/g)].map((m) => m[0]);

describe("printing the board", () => {
  test("shows the active sprint's columns with their cards, points and assignees", async () => {
    const { code, stdout } = await jboard(["-p"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Sprint 12");
    expect(stdout).toMatch(/ends \d+ \w+ · 10d left/);
    for (const column of ["TO DO", "IN PROGRESS", "REVIEW", "DONE"]) expect(stdout).toContain(column);
    expect(stdout).toMatch(/PROJ-1 .*3 pts ▸ 1\/2 +Jane/); // story points, subtasks done/total, first name
    expect(stdout).toContain("Login with SSO");
    expect(stdout).toMatch(/PROJ-5 .*\? pts +-/); // not estimated, unassigned
    expect(stdout).toContain("PROJ-9"); // a subtask whose story isn't in the sprint is a card itself
    expect(stdout).not.toContain("PROJ-30"); // in the next sprint
    expect(stdout).not.toContain("PROJ-40"); // in the backlog
    // points of all done cards count, also of the one left out
    expect(stdout).toMatch(/━+ +9\/14 pts done +10 cards/);
  });

  test("shows the 5 latest done cards, and all of them with -a", async () => {
    const latest = await jboard(["-p"]);
    expect(latest.stdout).toContain("+1 more (jboard -a)");
    expect(keysIn(latest.stdout)).not.toContain("PROJ-6"); // the oldest done card

    const all = await jboard(["-p", "-a"]);
    expect(all.stdout).not.toContain("more (jboard -a)");
    expect(keysIn(all.stdout)).toContain("PROJ-6");
  });

  test("-m shows only my cards: assigned to me, or with a subtask of mine", async () => {
    const { stdout } = await jboard(["-p", "-m"]);
    expect(stdout).toContain("· mine");
    expect(keysIn(stdout).sort()).toEqual(["PROJ-1", "PROJ-21", "PROJ-24", "PROJ-9"].sort());
  });

  test("--columns and $JBOARD_COLUMNS show only some columns, in any case", async () => {
    const flag = await jboard(["-p", "--columns", "in progress, review"]);
    expect(flag.stdout).toContain("IN PROGRESS");
    expect(flag.stdout).toContain("REVIEW");
    expect(flag.stdout).not.toContain("TO DO");
    expect(keysIn(flag.stdout).sort()).toEqual(["PROJ-4", "PROJ-5", "PROJ-9"]);

    const env = await jboard(["-p"], { JBOARD_COLUMNS: "To Do" });
    expect(keysIn(env.stdout)).toEqual(["PROJ-1"]);
  });

  test("an unknown column is refused, naming the board's columns", async () => {
    const { code, stderr } = await jboard(["-p", "--columns", "Doing"]);
    expect(code).toBe(1);
    expect(stderr).toContain('jboard: no column "Doing" on this board; it has: To Do, In Progress, Review, Done');
  });

  test("marks issues with a bench, and their merge request", async () => {
    const { stdout } = await jboard(["-p"]);
    expect(stdout).toMatch(/PROJ-4 ⎇ !12/);
    expect(stdout).toMatch(/PROJ-1 ⎇ !7/);
    // bench was asked about this sprint's issues only, merge requests included
    const ls = bench.calls().find((args) => args[0] === "ls")!;
    expect(ls).toContain("--mr");
    expect(ls[ls.indexOf("--match") + 1]).toContain("PROJ-1|PROJ-2|PROJ-3");
  });

  test("works without bench installed", async () => {
    const { code, stdout } = await jboard(["-p"], { JBOARD_BENCH: "/nonexistent/bench" });
    expect(code).toBe(0);
    expect(stdout).toContain("PROJ-4");
    expect(stdout).not.toContain("!12");
  });

  test("-b picks another board than $JIRA_BOARD_ID", async () => {
    const { code, stderr } = await jboard(["-p", "-b", "99"]);
    expect(code).toBe(1);
    expect(stderr).toContain("HTTP 404 on GET /rest/agile/1.0/board/99/configuration after 1 attempt(s): Board 99 does not exist");
  });

  test("a board without an active sprint says so", async () => {
    jira.sprints = jira.sprints.filter((s) => s.state !== "active");
    const { code, stderr } = await jboard(["-p"]);
    expect(code).toBe(1);
    expect(stderr).toContain("jboard: no active sprint on board 7");
  });

  test("the classic theme prints without the night theme's card bars", async () => {
    const night = await jboard(["-p"]);
    const classic = await jboard(["-p", "-t", "classic"]);
    expect(night.stdout).toContain("▎");
    expect(classic.stdout).not.toContain("▎");
    expect(classic.stdout).toContain("PROJ-1");
  });
});

describe("options and settings", () => {
  test("--help prints the usage", async () => {
    const { code, stdout } = await jboard(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Usage: jboard/);
    expect(jira.requests).toEqual([]);
  });

  test("an unknown option prints the usage and exits with 2", async () => {
    const { code, stderr } = await jboard(["--nope"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown option '--nope'");
    expect(stderr).toContain("Usage: jboard");
  });

  test("an unknown theme is refused", async () => {
    const { code, stderr } = await jboard(["-p", "-t", "neon"]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown theme "neon", choose from: night, day, classic');
  });

  test("a board is required", async () => {
    const { code, stderr } = await jboard(["-p"], { JIRA_BOARD_ID: undefined });
    expect(code).toBe(1);
    expect(stderr).toContain(`no board: set "board" in ${configFile()} or pass --board <id>`);
  });

  test("-w opens the board in the browser without loading it", async () => {
    const { code } = await jboard(["-w"]);
    expect(code).toBe(0);
    await expect.poll(opened).toEqual([`${jira.url}/secure/RapidBoard.jspa?rapidView=7`]);
    expect(jira.requests).toEqual([]);
  });

  test("a trailing slash on $JIRA_SERVER is ignored", async () => {
    const { code, stdout } = await jboard(["-p"], { JIRA_SERVER: `${jira.url}/` });
    expect(code).toBe(0);
    expect(stdout).toContain("Sprint 12");
  });

  test("a wrong token is reported with Jira's message", async () => {
    const { code, stderr } = await jboard(["-p"], { JIRA_API_TOKEN: "wrong" });
    expect(code).toBe(1);
    expect(stderr).toMatch(/HTTP 401 on GET .* after 1 attempt\(s\): You are not logged in/);
  });

  test("an unreachable Jira is reported", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const { code, stderr } = await jboard(["-p"], { JIRA_SERVER: `http://127.0.0.1:${port}` });
    expect(code).toBe(1);
    expect(stderr).toContain("jboard: cannot reach Jira: ECONNREFUSED");
  });
});

describe("the config file", () => {
  const writeConfig = (config: unknown) => {
    mkdirSync(dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), typeof config === "string" ? config : JSON.stringify(config));
  };
  /** jboard with only the config file, none of the settings in the environment. */
  const fromFile = (args: string[], env: Record<string, string | undefined> = {}, input = "") =>
    jboard(args, { JIRA_SERVER: undefined, JIRA_API_TOKEN: undefined, JIRA_BOARD_ID: undefined, JBOARD_BENCH: undefined, ...env }, input);

  test("holds the settings", async () => {
    writeConfig({ server: `${jira.url}/`, token: TOKEN, board: 7, columns: ["To Do", "Review"], theme: "classic", bench: bench.command });
    const { code, stdout } = await fromFile(["-p"]);
    expect(code).toBe(0);
    expect(stdout).toContain("TO DO (1 · 3 pts)"); // the classic theme's column header
    expect(keysIn(stdout)).toEqual(["PROJ-1", "PROJ-5"]);
    expect(stdout).toMatch(/PROJ-1 \* !7/); // bench, from the config, marked as the classic theme does
  });

  test("the environment and the options win over it", async () => {
    writeConfig({ server: "http://127.0.0.1:9/nowhere", token: "wrong", board: 99, columns: "Done" });
    const { code, stdout } = await fromFile(["-p", "--columns", "Review"], { JIRA_SERVER: jira.url, JIRA_API_TOKEN: TOKEN, JIRA_BOARD_ID: "7" });
    expect(code).toBe(0);
    expect(keysIn(stdout)).toEqual(["PROJ-5"]);
  });

  test("-w opens the server from the config", async () => {
    writeConfig({ server: "https://jira.example.com/jira", token: "x", board: "12" });
    expect((await fromFile(["-w"])).code).toBe(0);
    await expect.poll(opened).toEqual(["https://jira.example.com/jira/secure/RapidBoard.jspa?rapidView=12"]);
  });

  test("a file that isn't valid JSON is reported", async () => {
    writeConfig("{ server: nope");
    const { code, stderr } = await fromFile(["-p"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(new RegExp(`^jboard: ${configFile().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*JSON`));
  });

  test("an unknown setting is reported, naming the known ones", async () => {
    writeConfig({ server: jira.url, tokn: TOKEN });
    const { code, stderr } = await fromFile(["-p"]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown setting "tokn", choose from: server, token, board, columns, theme, ssoUrl, bench, branch, truecolor');
  });

  test("needs a server and a token", async () => {
    writeConfig({ server: jira.url, board: 7 });
    const { code, stderr } = await fromFile(["-p"]);
    expect(code).toBe(1);
    expect(stderr).toContain(`jboard: set "server" and "token" in ${configFile()} (or JIRA_SERVER and JIRA_API_TOKEN)`);
  });

  test("without one, jboard says how to set it up", async () => {
    const { code, stderr } = await fromFile(["-p"]);
    expect(code).toBe(1);
    expect(stderr).toContain(`jboard: no config yet: run jboard in a terminal to set it up, or write ${configFile()}`);
  });

  test("--setup asks for Jira, a token and a board, checks them with Jira and saves them", async () => {
    const answers = ["jira.example.com", jira.url, "wrong-token", "", TOKEN, "proj", "2"];
    const { code, stdout } = await fromFile(["--setup"], {}, `${answers.join("\n")}\n`);
    expect(code).toBe(0);
    expect(stdout).toContain("that is not a URL: it starts with https://");
    expect(stdout).toContain("that didn't work: HTTP 401: You are not logged in");
    expect(stdout).toContain("signed in as Doe, Jane");
    expect(stdout).toMatch(/1\. PROJ board \(7\)\n +2\. PROJ support \(8\)/);
    expect(stdout).not.toContain(TOKEN);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ server: jira.url, token: TOKEN, board: "8" });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600); // it holds the token

    // and from now on jboard runs with it
    writeConfig({ ...JSON.parse(readFileSync(configFile(), "utf8")), board: 7, bench: bench.command });
    expect((await fromFile(["-p"])).stdout).toContain("Sprint 12");
  });

  test("--setup again keeps the other settings, and takes a board by its id", async () => {
    writeConfig({ server: jira.url, token: "old", board: 8, theme: "day" });
    const { code, stdout } = await fromFile(["--setup"], {}, `\n${TOKEN}\n7\n`); // enter keeps the URL
    expect(code).toBe(0);
    expect(stdout).toContain("PROJ board");
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toEqual({ server: jira.url, token: TOKEN, board: "7", theme: "day" });
  });

  test("--help works whatever is in it", async () => {
    writeConfig("not json");
    const { code, stdout } = await fromFile(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`Config: ${configFile()}`);
  });
});
