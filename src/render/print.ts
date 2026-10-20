// `jboard -p`: the board printed once, for piping or a quick look.

import type { Benched } from "../bench.ts";
import type { Board } from "../board.ts";
import { cardWidth, columnHeaderLine, columnItems, columnWidth, decorate, GAP, headerLine, legend } from "./layout.ts";
import { sliceLine, type Line } from "./line.ts";
import { ansi, columnSlot } from "./theme.ts";

/** `benched`: issues that have a bench, which get a marker with their merge request. */
export function printBoard(board: Board, mine: boolean, showAll: boolean, benched: Benched = new Map()): void {
  const { buckets, cols, hidden, points } = board.buckets(mine, showAll);
  const n = buckets.length;
  const colW = columnWidth(Number(process.env.COLUMNS) || process.stdout.columns || 160, n);
  const rendered = buckets.map((bucket, c) => {
    const idx = cols[c];
    const slot = columnSlot(idx, board.columns.length);
    const total = bucket.length + (c === n - 1 ? hidden : 0);
    const lines: Line[] = [
      sliceLine(columnHeaderLine(board, idx, total, points[idx], false), 0, colW),
      [["─".repeat(colW), `rule${slot}`]],
    ];
    for (const item of columnItems(board, bucket, idx, cardWidth(colW), new Set(), benched)) {
      lines.push(...item.lines.map((l) => decorate(l, slot, colW, false)));
    }
    if (c === n - 1 && hidden) lines.push([[`+${hidden} more (jboard -a)`, "dim"]]);
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
