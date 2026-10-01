// `A`: assign a story or subtask. The team is listed right away; typing also searches all of Jira.

import { fullName } from "../board.ts";
import { assignIssue, searchAssignable } from "../jira/api.ts";
import type { User } from "../jira/types.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker, type PickerOption } from "./picker.ts";

export function openAssign(host: DialogHost, item: Item): Dialog {
  const { issue } = item;
  const { board } = host;
  let remote: User[] = []; // Jira search results for the query, beyond the team
  let searching = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const option = (user: User | null, label: string, note: string): PickerOption => ({
    label, note,
    current: (user?.name ?? null) === (issue.fields.assignee?.name ?? null),
    dim: !user,
    choose: () => host.perform(`assigning ${issue.key}…`, async () => {
      await assignIssue(issue.key, user);
      issue.fields.assignee = user;
      return `${issue.key} assigned to ${user ? fullName(user) : "nobody"}`;
    }, (message) => `assign failed: ${message}`),
  });

  const picker: Picker = new Picker(host, {
    title: `Assign ${issue.key}: ${issue.fields.summary}`,
    action: "assign",
    options(query) {
      const q = query.trim().toLowerCase();
      const has = (...texts: (string | undefined)[]) => !q || texts.some((s) => s?.toLowerCase().includes(q));
      const options: PickerOption[] = has("unassigned") ? [option(null, "Unassigned", "")] : [];
      const seen = new Set<string>();
      for (const user of board.team()) {
        if (!user.name || !has(user.name, user.displayName, fullName(user))) continue;
        seen.add(user.name);
        options.push(option(user, fullName(user), user.name === board.me ? "me" : "team"));
      }
      for (const user of remote) {
        if (!user.name || seen.has(user.name)) continue;
        seen.add(user.name);
        options.push(option(user, fullName(user), user.name));
      }
      return options;
    },
    empty: () => (searching ? "searching…" : "no matching users"),
    loading: () => searching,
    // search everyone once typing pauses; the team is matched locally right away
    queryChanged(query) {
      clearTimeout(timer);
      remote = [];
      const q = query.trim();
      searching = q.length >= 2;
      if (!searching) return;
      timer = setTimeout(async () => {
        let users: User[] = [];
        try {
          users = await searchAssignable(issue.key, q);
        } catch (e) {
          host.msg = `user search failed: ${(e as Error).message}`;
        }
        if (host.dialog !== picker || picker.query.trim() !== q) return; // typed on or closed meanwhile
        remote = users;
        searching = false;
        host.draw();
      }, 250);
    },
    close: () => clearTimeout(timer),
  }, 1); // start on "me" rather than "Unassigned", so a stray enter does no harm
  return picker;
}
