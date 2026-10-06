// Questions from ssh and git (an SSH key's passphrase, a host key to trust, a password) while jboard runs bench.
// They would ask on the terminal, which the board has in raw mode; instead they run bin/askpass.ts, which hands
// the question to jboard over a socket, so the board can ask it and send the answer back.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Ask the user; `secret` answers are hidden while typed. Resolves to the answer, or null when cancelled. */
export type Asker = (prompt: string, secret: boolean) => Promise<string | null>;

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "askpass.ts");

let env: Record<string, string> = {};

/** Environment for programs that may ask something (bench, and the git and ssh it runs); empty until started. */
export const askpassEnv = () => env;

const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Passphrases given this run, by prompt, with the programs that got them. bench runs git a few times for one
 * bench, each asking again, so a passphrase is asked once and reused, in memory only, until jboard quits.
 */
const remembered = new Map<string, { answer: string; pids: Set<number> }>();
/** Questions being asked: the same one from several programs at once is asked once. */
const asking = new Map<string, Promise<string | null>>();

function answer(ask: Asker, prompt: string, secret: boolean, pid: number): Promise<string | null> {
  const known = remembered.get(prompt);
  if (known && !known.pids.has(pid)) {
    known.pids.add(pid);
    return Promise.resolve(known.answer);
  }
  remembered.delete(prompt); // the same program asking again: the answer was wrong
  let question = asking.get(prompt);
  if (!question) {
    question = ask(prompt, secret).finally(() => asking.delete(prompt));
    asking.set(prompt, question);
  }
  return question.then((answer) => {
    if (answer !== null && secret) {
      const entry = remembered.get(prompt)?.answer === answer ? remembered.get(prompt)! : { answer, pids: new Set<number>() };
      entry.pids.add(pid);
      remembered.set(prompt, entry);
    }
    return answer;
  });
}

/** Answer questions from ssh and git with `ask` from now on. */
export function startAskpass(ask: Asker): void {
  const dir = mkdtempSync(join(tmpdir(), "jboard-")); // only we can reach the socket in here
  const socket = join(dir, "askpass.sock");
  const script = join(dir, "askpass");
  // ssh and git run a program, not a node script with arguments
  writeFileSync(script, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(CLIENT)} "$@"\n`, { mode: 0o700 });

  const server = createServer((conn) => {
    let data = "";
    conn.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const { prompt, confirm, pid } = JSON.parse(data) as { prompt: string; confirm: boolean; pid: number };
      const secret = !confirm && /passphrase|password|token|PIN/i.test(prompt);
      void answer(ask, prompt.trim(), secret, pid).then((answer) => conn.end(JSON.stringify({ answer })));
    });
    conn.on("error", () => {});
  });
  server.listen(socket);
  server.unref();
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

  env = {
    JBOARD_ASKPASS: socket,
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: "force", // also with a terminal (OpenSSH 8.4 and newer)
    GIT_ASKPASS: script,
  };
}
