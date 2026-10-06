// A question from ssh or git while bench runs (see askpass.ts): a passphrase, or e.g. whether to trust a host key.
// It takes the keys even while the board waits for bench, since that is when it is asked.

import { shorten, wrap, type Line } from "../render/line.ts";
import { boxInner, drawBox, isTyping, type BoxRow, type Dialog, type Key } from "./dialog.ts";

const SHAPE = { max: 80, pad: 2, padY: 1 };

export class PromptDialog implements Dialog {
  screen: { width: number; height: number };
  prompt: string;
  secret: boolean;
  answer = "";
  done: (answer: string | null) => void;

  constructor(screen: { width: number; height: number }, prompt: string, secret: boolean, done: (answer: string | null) => void) {
    this.screen = screen;
    this.prompt = prompt;
    this.secret = secret;
    this.done = done;
  }

  key(str: string | undefined, key: Key): void {
    if (key.name === "escape") this.done(null);
    else if (key.name === "return" || key.name === "enter") this.done(this.answer);
    else if (key.name === "backspace") this.answer = this.answer.slice(0, -1);
    else if (key.ctrl && key.name === "u") this.answer = "";
    else if (isTyping(str, key)) this.answer += str;
  }

  draw(rows: Line[]): void {
    const inner = boxInner(this.screen.width, SHAPE);
    const shown = this.secret ? "•".repeat(this.answer.length) : this.answer;
    const body: BoxRow[] = [
      ...wrap(this.prompt, inner, 4).map((l): BoxRow => ({ line: [[l, null]] })),
      "rule",
      { line: [["› ", "dim"], [shorten(shown, inner - 3), null], ["█", "dim"]] },
    ];
    drawBox(rows, this.screen, this.secret ? "bench needs your passphrase" : "bench asks", body,
      `⏎ answer · esc cancel${this.secret ? " · kept in memory until you quit" : ""}`, SHAPE);
  }
}
