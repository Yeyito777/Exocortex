import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSshAliases } from "./ssh-aliases";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SSH alias discovery", () => {
  test("reads concrete Host entries, recursive Includes, and removes patterns", () => {
    const home = mkdtempSync(join(tmpdir(), "exocortex-ssh-config-"));
    tempDirs.push(home);
    const ssh = join(home, ".ssh");
    const includes = join(ssh, "config.d");
    mkdirSync(includes, { recursive: true });
    const config = join(ssh, "config");
    writeFileSync(config, [
      "Host whale dev-box *.example !blocked",
      "  HostName 10.0.0.2",
      "Include config.d/*",
      "Host whale # duplicate",
    ].join("\n"));
    writeFileSync(join(includes, "work"), [
      "Host cerberus test_2 host?.invalid",
      "Include ../config", // cycle must not recurse forever
    ].join("\n"));

    expect(loadSshAliases({ home, configFiles: [config] })).toEqual([
      "cerberus", "dev-box", "test_2", "whale",
    ]);
  });

  test("supports quoted Include paths", () => {
    const home = mkdtempSync(join(tmpdir(), "exocortex-ssh-quoted-"));
    tempDirs.push(home);
    const ssh = join(home, ".ssh");
    mkdirSync(join(ssh, "more configs"), { recursive: true });
    const config = join(ssh, "config");
    writeFileSync(config, 'Include "more configs/hosts"\n');
    writeFileSync(join(ssh, "more configs", "hosts"), "Host luna\n");

    expect(loadSshAliases({ home, configFiles: [config] })).toEqual(["luna"]);
  });
});
