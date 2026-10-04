// `b` / `B`: open the selected issue's bench (its own git worktree, made by the bench tool) in a new terminal tab.

import { homedir } from "node:os";
import { branchHasKey, listBenches, listRepos, openBench, type Bench, type BenchRepo } from "../bench.ts";
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
    await host.loadBenches();
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
        current: benches.some((b) => b.repo === r.name && branchHasKey(b.branch, issue.key)),
        choose: () => startBench(host, item, r.name),
      }));
    },
    empty: () => (loading ? "loading repos…" : repos.length ? "no matching repo" : "no repos yet: bench add <path or url>"),
    loading: () => loading,
  });

  Promise.all([listRepos(), listBenches()]).then(([r, b]) => {
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
