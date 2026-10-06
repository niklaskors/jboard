// Benches: a git worktree per issue, made and opened by the separate `bench` tool (github.com/niklaskors/bench).
// jboard only runs its command line, so bench stays optional: without it, the b and B keys say how to get it.

import { spawn } from "node:child_process";
import { askpassEnv } from "./askpass.ts";
import type { Issue } from "./jira/types.ts";

/** The bench command; set JBOARD_BENCH when it isn't on the PATH as `bench`. */
const BENCH = process.env.JBOARD_BENCH || "bench";

/** Branch names for new benches; {type} is fix for bugs and feat otherwise. */
const BRANCH_FORMAT = process.env.JBOARD_BRANCH || "{type}/{key}-{summary}";

export class BenchError extends Error {}

/** A merge request (GitLab) or pull request (GitHub), as bench reports it. */
export interface MergeRequest {
  id: string; // !123 or #123
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  url: string;
}

export interface Bench {
  repo: string;
  branch: string | null;
  path: string;
  /** When the bench was removed: its files are gone, but bench remembers the branch and its merge request. */
  removed?: string;
  /** Only when listed with merge requests; null when the branch has none. */
  mr?: MergeRequest | null;
}

/** open, draft, merged or closed. */
export const mrStatus = (mr: MergeRequest) => (mr.draft && mr.state === "open" ? "draft" : mr.state);

/** Per issue: whether it has a bench now, and the merge request of its benches, removed ones included. */
export interface BenchMark {
  bench: boolean;
  /** null: none, or not looked up yet. */
  mr: MergeRequest | null;
}

/** The issues with a bench or a merge request from one, and their marks. */
export type Benched = Map<string, BenchMark>;

export interface BenchRepo {
  name: string;
  path: string;
  isDefault: boolean;
}

/** Run bench and return its stdout; each progress line it writes to stderr goes to `progress`. */
function run(args: string[], progress?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdin stays ours: the board has the terminal in raw mode
    // questions from the git and ssh it runs go to the board, not the terminal (see askpass.ts)
    const child = spawn(BENCH, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...askpassEnv() } });
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

/** A regular expression for branches of these issues, as bench ls --match takes it. */
const branchesOf = (keys: string[]) => `(^|[^a-z0-9])(${keys.join("|")})(?![0-9])`;

/**
 * The benches bench knows, removed ones included: with `keys`, only those of these issues; with `mrs`, also their
 * merge requests (a second or so slower). Empty when bench isn't installed, so the board works without it.
 */
export async function listBenches({ mrs = false, keys }: { mrs?: boolean; keys?: string[] } = {}): Promise<Bench[]> {
  if (keys && !keys.length) return [];
  try {
    const args = ["ls", "--json", "--all", ...mrs ? ["--mr"] : [], ...keys ? ["--match", branchesOf(keys)] : []];
    return JSON.parse(await run(args)) as Bench[];
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

const MR_ORDER = { open: 0, merged: 1, closed: 2 };

/**
 * Which of these issues have a bench, and the most relevant merge request among their benches (open first),
 * removed benches included. An issue whose benches are all removed is only marked when one had a merge request.
 */
export function benchedIssues(benches: Bench[], keys: string[]): Benched {
  const benched: Benched = new Map();
  for (const key of keys) {
    const mine = benches.filter((b) => branchHasKey(b.branch, key));
    const mrs = mine.flatMap((b) => b.mr ? [b.mr] : []).sort((a, b) => MR_ORDER[a.state] - MR_ORDER[b.state]);
    const bench = mine.some((b) => !b.removed);
    if (bench || mrs.length) benched.set(key, { bench, mr: mrs[0] ?? null });
  }
  return benched;
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

/** The benches whose branch is for this issue, in any repo, removed ones included; `mrs` looks up merge requests too. */
export async function benchesFor(issue: Issue, mrs = false): Promise<Bench[]> {
  return (await listBenches({ mrs, keys: [issue.key] })).filter((b) => branchHasKey(b.branch, issue.key));
}

/** Remove a bench; bench refuses when it has uncommitted or unpushed work. */
export async function removeBench(bench: Bench, deleteBranch: boolean): Promise<string> {
  const args = ["rm", bench.branch ?? bench.path, "--repo", bench.repo];
  if (deleteBranch) args.push("--delete-branch");
  await run(args);
  return `removed the bench of ${bench.branch} in ${bench.repo}${deleteBranch ? " and its local branch" : ""}`;
}

/**
 * Open the issue's bench in a new terminal tab, making it first if needed. `repo` picks the repo
 * (default: the repo of the bench the issue already has, else bench's default).
 * Returns what to tell the user.
 */
export async function openBench(issue: Issue, repo: string | undefined, progress: (line: string) => void): Promise<string> {
  // a bench it has wins, else the branch of a removed one, so its commits and merge request carry on
  const existing = (await benchesFor(issue)).filter((b) => !repo || b.repo === repo)
    .sort((a, b) => Number(!!a.removed) - Number(!!b.removed))[0];
  const branch = existing?.branch ?? branchName(issue);
  const args = ["new", branch, "--json", "--open", "tab"];
  const where = repo ?? existing?.repo;
  if (where) args.push("--repo", where);
  const result = JSON.parse(await run(args, progress)) as { repo: string; created: boolean; warm?: boolean };
  return result.created
    ? `${issue.key}: ${existing?.removed ? "bench again for" : "new bench"} ${branch} in ${result.repo}${result.warm ? "" : " (setting up in the new tab)"}`
    : `${issue.key}: opened bench ${branch} in ${result.repo}`;
}
