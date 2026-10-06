// Descriptions as styled lines: Jira wiki markup (what Jira Server and Data Center store), plus the Markdown
// that turns up in it. `#` is the one clash: a numbered list in wiki markup, a heading in Markdown.

import { lineLen, sliceLine, type Line, type Style } from "./line.ts";

const WIKI = /^\s*h[1-6]\.\s|\{(code|noformat|quote|panel|color)|\{\{|\[[^\]\n]*\|[^\]\n]*\]|^\s*\|\|/m;
const MARKDOWN = /^\s*#{1,6}\s|```|\*\*\S|\]\(/m;

/** Whether `#` starts a heading (Markdown) rather than a numbered list item (wiki markup). */
const isMarkdown = (text: string) => !WIKI.test(text) && MARKDOWN.test(text);

const EMOTICONS: Record<string, string> = {
  "(/)": "✓", "(x)": "✗", "(!)": "⚠", "(i)": "ℹ", "(?)": "?", "(y)": "👍", "(n)": "👎", "(on)": "●", "(off)": "○",
  "(*)": "★", "(+)": "+", "(-)": "−",
};

const join = (a: Style, b: Style): Style => [a, b].filter(Boolean).join("+") || null;

// one alternative per inline element, tried left to right
const INLINE = new RegExp([
  /\{\{(.+?)\}\}/, // 1 wiki monospace
  /`([^`]+)`/, // 2 Markdown code
  /\[([^\]|]+)\|([^\]]+)\]/, // 3,4 wiki link with text
  /\[~([^\]]+)\]/, // 5 wiki mention
  /\[([^\]]+)\]\(([^)\s]+)\)/, // 6,7 Markdown link
  /\[((?:https?|mailto):[^\]]+)\]/, // 8 wiki bare link
  /!([^!\s|]+\.\w+)(?:\|[^!]*)?!/, // 9 image or attachment
  /\*\*(?=\S)(.+?)\*\*/, // 10 Markdown bold
  /(?<![\w*])\*(?=[^\s*])(.+?)\*(?!\w)/, // 11 wiki bold, Markdown italic
  /(?<![\w_])_(?=\S)(.+?)_(?!\w)/, // 12 italic
  /\((?:\/|x|!|i|\?|y|n|on|off|\*|\+|-)\)/, // emoticon
].map((r) => r.source).join("|"), "g");

/** Inline markup as styled segments. */
function inline(text: string, style: Style, markdown: boolean): Line {
  const out: Line = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push([text.slice(at, m.index), style]);
    at = m.index + m[0].length;
    const g = m.slice(1);
    if (g[0] ?? g[1]) out.push([(g[0] ?? g[1])!, join(style, "code")]);
    else if (g[2]) out.push(...inline(g[2], join(style, "link"), markdown));
    else if (g[4]) out.push([`@${g[4]}`, join(style, "accent")]);
    else if (g[5]) out.push(...inline(g[5], join(style, "link"), markdown));
    else if (g[7]) out.push([g[7], join(style, "link")]);
    else if (g[8]) out.push([`[${g[8]}]`, join(style, "dim")]);
    else if (g[9]) out.push(...inline(g[9], join(style, "bold"), markdown));
    else if (g[10]) out.push(...inline(g[10], join(style, markdown ? "italic" : "bold"), markdown));
    else if (g[11]) out.push(...inline(g[11], join(style, "italic"), markdown));
    else out.push([EMOTICONS[m[0]] ?? m[0], style]);
  }
  if (at < text.length) out.push([text.slice(at), style]);
  return out;
}

/** Wiki markup that only wraps other markup: colours, and the {*} / {} forms Jira's editor writes. */
const unwrap = (line: string) =>
  line.replace(/\{color(?::[^}]*)?\}/g, "").replace(/\{\*\}\{\*\}/g, "").replace(/\{([*_+\-^~?])\}/g, "$1").replace(/\{\}/g, "");

/** Greedy word wrap of styled text; `first` goes before the first line, `rest` before the others. */
export function wrapLine(text: Line, width: number, first: Line = [], rest: Line = first): Line[] {
  const words: Line[] = [[]];
  for (const [t, s] of text) {
    t.split(/(\s+)/).forEach((part, i) => {
      if (i % 2) words.push([]);
      else if (part) words[words.length - 1].push([part, s]);
    });
  }
  const lines: Line[] = [];
  let cur: Line = [...first];
  let empty = true;
  for (let word of words.filter((w) => w.length)) {
    const room = () => width - lineLen(cur) - (empty ? 0 : 1);
    if (lineLen(word) > room() && !empty) {
      lines.push(cur);
      cur = [...rest];
      empty = true;
    }
    while (lineLen(word) > room()) { // hard-split words longer than a line
      const n = Math.max(1, room());
      cur.push(...sliceLine(word, 0, n));
      word = sliceLine(word, n);
      lines.push(cur);
      cur = [...rest];
    }
    if (!empty) { // a space inside a styled run keeps the style (an underlined link stays one line)
      const before = cur[cur.length - 1][1];
      cur.push([" ", before === word[0][1] ? before : null]);
    }
    cur.push(...word);
    empty = false;
  }
  lines.push(cur);
  return lines;
}

/** A line of a rendered description; code keeps its whole width, to be scrolled sideways (diagrams, long lines). */
export interface Rendered {
  line: Line;
  code?: boolean;
}

const codeLine = (text: string): Rendered => ({ line: [["  ", null], [text.trimEnd(), "code"]], code: true });

/** A table row's cells: split at | or ||, except inside [links] and {{monospace}}. */
function splitCells(row: string): string[] {
  const cells = [""];
  let depth = 0;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === "[" || c === "{") depth++;
    else if ((c === "]" || c === "}") && depth) depth--;
    if (c === "|" && !depth) {
      if (row[i + 1] === "|") i++;
      cells.push("");
    } else cells[cells.length - 1] += c;
  }
  return cells.map((c) => c.trim());
}

/** Render a description as lines at most `width` wide, apart from code. */
export function renderMarkup(text: string, width: number): Rendered[] {
  const markdown = isMarkdown(text);
  const out: Rendered[] = [];
  const add = (...lines: Line[]) => out.push(...lines.map((line) => ({ line })));
  const blank = () => {
    if (out.length && lineLen(out[out.length - 1].line)) add([]);
  };
  const counters: number[] = [];
  let listMarks = ""; // the marks of the previous list item: a different kind of list restarts the count
  let code: RegExp | null = null; // the end of the code block we are in
  let quote = false;

  for (const raw of text.replace(/\t/g, "  ").split("\n")) {
    if (code) {
      const end = raw.search(code);
      const body = end < 0 ? raw : raw.slice(0, end);
      if (end < 0 || body.trim()) out.push(codeLine(body));
      if (end >= 0) code = null;
      continue;
    }
    const fence = /^\s*(```|\{(code|noformat)(?::[^}]*)?\})(.*)$/.exec(raw);
    if (fence) {
      const end = fence[1] === "```" ? /```/ : new RegExp(`\\{${fence[2]}\\}`);
      const after = fence[1] === "```" ? "" : fence[3]; // after ``` comes the language
      const close = after.search(end);
      if (close >= 0) out.push(codeLine(after.slice(0, close)));
      else {
        if (after.trim()) out.push(codeLine(after));
        code = end;
      }
      continue;
    }

    let line = unwrap(raw);
    // {quote} on a line of its own, or around text on one line
    let endsQuote = false;
    if (/^\s*\{quote\}/.test(line)) {
      line = line.replace(/^\s*\{quote\}/, "");
      quote = !quote;
      if (!line.trim()) continue;
    }
    if (/\{quote\}\s*$/.test(line)) {
      line = line.replace(/\{quote\}\s*$/, "");
      endsQuote = quote;
    }
    const panel = /^\s*\{panel(?::([^}]*))?\}\s*$/.exec(line);
    if (panel) {
      const title = /title=([^|}]+)/.exec(panel[1] ?? "");
      if (title) add([[title[1].trim(), "bold"]]);
      continue;
    }
    const quoted = quote || /^\s*(bq\.|>)\s?/.test(line);
    if (endsQuote) quote = false;
    if (quoted) line = line.replace(/^\s*(bq\.|>)\s?/, "");
    const bar: Line = quoted ? [["│ ", "dim"]] : [];
    if (!line.trim()) {
      counters.length = 0;
      blank();
      continue;
    }

    const heading = /^\s*h([1-6])\.\s+(.*)$/.exec(line) ?? (markdown ? /^\s*(#{1,6})\s+(.*)$/.exec(line) : null);
    if (heading) {
      blank();
      add(...wrapLine(inline(heading[2].replace(/\s*#+\s*$/, ""), "accent", markdown), width, bar));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      add([["─".repeat(width), "dim"]]);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // a Markdown table's separator row
      const header = /^\s*\|\|/.test(line);
      const cells = splitCells(line.trim().replace(/^\|\|?|\|\|?$/g, ""));
      const row: Line = [];
      cells.forEach((cell, i) => row.push(...(i ? [[" │ ", "dim"] as [string, Style]] : []),
        ...inline(cell, header ? "bold" : null, markdown)));
      add(...wrapLine(row, width, bar));
      continue;
    }

    // list items: wiki "* a", "## b", "*# c"; Markdown "- a", "1. b", nested by indentation
    const wikiItem = /^\s*([*#-]+)\s+(.*)$/.exec(line);
    const mdItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    let marks: string | null = null;
    let item = "";
    if (mdItem && (markdown || /\d/.test(mdItem[2]))) {
      const depth = Math.floor(mdItem[1].length / 2) + 1;
      marks = listMarks.slice(0, depth - 1).padEnd(depth - 1, "*") + (/\d/.test(mdItem[2]) ? "#" : "*");
      item = mdItem[3];
    } else if (wikiItem && !(wikiItem[1].length > 1 && /^-+$/.test(wikiItem[1]))) {
      marks = wikiItem[1].replace(/#/g, markdown ? "*" : "#");
      item = wikiItem[2];
    }
    if (marks !== null) {
      const depth = marks.length;
      counters.length = depth;
      if (listMarks.slice(0, depth) !== marks) counters[depth - 1] = 0;
      listMarks = marks;
      counters[depth - 1] = (counters[depth - 1] ?? 0) + 1;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
      if (task) item = task[2];
      const bullet = task ? (task[1] === " " ? "☐" : "☑")
        : marks.endsWith("#") ? `${counters[depth - 1]}.` : ["•", "◦", "▪"][(depth - 1) % 3];
      const indent = "  ".repeat(depth - 1);
      add(...wrapLine(inline(item, null, markdown), width,
        [...bar, [indent, null], [`${bullet} `, "dim"]], [...bar, [indent + " ".repeat(bullet.length + 1), null]]));
      continue;
    }

    counters.length = 0;
    const indent = /^ */.exec(line)![0].slice(0, Math.floor(width / 2));
    add(...wrapLine(inline(line.trim(), quoted ? "italic" : null, markdown), width, [...bar, [indent, null]]));
  }
  while (out.length && !lineLen(out[out.length - 1].line)) out.pop();
  return out;
}
