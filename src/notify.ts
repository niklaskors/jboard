// Notifications: issues whose merge request has been merged while the issue isn't done yet.
// Each is shown until it is handled (moved to done, or dismissed); handled ones are remembered across runs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Benched, MergeRequest } from "./bench.ts";
import type { Board } from "./board.ts";
import type { Issue } from "./jira/types.ts";

const HANDLED_FILE = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "jboard", "handled.json");
const KEEP = 500; // handled notifications remembered; the oldest are forgotten first

export interface Notification {
  issue: Issue;
  mr: MergeRequest;
}

/** One merge request of one issue: the same merge request can be on a story and its subtask. */
const id = (n: Notification) => `${n.issue.key} ${n.mr.url}`;

let handled: string[] | null = null;

function loadHandled(): string[] {
  if (!handled) {
    try {
      handled = JSON.parse(readFileSync(HANDLED_FILE, "utf8")) as string[];
    } catch {
      handled = [];
    }
  }
  return handled;
}

/** Don't show this notification again, also after a restart. */
export function markHandled(n: Notification): void {
  const list = loadHandled().filter((h) => h !== id(n));
  list.push(id(n));
  handled = list.slice(-KEEP);
  try {
    mkdirSync(dirname(HANDLED_FILE), { recursive: true });
    writeFileSync(HANDLED_FILE, JSON.stringify(handled));
  } catch {
    // remembering is best effort: at worst it is shown again next time
  }
}

/**
 * The issues on the board whose merge request was merged but which are not in the last (done) column yet.
 * Only an issue's most relevant merge request counts, so an issue with another one still open is left alone.
 */
export function notifications(board: Board, benched: Benched): Notification[] {
  const seen = new Set(loadHandled());
  const out: Notification[] = [];
  for (const issue of board.cards.flatMap((card) => [card, ...card.subs])) {
    const mr = benched.get(issue.key)?.mr;
    if (mr?.state !== "merged" || board.isDone(issue)) continue;
    const n = { issue, mr };
    if (!seen.has(id(n))) out.push(n);
  }
  return out;
}
