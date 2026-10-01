// Styled text lines: everything on screen is a list of (text, style) segments.

/** A style name like "col1" or "dim", optionally combined: "col1+rev" (see theme.ts). */
export type Style = string | null;
export type Segment = [text: string, style: Style];
export type Line = Segment[];

export const lineLen = (line: Line) => line.reduce((n, [text]) => n + text.length, 0);

export const shorten = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);

/** Left segments, then `right` right-aligned, truncated to width. */
export function fit(left: Line, right: string, width: number, rightStyle: Style): Line {
  const room = width - right.length - 1;
  const out: Line = [];
  let used = 0;
  for (const [text, style] of left) {
    if (used >= room) break;
    const part = text.slice(0, room - used);
    out.push([part, style]);
    used += part.length;
  }
  out.push([" ".repeat(Math.max(0, width - used - right.length)), null], [right, rightStyle]);
  return out;
}

/** Greedy word wrap into at most maxLines lines, ending in … when cut. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) { // hard-split words longer than a line
      if (cur) lines.push(cur);
      cur = "";
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length + 1 > width) {
    last = last.includes(" ") ? last.slice(0, last.lastIndexOf(" ")) : last.slice(0, width - 1);
  }
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/** The part of a line between character positions `from` and `to`. */
export function sliceLine(line: Line, from: number, to = Infinity): Line {
  const out: Line = [];
  let pos = 0;
  for (const [text, style] of line) {
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + text.length);
    if (end > start) out.push([text.slice(start - pos, end - pos), style]);
    pos += text.length;
  }
  return out;
}

/** Draw segments over a row at column x, keeping what is left and right of them. */
export function overlay(row: Line, x: number, segments: Line): Line {
  const len = lineLen(row);
  const head: Line = len < x ? [...row, [" ".repeat(x - len), null]] : sliceLine(row, 0, x);
  return [...head, ...segments, ...sliceLine(row, x + lineLen(segments))];
}

/** Append segments to a row starting at column x (rows are filled left to right). */
export function place(row: Line, x: number, segments: Line): void {
  const len = lineLen(row);
  if (len < x) row.push([" ".repeat(x - len), null]);
  row.push(...segments);
}
