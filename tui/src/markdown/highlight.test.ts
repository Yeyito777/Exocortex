import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { highlightLine, highlightLineByRules, supportedLanguages } from "./highlight";

/** Source lines of this repository: every language sees real code, prose and noise. */
function corpus(): string[] {
  const lines: string[] = [];
  const root = join(import.meta.dir, "..");
  for (const name of readdirSync(root).filter(file => file.endsWith(".ts")).sort().slice(0, 12)) {
    lines.push(...readFileSync(join(root, name), "utf8").split("\n").slice(0, 120));
  }
  lines.push(
    "def f(x): return 0x1F + 0b101 + 0o17 + 1.5e-3j  # comment 'quoted'",
    'SELECT name, COUNT(*) FROM users WHERE id IN (1, 2) -- trailing',
    "<!doctype html><div class=\"a\">&amp; text</div>",
    "--- a/file.ts", "+++ b/file.ts", "@@ -1,2 +1,3 @@ fn", "+added", "-removed", "diff --git a/x b/x",
    "## Heading", "  - item", "  12. item", "> quote", "***", "[table.sub]", "key = \"value\" # c",
    "#include <stdio.h>", "  # define X 1", "fn main() { let s = r#\"raw\"#; println!(\"{}\", 'c'); }",
    "echo \"$HOME\" ${VAR:-x} $(date) | grep -E '^a' && exit 1 # done",
    "{\"a\": [1, 2.5, -3e4, true, null], \"b\": \"s\\\"q\"}", "key: value # yaml", "...", "---",
    "", " ", "\t\t", "é漢字😀 'unterminated", "\"unterminated string", "/* open comment", "`template ${x}`",
  );
  return lines;
}

/** Random strings over the characters rules care about. */
function fuzz(count: number): string[] {
  const alphabet = "abcdefxyzSELECTdefclass0123456789xXbBoOeE_.\"'`#/*-+=<>!&|^~@$%(){}[];:, \t\\é漢";
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return Array.from({ length: count }, () => Array.from({ length: Math.floor(random() * 60) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(""));
}

describe("highlightLine", () => {
  test("the one-pass scanner colours every line exactly as trying each rule at each character", () => {
    const lines = [...corpus(), ...fuzz(600)];
    // Aliases share rule sets; one name per set is enough.
    const probes = ["x = 'y' # 1 <a>", "SELECT def fn func let int // -- /* ; {}", "--- +a -b @@ ## > [t] key: v", "#include x", "\"k\": true"];
    const languages = [...new Map(supportedLanguages().map(language => [probes.map(probe => highlightLineByRules(probe, language)).join("\n"), language])).values()];
    expect(languages.length).toBe(14);
    for (const language of languages) {
      for (const line of lines) {
        const fast = highlightLine(line, language);
        if (fast !== highlightLineByRules(line, language)) {
          expect({ language, line, fast }).toEqual({ language, line, fast: highlightLineByRules(line, language) });
        }
      }
    }
  }, 30_000);

  test("lines with a line terminator, unknown languages and case-insensitive rules keep their colours", () => {
    for (const [line, language] of [["a\rb -- c", "sql"], ["x y", "diff"], ["SeLeCt 1", "sql"], ["plain", "brainfuck"]] as const) {
      expect(highlightLine(line, language)).toBe(highlightLineByRules(line, language));
    }
  });
});
