// `jboard -p`: the board printed once, for piping or a quick look.

import type { Board } from "../board.ts";
import { cardWidth, columnHeaderLine, columnItems, columnWidth, decorate, GAP, headerLine, legend } from "./layout.ts";
import { sliceLine, type Line } from "./line.ts";
import { ansi } from "./theme.ts";

/** `benched`: issues that have a bench, which get a marker. */
export function printBoard(board: Board, mine: boolean, showAll: boolean, benched = new Set<string>()): void {
  const { buckets, hidden, points } = board.buckets(mine, showAll);
  const n = buckets.length;
  const colW = columnWidth(Number(process.env.COLUMNS) || process.stdout.columns || 160, n);
  const rendered = buckets.map((bucket, idx) => {
    const total = bucket.length + (idx === n - 1 ? hidden : 0);
    const lines: Line[] = [
      sliceLine(columnHeaderLine(board, idx, total, points[idx], false), 0, colW),
      [["─".repeat(colW), `rule${idx}`]],
    ];
    for (const item of columnItems(board, bucket, idx, cardWidth(colW), new Set(), benched)) {
      lines.push(...item.lines.map((l) => decorate(l, idx, colW, false)));
    }
    if (idx === n - 1 && hidden) lines.push([[`+${hidden} more (jboard -a)`, "dim"]]);
    return lines.map((l) => ansi(l, colW));
  });

  const cards = buckets.reduce((sum, b) => sum + b.length, 0) + hidden;
  console.log(`\n${ansi(headerLine(board, mine, cards, points))}`);
  console.log(`${ansi([[" ", null], ...legend()])}\n`);
  const height = Math.max(...rendered.map((c) => c.length));
  for (let row = 0; row < height; row++) {
    console.log(rendered.map((c) => c[row] ?? " ".repeat(colW)).join(" ".repeat(GAP)).trimEnd());
  }
}
