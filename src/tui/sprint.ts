// `S`: move a story (with its subtasks) to another sprint, or back to the backlog.

import { moveToSprint, openSprints } from "../jira/api.ts";
import type { Card, Sprint } from "../jira/types.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker, type PickerOption } from "./picker.ts";

const day = (date: string) => new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** "active · ends 14 Oct", "future · starts 15 Oct" */
function sprintNote(sprint: Sprint): string {
  if (sprint.state === "active") return `active${sprint.endDate ? ` · ends ${day(sprint.endDate)}` : ""}`;
  return `future${sprint.startDate ? ` · starts ${day(sprint.startDate)}` : ""}`;
}

export function openSprint(host: DialogHost, item: Item): Dialog {
  // subtasks follow their story, so the story is what moves
  const issue = item.parent ?? (item.issue as Card);
  const from = host.board.kind === "backlog" ? null : host.board.sprint.id;
  let sprints: Sprint[] = [];
  let loading = true;

  const move = (sprint: Sprint | null) => host.perform(`moving ${issue.key} to ${sprint?.name ?? "the backlog"}…`, async () => {
    await moveToSprint(issue.key, sprint?.id ?? null);
    await host.reload();
    host.focus(issue.key); // when it is still shown, e.g. moved from one sprint to another while showing the backlog
    return `${issue.key} moved to ${sprint?.name ?? "the backlog"}`;
  }, (message) => `moving ${issue.key} failed: ${message}`);

  const option = (sprint: Sprint | null): PickerOption => ({
    label: sprint?.name ?? "Backlog",
    note: sprint ? sprintNote(sprint) : "no sprint",
    current: (sprint?.id ?? null) === from,
    choose: () => ((sprint?.id ?? null) === from ? Promise.resolve(host.close()) : move(sprint)),
  });

  const picker = new Picker(host, {
    title: `Move ${issue.key}${item.parent ? " (with its subtasks)" : ""} to`,
    action: "move",
    options(query) {
      const q = query.trim().toLowerCase();
      return [...sprints, null].map(option).filter((o) => !q || o.label.toLowerCase().includes(q));
    },
    empty: () => (loading ? "loading sprints…" : "no matching sprint"),
    loading: () => loading,
  });

  openSprints(host.board.boardId).then((list) => {
    sprints = list;
    loading = false;
    // start on the first sprint the issue isn't in
    picker.sel = Math.max(0, picker.source.options("").findIndex((o) => !o.current));
    if (host.dialog === picker) host.draw();
  }, (e: Error) => {
    if (host.dialog !== picker) return;
    host.close();
    host.msg = `could not load sprints: ${e.message}`;
    host.draw();
  });
  return picker;
}
