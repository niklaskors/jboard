// jboard --create: the wizard that creates one issue for another tool (e.g. punch), driven with key presses like
// the board, against the fake Jira. What it draws is read back as plain text.

import { describe, expect, test, vi } from "vitest";
import { BOARD_ID } from "./fakes/jira.ts";
import { jira } from "./harness.ts";
import { CreateWizard, type Created } from "../src/tui/wizard.ts";
import type { Key } from "../src/tui/dialog.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const NAMED: Record<string, [string | undefined, Key]> = {
  "<enter>": ["\r", { name: "return" }], "<esc>": ["\x1b", { name: "escape" }], "<bs>": ["\x7f", { name: "backspace" }],
  "<up>": [undefined, { name: "up" }], "<down>": [undefined, { name: "down" }], "<C-u>": [undefined, { name: "u", ctrl: true }],
};

/** The wizard as `jboard --create` opens it, with what it draws kept, and how it finished. */
function open(summary: string) {
  const frames: string[] = [];
  let result: Created | null | undefined;
  const wizard = new CreateWizard({ columns: 100, rows: 30, write: (s: string) => frames.push(s) }, BOARD_ID, summary,
    (created) => (result = created));
  const screen = () => stripAnsi((frames.at(-1) ?? "").split(/\x1b\[\d+;1H/).join("\n"));
  return {
    wizard,
    screen,
    /** How it finished: the new issue, null when cancelled, undefined while still open. */
    result: () => result,
    async press(...keys: string[]) {
      for (const spec of keys) {
        const [str, key] = NAMED[spec] ?? [spec, { name: spec.toLowerCase() }];
        await wizard.key(str, key);
        wizard.draw();
      }
    },
    async waitFor(text: string | RegExp) {
      await vi.waitFor(() => {
        if (typeof text === "string") expect(screen()).toContain(text);
        else expect(screen()).toMatch(text);
      }, { timeout: 5000, interval: 10 });
    },
  };
}

describe("jboard --create", () => {
  test("goes through type, where and summary, and creates the issue there", async () => {
    const w = open("Export  the report to CSV ");
    await w.waitFor("╭─ New issue in PROJ");
    expect(w.screen()).toMatch(/ Type  › Where › Summary/);
    expect(w.screen()).toContain("Story");
    expect(w.screen()).toContain("Bug");
    expect(w.screen()).not.toContain("Epic");

    await w.press("j", "j", "<enter>"); // Bug
    await w.waitFor("Sprint 13");
    expect(w.screen()).toMatch(/Bug ›  Where  › Summary/);
    expect(w.screen()).toMatch(/Backlog +no sprint/);
    expect(w.screen()).toMatch(/Sprint 12 +active/);

    await w.press("<down>", "<enter>"); // Sprint 12
    expect(w.screen()).toMatch(/Bug › Sprint 12 ›  Summary/);
    expect(w.screen()).toContain("› Export the report to CSV█"); // typed in already, spaces tidied
    expect(w.screen()).toContain("Bug in Sprint 12");

    await w.press("<bs>", "<bs>", "<bs>", "c", "s", "v", "<enter>");
    expect(w.result()).toEqual({ key: "PROJ-100", warning: "" });
    expect(jira.get("PROJ-100")).toMatchObject({ summary: "Export the report to csv", type: "Bug", sprint: 100 });
  });

  test("creates a story in the backlog with enter, enter, enter", async () => {
    const w = open("Search filters");
    await w.waitFor("Story");
    await w.press("<enter>");
    await w.waitFor("Backlog");
    await w.press("<enter>", "<enter>");
    expect(w.result()).toEqual({ key: "PROJ-100", warning: "" });
    expect(jira.get("PROJ-100")).toMatchObject({ type: "Story", sprint: null });
  });

  test("goes back a step with esc, and is cancelled by esc on the first", async () => {
    const w = open("Something");
    await w.waitFor("Story");
    await w.press("<enter>", "<enter>");
    expect(w.screen()).toContain("Summary ");
    await w.press("<esc>");
    expect(w.screen()).toMatch(/ Where /);
    await w.press("<esc>", "<esc>");
    expect(w.result()).toBeNull();
    expect(jira.calls("POST", "/rest/api/2/issue")).toEqual([]);
  });

  test("asks the project first when the board has several", async () => {
    jira.projects.push({ key: "OPS", name: "Operations" });
    const w = open("Rotate keys");
    await w.waitFor(/ Project  › Type › Where › Summary/);
    expect(w.screen()).toMatch(/OPS +Operations/);
    await w.press("j", "<enter>");
    await w.waitFor("╭─ New issue in OPS");
    await w.press("<enter>", "<enter>", "<enter>");
    expect(w.result()?.key).toMatch(/^OPS-\d+$/);
  });

  test("needs a summary", async () => {
    const w = open("");
    await w.waitFor("Story");
    await w.press("<enter>", "<enter>", "<enter>");
    expect(w.screen()).toContain("type a summary first");
    await w.press("<C-u>", "F", "i", "x", "<enter>");
    expect(w.result()?.key).toBe("PROJ-100");
  });

  test("stays open when Jira refuses, to try again or go back", async () => {
    const w = open("FAIL on purpose");
    await w.waitFor("Story");
    await w.press("<enter>", "<enter>", "<enter>");
    expect(w.screen()).toContain("creating the story failed: HTTP 400");
    expect(w.result()).toBeUndefined();
  });

  test("tells when it was created but could not be moved to the sprint", async () => {
    jira.fail("POST", "/rest/agile/1.0/sprint/100/issue", 400, { errorMessages: ["Sprint is closed"] });
    const w = open("Late addition");
    await w.waitFor("Story");
    await w.press("<enter>");
    await w.waitFor("Sprint 12");
    await w.press("<down>", "<enter>", "<enter>");
    expect(w.result()?.key).toBe("PROJ-100");
    expect(w.result()?.warning).toMatch(/^created PROJ-100 in the backlog, but moving it to Sprint 12 failed: HTTP 400 .*Sprint is closed/);
  });
});
