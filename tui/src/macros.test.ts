import { describe, expect, test } from "bun:test";
import { externalToolsDir, externalToolsTrashDir } from "@exocortex/shared/paths";
import { MACRO_ARGS, MACRO_MAP, expandMacros } from "./macros";

describe("tool macros", () => {
  test("/tool exposes both install and uninstall actions", () => {
    expect(MACRO_ARGS["/tool"]?.map(arg => arg.name)).toEqual(["install", "uninstall"]);
  });

  test("install and uninstall expose the same tool list", () => {
    expect(MACRO_ARGS["/tool uninstall"]?.map(arg => arg.name)).toEqual(
      MACRO_ARGS["/tool install"]?.map(arg => arg.name),
    );
  });

  test("/tool uninstall expands to a soft-delete flow", () => {
    const expansion = MACRO_MAP["/tool uninstall discord"];

    expect(expansion).toContain(`${externalToolsDir()}/discord-cli`);
    expect(expansion).toContain(externalToolsTrashDir());
    expect(expansion).toContain("timestamp suffix");
    expect(expansion).toContain("Do not delete it outright.");
  });

  test("expandMacros preserves trailing text after /tool uninstall", () => {
    const expanded = expandMacros("Please /tool uninstall discord after checking the README");

    expect(expanded).toContain(`Move ${externalToolsDir()}/discord-cli into ${externalToolsTrashDir()}/`);
    expect(expanded).toEndWith("after checking the README");
  });
});
