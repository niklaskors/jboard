// --update: pulls the latest jboard into the clone it runs from; and noticing on the board that there is one.

import { execFile, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JiraError } from "./jira/client.ts";

/** The clone this code is in; the link on the PATH is already resolved to it. */
const CLONE = dirname(dirname(fileURLToPath(import.meta.url)));

/** Fast-forward the clone to its upstream, showing git's output. */
export function update(): void {
  const git = (...args: string[]) => spawnSync("git", ["-C", CLONE, ...args], { encoding: "utf8" });
  const before = git("rev-parse", "HEAD");
  if (before.error) throw new JiraError(`cannot run git: ${before.error.message}`);
  if (before.status !== 0) throw new JiraError(`${CLONE} is not a git clone: reinstall jboard as the README says`);

  console.log(`Updating jboard in ${CLONE}`);
  const pull = spawnSync("git", ["-C", CLONE, "pull", "--ff-only"], { stdio: "inherit" });
  if (pull.status !== 0) throw new JiraError("update failed, see git's message above");

  const after = git("rev-parse", "HEAD").stdout;
  if (after === before.stdout) return;
  const log = git("log", "--oneline", "--no-decorate", `${before.stdout.trim()}..${after.trim()}`).stdout.trimEnd();
  console.log(`\nNew in jboard:\n${log.replace(/^/gm, "  ")}`);
}

/** How many commits the clone's upstream is ahead, after fetching it quietly; 0 when that can't be told. Never asks
 * for a password: the board's askpass is left out and ssh runs in batch mode. */
export function updatesAvailable(clone = CLONE): Promise<number> {
  const { GIT_ASKPASS: _git, SSH_ASKPASS: _ssh, ...env } = process.env;
  const options = { env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }, timeout: 30_000 };
  const git = (...args: string[]) => new Promise<string>((resolve, reject) =>
    execFile("git", ["-C", clone, ...args], options, (error, stdout) => (error ? reject(error) : resolve(stdout))));
  return git("fetch", "--quiet")
    .then(() => git("rev-list", "--count", "HEAD..@{upstream}"))
    .then((count) => Number(count) || 0, () => 0);
}
