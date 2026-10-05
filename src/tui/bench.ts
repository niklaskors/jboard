// `b` / `B`: open the selected issue's bench (its own git worktree, made by the bench tool) in a new terminal tab.
// `M`: open the merge request of its bench. `D`: remove one of its benches.

import { homedir } from "node:os";
import { benchesFor, listRepos, mrStatus, openBench, removeBench, type Bench, type BenchRepo, type MergeRequest } from "../bench.ts";
import { openUrl } from "../browser.ts";
import type { Issue } from "../jira/types.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker } from "./picker.ts";

/** Subtasks are worked on in their story's bench, unless they have one of their own. */
const benchIssue = (host: DialogHost, item: Item): Issue =>
  item.parent && !host.benched.has(item.issue.key) ? item.parent : item.issue;

/** `b`: open the issue's bench, making it in `repo` (or bench's default) if it has none. */
export function startBench(host: DialogHost, item: Item, repo?: string): Promise<void> {
  const issue = benchIssue(host, item);
  const via = issue === item.issue ? "" : ` (for its subtask ${item.issue.key})`;
  return host.perform(`${issue.key}: opening its bench…`, async () => {
    const message = await openBench(issue, repo, (line) => {
      host.msg = `${issue.key}: ${line}`;
      host.draw();
    });
    host.showBenches();
    return message + via;
  }, (message) => `bench: ${message}`);
}

const tilde = (path: string) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

/** `B`: choose the repo first, e.g. for a story that needs changes in two repos. */
export function openBenchRepo(host: DialogHost, item: Item): Dialog {
  const issue = benchIssue(host, item);
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
        choose: () => startBench(host, item, r.name),
      }));
    },
    empty: () => (loading ? "loading repos…" : repos.length ? "no matching repo" : "no repos yet: bench add <path or url>"),
    loading: () => loading,
  });

  Promise.all([listRepos(), benchesFor(issue)]).then(([r, b]) => {
    repos = r;
    benches = b;
    loading = false;
    if (host.dialog === picker) host.draw();
  }, (e: Error) => {
    if (host.dialog !== picker) return;
    host.close();
    host.msg = `bench: ${e.message}`;
    host.draw();
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
