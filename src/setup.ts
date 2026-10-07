// Setup, on the first run (no config yet) or with --setup: asks for Jira, a token and a board, checks each with
// Jira, and saves them in the config file.

import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { CONFIG_FILE, saveConfig, setting } from "./config.ts";
import { jiraMessage, JiraError } from "./jira/client.ts";

interface Board {
  id: number;
  name: string;
}

/** A GET with this server and token, which aren't saved yet; a readable Error when it fails. */
async function call<T>(server: string, token: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`cannot reach ${server}: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
  }
  if (!res.ok) {
    const message = jiraMessage(await res.text().catch(() => ""));
    throw new Error(`HTTP ${res.status}${message ? `: ${message}` : ""}`);
  }
  return (await res.json()) as T;
}

/** Questions on the terminal; answers are read as lines, so typed-ahead or piped ones aren't lost. */
class Questions {
  muted = false;
  rl: Interface;
  lines: AsyncIterator<string>;
  closed = false; // all input read; answers may still be waiting in `lines`

  constructor() {
    // the token isn't echoed: what readline writes goes nowhere while muted
    const output = new Writable({
      write: (chunk, _encoding, done) => {
        if (!this.muted) process.stdout.write(chunk);
        done();
      },
    });
    this.rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
    this.rl.on("SIGINT", () => { // ctrl+c
      process.stdout.write("\n");
      process.exit(130);
    });
    this.rl.on("close", () => (this.closed = true));
    this.lines = this.rl[Symbol.asyncIterator]();
  }

  async line(prompt: string, secret: boolean): Promise<string> {
    if (this.closed) process.stdout.write(prompt);
    else {
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    }
    this.muted = secret;
    try {
      const { value, done } = await this.lines.next();
      if (done) throw new JiraError("setup cancelled");
      return (value as string).trim();
    } finally {
      if (secret) process.stdout.write("\n"); // the enter wasn't echoed
      this.muted = false;
    }
  }

  async ask(question: string, answer = ""): Promise<string> {
    return (await this.line(`${question}${answer ? ` [${answer}]` : ""}: `, false)) || answer;
  }

  secret(question: string): Promise<string> {
    return this.line(`${question}: `, true);
  }

  close(): void {
    this.rl.close();
  }
}

/** The board by its id, or chosen from the boards whose name has the text typed. */
async function chooseBoard(q: Questions, server: string, token: string): Promise<string> {
  for (;;) {
    const answer = await q.ask("Board: its id (the rapidView=<id> in its URL) or part of its name", setting("board"));
    if (!answer) continue;
    try {
      if (/^\d+$/.test(answer)) {
        const board = await call<Board>(server, token, `/rest/agile/1.0/board/${answer}`);
        console.log(`  ${board.name}`);
        return answer;
      }
      const { values } = await call<{ values: Board[] }>(server, token,
        `/rest/agile/1.0/board?maxResults=20&name=${encodeURIComponent(answer)}`);
      if (!values.length) {
        console.log(`  no board has "${answer}" in its name`);
        continue;
      }
      if (values.length === 1) {
        console.log(`  ${values[0].name} (${values[0].id})`);
        return String(values[0].id);
      }
      values.forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${b.name} (${b.id})`));
      const chosen = values[Number(await q.ask("Which one (its number)")) - 1];
      if (chosen) return String(chosen.id);
    } catch (e) {
      console.log(`  that didn't work: ${(e as Error).message}`);
    }
  }
}

/** Ask for the settings jboard needs, check them with Jira and save them. */
export async function setup(): Promise<void> {
  console.log(`Setting up jboard; your answers are saved in ${CONFIG_FILE}.\n`);
  const q = new Questions();
  try {
    let server = setting("server") ?? "";
    let token = "";
    for (;;) {
      server = (await q.ask("Jira URL, e.g. https://jira.example.com/jira", server)).replace(/\/+$/, "");
      if (!/^https?:\/\/./.test(server)) {
        console.log("  that is not a URL: it starts with https://");
        continue;
      }
      token = await q.secret("Personal access token (in Jira: your profile → Personal Access Tokens)");
      try {
        const me = await call<{ displayName: string }>(server, token, "/rest/api/2/myself");
        console.log(`  signed in as ${me.displayName}`);
        break;
      } catch (e) {
        console.log(`  that didn't work: ${(e as Error).message}\n`);
      }
    }
    const board = await chooseBoard(q, server, token);
    saveConfig({ server, token, board });
    console.log(`\nSaved. Change it in ${CONFIG_FILE}, or run jboard --setup again.\n`);
  } finally {
    q.close();
  }
}
