// `b` / `B`: open the selected issue's bench (its own git worktree, made by the bench tool) in a new terminal tab;
// on a story with subtasks, choosing the story or one of its subtasks first. `F`: the same, making the bench's
// branch from another branch. `M`: open the merge request of its bench. `D`: remove one of its benches.

import { homedir } from "node:os";
import { benchesFor, branchHasKey, branchName, listBranches, listRepos, mrStatus, openBench, removeBench, type Bench,
  type BenchRepo, type Branch, type MergeRequest } from "../bench.ts";
import { openUrl } from "../browser.ts";
import type { Card, Issue } from "../jira/types.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker } from "./picker.ts";

/** For M and D: a subtask without a bench of its own goes by its story's. */
const benchIssue = (host: DialogHost, item: Item): Issue =>
  item.parent && !host.benched.has(item.issue.key) ? item.parent : item.issue;

/** What `b` and `B` can make a bench for: a subtask itself; a story, or one of its subtasks. */
export const benchChoices = (item: Item): Issue[] => (item.parent ? [item.issue] : [item.issue, ...(item.issue as Card).subs]);

/** On a story with subtasks: whether the bench is for the story or one of its subtasks, then `next`. */
export function openBenchIssue(host: DialogHost, story: Issue, choices: Issue[], next: (issue: Issue) => void | Promise<void>): Dialog {
  return new Picker(host, {
    title: `Bench for ${story.key} or one of its subtasks`,
    action: "choose",
    options(query) {
      const q = query.trim().toLowerCase();
      return choices.filter((i) => !q || `${i.key} ${i.fields.summary}`.toLowerCase().includes(q)).map((issue) => ({
        label: `${issue === story ? "" : "↳ "}${issue.key}  ${issue.fields.summary}`,
        note: issue === story ? "the story" : issue.fields.status.name,
        current: !!host.benched.get(issue.key)?.bench, // ✓ has a bench
        dim: issue !== story && host.board.isDone(issue),
        choose: async () => next(issue),
      }));
    },
    empty: () => "no matching issue",
    loading: () => false,
  });
}

/** `b`: open the issue's bench, making it in `repo` (or bench's default) if it has none, from `from` if given. */
export function startBench(host: DialogHost, issue: Issue, repo?: string, from?: string): Promise<void> {
  return host.perform(`${issue.key}: opening its bench…`, async () => {
    const message = await openBench(issue, repo, (line) => {
      host.msg = `${issue.key}: ${line}`;
      host.draw();
    }, from);
    host.showBenches();
    return message;
  }, (message) => `bench: ${message}`);
}

const tilde = (path: string) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

/**
 * `B`: choose the repo first, e.g. for a story that needs changes in two repos. With `next`, the repo goes there
 * instead of opening the bench (as `F` does), and is chosen without asking when there is only one.
 */
export function openBenchRepo(host: DialogHost, issue: Issue, next?: (repo: string) => void | Promise<void>): Dialog {
  let repos: BenchRepo[] = [];
  let benches: Bench[] = [];
  let loading = true;

  const picker = new Picker(host, {
    title: `Bench for ${issue.key} in`,
    action: "open",
    options(query) {
      const q = query.trim().toLowerCase();
      return repos.filter((r) => !q || r.name.toLowerCase().includes(q)).map((r) => ({
        label: r.name,
        note: [r.isDefault && "default", tilde(r.path)].filter(Boolean).join(" · "),
        current: benches.some((b) => b.repo === r.name && !b.removed),
        choose: async () => (next ? next(r.name) : startBench(host, issue, r.name)),
      }));
    },
    empty: () => (loading ? "loading repos…" : repos.length ? "no matching repo" : "no repos yet: bench add <path or url>"),
    loading: () => loading,
  });

  Promise.all([listRepos(), benchesFor(issue)]).then(async ([r, b]) => {
    repos = r;
    benches = b;
    loading = false;
    if (host.dialog !== picker) return;
    if (next && r.length === 1) await next(r[0].name);
    host.draw();
  }, (e: Error) => {
    if (host.dialog !== picker) return;
    host.close();
    host.msg = `bench: ${e.message}`;
    host.draw();
  });
  return picker;
}

const ago = (iso: string) => {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  return hours < 1 ? "just now" : hours < 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} days ago`;
};

/**
 * `F`: choose the branch the issue's new branch starts from, e.g. its story's branch for a subtask. Branches of the
 * story come first, then those with a bench, then the rest, newest first. Listed at once from what git has, then
 * again after fetching.
 */
export function openBaseBranch(host: DialogHost, issue: Issue, repo: string): Dialog {
  let branch = branchName(issue); // or the branch of a bench it had in the repo, which bench would use again
  const story = issue.fields.parent?.key;
  let branches: Branch[] = [];
  let loading = true;

  const rank = (b: Branch) => (story && branchHasKey(b.name, story) ? 0 : b.bench ? 1 : 2);
  const order = (list: Branch[]) => [...list].sort((a, b) => rank(a) - rank(b)); // stable: newest first within a rank

  const picker = new Picker(host, {
    get title() {
      return `New ${branch} in ${repo}, from`;
    },
    action: "make the bench",
    shape: { max: 110 },
    options(query) {
      const q = query.trim().toLowerCase();
      return branches.filter((b) => !q || b.name.toLowerCase().includes(q)).map((b) => ({
        label: b.name,
        note: [rank(b) === 0 && "the story's", [b.local && "local", b.remote && "remote"].filter(Boolean).join(" + "), ago(b.date)]
          .filter(Boolean).join(" · "),
        current: b.bench, // ✓ has a bench
        choose: () => startBench(host, issue, repo, b.name),
      }));
    },
    empty: () => (loading ? "loading branches…" : branches.length ? "no matching branch" : "no branches"),
    loading: () => loading,
  });

  /** Show a newer list, keeping the cursor on the branch it was on. */
  const show = (list: Branch[]) => {
    const on = picker.source.options(picker.query)[picker.sel]?.label;
    branches = order(list);
    if (on) picker.sel = Math.max(0, picker.source.options(picker.query).findIndex((o) => o.label === on));
  };

  Promise.all([listBranches(repo), benchesFor(issue)]).then(([list, had]) => {
    branch = had.find((b) => b.repo === repo && b.branch)?.branch ?? branch;
    if (list.some((b) => b.name === branch)) { // bench checks an existing branch out, whatever it started from
      loading = false;
      if (host.dialog !== picker) return;
      host.close();
      host.msg = `${branch} already exists in ${repo}: b opens its bench`;
      host.draw();
      return;
    }
    show(list);
    if (host.dialog === picker) host.draw();
    return listBranches(repo, true).then((fetched) => {
      show(fetched);
      loading = false;
      if (host.dialog === picker) host.draw();
    });
  }).catch((e: Error) => {
    loading = false;
    if (host.dialog !== picker) return;
    if (branches.length) host.draw(); // fetching failed: keep what is listed
    else {
      host.close();
      host.msg = `bench: ${e.message}`;
      host.draw();
    }
  });
  return picker;
}

/** `D`: remove one of the issue's benches, keeping or deleting its local branch. */
export function openRemoveBench(host: DialogHost, item: Item): Dialog {
  const issue = benchIssue(host, item);
  let benches: Bench[] = [];
  let loading = true;

  const picker = new Picker(host, {
    title: `Remove a bench of ${issue.key}`,
    action: "remove",
    options(query) {
      const q = query.trim().toLowerCase();
      return benches.filter((b) => !q || `${b.repo} ${b.branch}`.toLowerCase().includes(q)).flatMap((b) =>
        [false, true].map((deleteBranch) => ({
          label: `${b.repo}  ${b.branch ?? tilde(b.path)}`,
          note: deleteBranch ? "and delete the branch" : "keep the branch",
          dim: deleteBranch,
          choose: () => host.perform(`removing the bench of ${b.branch}…`, async () => {
            const message = await removeBench(b, deleteBranch);
            host.showBenches();
            return message;
          }, (message) => `bench: ${message.replace("use --force to remove anyway", "bench rm --force in a terminal removes it anyway")}`),
        })));
    },
    empty: () => (loading ? "looking for benches…" : "no matching bench"),
    loading: () => loading,
  });

  benchesFor(issue).then((all) => {
    // removed benches have nothing left to remove
    const found = all.filter((b) => !b.removed);
    benches = found;
    loading = false;
    if (host.dialog !== picker) return;
    if (!found.length) {
      host.close();
      host.msg = `${issue.key} has no bench`;
    }
    host.draw();
  }, (e: Error) => {
    if (host.dialog !== picker) return;
    host.close();
    host.msg = `bench: ${e.message}`;
    host.draw();
  });
  return picker;
}

/** `M`: open the merge request (or pull request) of the issue's bench in the browser; with several, choose one. */
export function openMergeRequest(host: DialogHost, item: Item): Dialog {
  const issue = benchIssue(host, item);
  let found: Bench[] = [];
  let loading = true;
  const open = (mr: MergeRequest) => {
    host.close();
    openUrl(mr.url);
    host.msg = `opened ${mr.id} (${mrStatus(mr)}) in the browser: ${mr.title}`;
  };

  const picker = new Picker(host, {
    title: `Merge requests of ${issue.key}`,
    action: "open",
    options(query) {
      const q = query.trim().toLowerCase();
      return found.filter((b) => b.mr && `${b.repo} ${b.mr.title}`.toLowerCase().includes(q)).map((b) => ({
        label: `${b.mr!.id} ${b.mr!.title}`,
        note: `${b.repo} · ${mrStatus(b.mr!)}`,
        choose: async () => open(b.mr!),
      }));
    },
    empty: () => (loading ? "looking up merge requests…" : "no matching merge request"),
    loading: () => loading,
  });

  benchesFor(issue, true).then((benches) => {
    found = benches;
    loading = false;
    if (host.dialog !== picker) return;
    const mrs = benches.flatMap((b) => b.mr ? [b.mr] : []);
    if (mrs.length === 1) open(mrs[0]);
    else if (!mrs.length) {
      host.close();
      host.msg = benches.length ? `no merge request yet for ${benches.map((b) => b.branch).join(", ")}`
        : `${issue.key} has no bench, so no merge request to find`;
    }
    host.draw();
  }, (e: Error) => {
    if (host.dialog !== picker) return;
    host.close();
    host.msg = `bench: ${e.message}`;
    host.draw();
  });
  return picker;
}
