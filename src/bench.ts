// Benches: a git worktree per issue, made and opened by the separate `bench` tool (github.com/niklaskors/bench).
// jboard only runs its command line, so bench stays optional: without it, the b and B keys say how to get it.

import { spawn } from "node:child_process";
import type { Issue } from "./jira/types.ts";

/** The bench command; set JBOARD_BENCH when it isn't on the PATH as `bench`. */
const BENCH = process.env.JBOARD_BENCH || "bench";

/** Branch names for new benches; {type} is fix for bugs and feat otherwise. */
const BRANCH_FORMAT = process.env.JBOARD_BRANCH || "{type}/{key}-{summary}";

export class BenchError extends Error {}

export interface Bench {
  repo: string;
  branch: string | null;
  path: string;
}

export interface BenchRepo {
  name: string;
  path: string;
  isDefault: boolean;
}

/** Run bench and return its stdout; each progress line it writes to stderr goes to `progress`. */
function run(args: string[], progress?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdin stays ours: the board has the terminal in raw mode
    const child = spawn(BENCH, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk;
      const lines = err.split("\n").map((l) => l.replace(/^bench: /, "").trim()).filter(Boolean);
      if (lines.length) progress?.(lines[lines.length - 1]);
    });
    child.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT"
      ? new BenchError(`"${BENCH}" not found: install bench (github.com/niklaskors/bench) or set JBOARD_BENCH`)
      : e));
    child.on("exit", (code) => {
      if (code === 0) return resolve(out);
      const last = err.trim().split("\n").pop()?.replace(/^bench: /, "");
      reject(new BenchError(last || `${BENCH} ${args[0]} failed (exit ${code})`));
    });
  });
}

/** Every bench in every repo bench knows; empty when bench isn't installed, so the board works without it. */
export async function listBenches(): Promise<Bench[]> {
  try {
    return JSON.parse(await run(["ls", "--json"])) as Bench[];
  } catch {
    return [];
  }
}

export async function listRepos(): Promise<BenchRepo[]> {
  const { default: def, repos } = JSON.parse(await run(["repos", "--json"])) as
    { default: string | null; repos: { name: string; path: string }[] };
  return repos.map((r) => ({ ...r, isDefault: r.name === def }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** Whether a branch is for this issue: the key on its own, so PROJ-12 doesn't match PROJ-123. */
export function branchHasKey(branch: string | null, key: string): boolean {
  return !!branch && new RegExp(`(^|[^a-z0-9])${key}(?![0-9])`, "i").test(branch);
}

/** The issues that have a bench. */
export function keysWithBench(benches: Bench[], keys: string[]): Set<string> {
  return new Set(keys.filter((key) => benches.some((b) => branchHasKey(b.branch, key))));
}

/** "Fix the café login!" -> "fix-the-cafe-login", cut at a word to keep branch names readable. */
function slug(text: string, max = 40): string {
  const s = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  return cut.slice(0, cut.lastIndexOf("-") > 0 ? cut.lastIndexOf("-") : max);
}

export function branchName(issue: Issue): string {
  const type = /bug/i.test(issue.fields.issuetype.name) ? "fix" : "feat";
  return BRANCH_FORMAT.replace(/\{type\}/g, type).replace(/\{key\}/g, issue.key)
    .replace(/\{summary\}/g, slug(issue.fields.summary)).replace(/-+$/, "");
}

/**
 * Open the issue's bench in a new terminal tab, making it first if needed. `repo` picks the repo
 * (default: the repo of the bench the issue already has, else bench's default).
 * Returns what to tell the user.
 */
export async function openBench(issue: Issue, repo: string | undefined, progress: (line: string) => void): Promise<string> {
  const existing = (await listBenches()).find((b) => branchHasKey(b.branch, issue.key) && (!repo || b.repo === repo));
  const branch = existing?.branch ?? branchName(issue);
  const args = ["new", branch, "--json", "--open", "tab"];
  const where = repo ?? existing?.repo;
  if (where) args.push("--repo", where);
  const result = JSON.parse(await run(args, progress)) as { repo: string; created: boolean; warm?: boolean };
  return result.created
    ? `${issue.key}: new bench ${branch} in ${result.repo}${result.warm ? "" : " (setting up in the new tab)"}`
    : `${issue.key}: opened bench ${branch} in ${result.repo}`;
}
