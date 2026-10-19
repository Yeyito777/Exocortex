import { describe, expect, test } from "bun:test";
import { renderTableBlock } from "./tables";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("markdown table cells", () => {
  test("an escaped pipe stays inside its cell and renders unescaped", () => {
    const rows = renderTableBlock([
      "| Command | Meaning |",
      "|---|---|",
      "| `ls \\| wc -l` | count \\| files |",
    ], 60, "\x1b[0m")!.map(stripAnsi);

    expect(rows).toEqual([
      "┌────────────┬───────────────┐",
      "│ Command    │ Meaning       │",
      "├────────────┼───────────────┤",
      "│ ls | wc -l │ count | files │",
      "└────────────┴───────────────┘",
    ]);
  });

  test("a row ending in an escaped pipe keeps it as cell text", () => {
    const rows = renderTableBlock(["| a | b |", "|---|---|", "| 1 | 2 \\|"], 60)!;

    expect(rows[3]).toBe("│ 1 │ 2 | │");
  });
});
