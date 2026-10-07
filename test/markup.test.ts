import { describe, expect, test } from "vitest";
import { renderMarkup } from "../src/render/markup.ts";

const text = (markup: string, width: number) => renderMarkup(markup, width).map(({ line }) => line.map(([t]) => t).join(""));

describe("tables", () => {
  test("line up their columns, with a rule under the header", () => {
    expect(text("||Field||Value||\n|Name|Clark Kent|\n|Email|ck@example.com|\nAfter", 60)).toEqual([
      "Field │ Value",
      "──────┼───────────────",
      "Name  │ Clark Kent",
      "Email │ ck@example.com",
      "",
      "After",
    ]);
  });

  test("wrap a cell within its column when the table is too wide", () => {
    expect(text("|Note|a note that does not fit|\n|Done|yes|", 20)).toEqual([
      "Note │ a note that",
      "     │ does not fit",
      "─────┼──────────────",
      "Done │ yes",
    ]);
  });

  test("take a Markdown header row, and the cells that go on over more lines", () => {
    expect(text("| A | Bee |\n|---|---|\n| 1 | two |", 40)).toEqual(["A │ Bee", "──┼────", "1 │ two"]);
    expect(text("||Step||State||\n|Login|* one\n* two|\n|Logout|b\\\\c|", 40)).toEqual([
      "Step   │ State",
      "───────┼──────",
      "Login  │ • one",
      "       │ • two",
      "───────┼──────",
      "Logout │ b",
      "       │ c",
    ]);
  });
});

describe("lists", () => {
  test("a numbered list starts at its written number, also after a blank line or a table", () => {
    expect(text("1. one\n2. two\n\n|a|b|\n\n5. five\n\n6. six", 40)).toEqual(["1. one", "2. two", "", "a │ b", "", "5. five", "", "6. six"]);
  });
});
