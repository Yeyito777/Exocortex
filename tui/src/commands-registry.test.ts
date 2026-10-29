import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { commandList, tryCommand } from "./commands";
import { createInitialState } from "./state";

const names = commandList().map((command) => command.name);

/** Command names in the docs' slash-command table (first column, every `/name` it shows). */
function documentedCommandNames(): Set<string> {
  const readme = readFileSync(join(import.meta.dir, "../../docs/README.md"), "utf8");
  const section = readme.split("\n## Slash commands\n")[1]?.split("\n## ")[0] ?? "";
  const documented = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `/")) continue;
    const firstColumn = line.slice(2).split(/(?<!\\) \| /)[0];
    for (const match of firstColumn.matchAll(/`(\/[a-z-]+)/g)) documented.add(match[1]);
  }
  return documented;
}

describe("slash command registry", () => {
  test("every listed command has a unique name and help text", () => {
    expect(new Set(names).size).toBe(names.length);
    for (const command of commandList()) {
      expect(command.name).toMatch(/^\/[a-z][a-z-]*$/);
      expect(command.desc.trim().length).toBeGreaterThan(0);
    }
  });

  test("every listed command has a handler that takes its bare invocation", () => {
    for (const name of [...names, "/exit"]) {
      expect({ name, result: tryCommand(name, createInitialState()) }).toEqual({ name, result: expect.anything() });
    }
  });

  test("/help lists exactly the registered commands with their help text", () => {
    const state = createInitialState();
    tryCommand("/help", state);
    const help = (state.messages.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(help.split("\n")).toEqual(commandList().map((command) => `${command.name}  ${command.desc}`));
  });

  test("the docs' slash-command table matches the registry exactly", () => {
    expect([...documentedCommandNames()].sort()).toEqual([...names, "/exit"].sort());
  });
});
