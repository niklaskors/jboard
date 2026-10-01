// `s`: move a story or subtask to another status, using the transitions its workflow allows.

import { loadTransitions, transitionIssue } from "../jira/api.ts";
import type { Transition } from "../jira/types.ts";
import type { Item } from "../render/layout.ts";
import type { Dialog, DialogHost } from "./dialog.ts";
import { Picker, type PickerOption } from "./picker.ts";

const rejects = (t: Transition) => /reject/i.test(`${t.name} ${t.to.name}`);

export function openStatus(host: DialogHost, item: Item): Dialog {
  const { issue } = item;
  let transitions: Transition[] = [];
  let loading = true;

  const option = (t: Transition): PickerOption => {
    const col = host.board.columns.find((c) => c.statuses.has(t.to.id));
    return {
      label: t.to.name,
      note: col ? `→ ${col.name}` : "not on board",
      dim: !col || rejects(t),
      choose: () => host.perform(`moving ${issue.key} to ${t.to.name}…`, async () => {
        await transitionIssue(issue.key, t.id);
        issue.fields.status = { id: t.to.id, name: t.to.name };
        issue.fields.updated = new Date().toISOString(); // shows first among the done cards
        return `${issue.key} is now ${t.to.name}`;
      }, (message) => `status change failed: ${message}`
        + (message.includes("HTTP 400") ? " (needs extra fields? press o to do it in Jira)" : "")),
    };
  };

  const picker = new Picker(host, {
    title: `Move ${issue.key} (now ${issue.fields.status.name})`,
    action: "move",
    options(query) {
      const q = query.trim().toLowerCase();
      // rejecting goes last, so the cursor never starts on it and a stray enter can't reject
      return [...transitions.filter((t) => !rejects(t)), ...transitions.filter(rejects)]
        .filter((t) => !q || [t.to.name, t.name].some((s) => s.toLowerCase().includes(q)))
        .map(option);
    },
    empty: () => (loading ? "loading transitions…" : transitions.length ? "no matching status" : "no transitions available"),
    loading: () => loading,
  });

  loadTransitions(issue.key).then((list) => {
    transitions = list;
    loading = false;
    if (host.dialog === picker) host.draw();
  }, (e: Error) => {
    if (host.dialog !== picker) return;
    host.close();
    host.msg = `could not load transitions: ${e.message}`;
    host.draw();
  });
  return picker;
}
