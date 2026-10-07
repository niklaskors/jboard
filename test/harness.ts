// The world jboard runs in during the tests: a fake Jira, a fake bench, and a browser and an editor that only
// record what they are asked to do. Imported (by setup.ts) before any of jboard's modules, since those read their
// settings from the environment when they load.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOARD_ID, FakeJira, TOKEN } from "./fakes/jira.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKES = join(ROOT, "test", "fakes");

const dir = mkdtempSync(join(tmpdir(), "jboard-test-"));
export const HOME = join(dir, "home");
const BIN = join(dir, "bin");
const files = {
  benchState: join(dir, "bench.json"),
  benchLog: join(dir, "bench.log"),
  openLog: join(dir, "open.log"),
  editorSeen: join(dir, "editor-seen.txt"),
};
mkdirSync(HOME);
mkdirSync(BIN);
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// the browser: `open` on macOS, `xdg-open` elsewhere, found on the PATH before the real ones
for (const name of ["open", "xdg-open"]) {
  writeFileSync(join(BIN, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${files.openLog}'\n`, { mode: 0o755 });
}
// the editor, by a short name as people set it
writeFileSync(join(BIN, "fake-editor"), `#!/bin/sh\nexec '${process.execPath}' '${join(FAKES, "editor.mjs")}' "$@"\n`, { mode: 0o755 });

export const jira = new FakeJira();
await jira.start();

Object.assign(process.env, {
  JIRA_SERVER: jira.url,
  JIRA_API_TOKEN: TOKEN,
  JIRA_BOARD_ID: BOARD_ID,
  HOME, // the error log goes in ~/.cache
  XDG_STATE_HOME: join(dir, "state"), // handled notifications
  XDG_CONFIG_HOME: join(dir, "config"), // no config file, unless a test writes one
  JBOARD_BENCH: join(FAKES, "bench.mjs"),

  FAKE_BENCH_STATE: files.benchState,
  FAKE_BENCH_LOG: files.benchLog,
  FAKE_OPEN_LOG: files.openLog,
  EDITOR: "fake-editor",
  FAKE_EDITOR_SEEN: files.editorSeen,
  PATH: `${BIN}:${process.env.PATH}`,
});
for (const name of ["VISUAL", "JIRA_SSO_URL", "JBOARD_THEME", "JBOARD_COLUMNS", "JBOARD_BRANCH", "COLUMNS"]) delete process.env[name];

export interface FakeMergeRequest {
  id: string;
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  url: string;
}

export interface FakeBench {
  repo: string;
  branch: string | null;
  path: string;
  removed?: string;
  mr?: FakeMergeRequest | null;
  /** Has uncommitted changes, so bench refuses to remove it. */
  dirty?: boolean;
  branchDeleted?: boolean;
}

export interface FakeBranch {
  name: string;
  local: boolean;
  remote: boolean;
  date: string;
  bench: boolean;
}

export interface BenchState {
  default: string | null;
  repos: { name: string; path: string }[];
  benches: FakeBench[];
  branches: Record<string, FakeBranch[]>;
  /** Branches that only show up after fetching. */
  fetched: Record<string, FakeBranch[]>;
  /** Commands that fail, with bench's message. */
  fail: Record<string, string>;
  /** When set, making a bench asks for this passphrase through $SSH_ASKPASS. */
  passphrase: string | null;
  /** The key ssh asks the passphrase of; jboard remembers a passphrase per key until it quits. */
  keyFile?: string;
}

export const mr = (id: string, state: FakeMergeRequest["state"], title: string, draft = false): FakeMergeRequest =>
  ({ id, title, state, draft, url: `https://gitlab.example.com/web/-/merge_requests/${id.slice(1)}` });

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

function benchFixture(): BenchState {
  return {
    default: "web",
    repos: [{ name: "web", path: join(HOME, "code", "web") }, { name: "api", path: "/srv/api" }],
    benches: [
      // PROJ-4 is in progress, but its merge request was merged: a notification
      { repo: "web", branch: "fix/PROJ-4-crash-on-empty-board", path: "/benches/web/fix/PROJ-4", mr: mr("!12", "merged", "Fix crash on empty board") },
      { repo: "api", branch: "feat/PROJ-1-login-with-sso", path: "/benches/api/feat/PROJ-1", mr: mr("!7", "open", "Login with SSO", true) },
      // PROJ-12 is not PROJ-1
      { repo: "web", branch: "feat/PROJ-12-something-else", path: "/benches/web/feat/PROJ-12" },
    ],
    branches: {
      web: [
        { name: "main", local: true, remote: true, date: hoursAgo(3), bench: false },
        { name: "feat/PROJ-1-login-with-sso", local: true, remote: true, date: hoursAgo(5), bench: false },
        { name: "fix/PROJ-4-crash-on-empty-board", local: true, remote: false, date: hoursAgo(80), bench: true },
      ],
      api: [{ name: "main", local: true, remote: true, date: hoursAgo(1), bench: false }],
    },
    fetched: { web: [{ name: "release/2.0", local: false, remote: true, date: hoursAgo(100), bench: false }] },
    fail: {},
    passphrase: null,
  };
}

export const bench = {
  command: join(FAKES, "bench.mjs"),
  state: (): BenchState => JSON.parse(readFileSync(files.benchState, "utf8")) as BenchState,
  set(change: (state: BenchState) => void): void {
    const state = this.state();
    change(state);
    writeFileSync(files.benchState, JSON.stringify(state, null, 2));
  },
  /** The arguments of every bench command run so far. */
  calls: (): string[][] => existsSync(files.benchLog)
    ? readFileSync(files.benchLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [],
};

/** What the browser was asked to open, one line of arguments per call (e.g. "-g https://…" in the background). */
export const opened = (): string[] =>
  existsSync(files.openLog) ? readFileSync(files.openLog, "utf8").trim().split("\n").filter(Boolean) : [];

export const editor = {
  /** The next edit: replace the text with this, or exit with this code (a failed editor). */
  next({ text, exit }: { text?: string; exit?: number }): void {
    if (text === undefined) delete process.env.FAKE_EDITOR_TEXT;
    else process.env.FAKE_EDITOR_TEXT = text;
    process.env.FAKE_EDITOR_EXIT = String(exit ?? 0);
  },
  /** The text the editor was opened with last. */
  seen: () => readFileSync(files.editorSeen, "utf8"),
};

/** Where jboard looks for its config file. */
export const configFile = () => join(process.env.XDG_CONFIG_HOME!, "jboard", "config.json");

export const errorLog = () => join(HOME, ".cache", "jboard", "errors.log");

/** Every test starts from the same Jira and benches, with nothing opened or edited yet. */
export function resetWorld(): void {
  jira.reset();
  writeFileSync(files.benchState, JSON.stringify(benchFixture(), null, 2));
  for (const file of [files.benchLog, files.openLog, files.editorSeen, configFile()]) rmSync(file, { force: true });
  editor.next({});
}
