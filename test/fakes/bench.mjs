#!/usr/bin/env node
// A stand-in for the bench tool (github.com/niklaskors/bench), run by jboard as $JBOARD_BENCH. It answers the
// commands jboard runs from a JSON state file ($FAKE_BENCH_STATE), updates it like bench would, and logs each call
// to $FAKE_BENCH_LOG, one JSON array of arguments per line.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_BENCH_STATE;
const state = JSON.parse(readFileSync(stateFile, "utf8"));
appendFileSync(process.env.FAKE_BENCH_LOG, `${JSON.stringify(args)}\n`);

const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const fail = (message) => {
  process.stderr.write(`bench: ${message}\n`);
  process.exit(1);
};
const out = (value) => process.stdout.write(JSON.stringify(value));
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));

const command = args[0];
if (state.fail?.[command]) fail(state.fail[command]);

if (command === "ls") {
  const match = option("--match");
  const re = match ? new RegExp(match, "i") : null;
  out(state.benches.filter((b) => !re || re.test(b.branch ?? "")).map(({ dirty, mr, ...b }) => (args.includes("--mr") ? { ...b, mr: mr ?? null } : b)));
} else if (command === "repos") {
  out({ default: state.default, repos: state.repos });
} else if (command === "branches") {
  const repo = option("--repo");
  out([...state.branches[repo] ?? [], ...args.includes("--fetch") ? state.fetched?.[repo] ?? [] : []]);
} else if (command === "new") {
  const branch = args[1];
  const repo = option("--repo") ?? state.default;
  process.stderr.write("bench: fetching origin\n");
  if (state.passphrase) {
    // like git fetching over ssh with a key that has a passphrase
    const res = spawnSync(process.env.SSH_ASKPASS ?? "false", [`Enter passphrase for key '${state.keyFile ?? "/home/me/.ssh/id_ed25519"}': `], { encoding: "utf8" });
    if (res.status !== 0 || res.stdout.trim() !== state.passphrase) fail("git@gitlab.example.com: Permission denied (publickey).");
  }
  process.stderr.write("bench: making the worktree\n");
  const existing = state.benches.find((b) => b.repo === repo && b.branch === branch);
  if (existing && !existing.removed) {
    out({ repo, created: false, path: existing.path });
  } else {
    if (existing) delete existing.removed;
    else state.benches.push({ repo, branch, path: `/benches/${repo}/${branch}` });
    save();
    out({ repo, created: true, warm: true, path: `/benches/${repo}/${branch}` });
  }
} else if (command === "rm") {
  const repo = option("--repo");
  const bench = state.benches.find((b) => b.repo === repo && (b.branch === args[1] || b.path === args[1]));
  if (!bench || bench.removed) fail(`no bench ${args[1]} in ${repo}`);
  if (bench.dirty) fail(`${bench.branch} has uncommitted changes, use --force to remove anyway`);
  bench.removed = "2026-10-07T10:00:00Z";
  if (args.includes("--delete-branch")) bench.branchDeleted = true;
  save();
} else {
  fail(`unknown command ${command}`);
}
