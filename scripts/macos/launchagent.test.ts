import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  installDaemonLaunchAgent,
  LAUNCHER_BUNDLE_ID,
  renderDaemonLaunchAgent,
  renderPlainDaemonLaunchAgent,
  rewriteDaemonLaunchAgent,
} from "./launchagent";

const EXE = "/Users/me/Applications/Exocortex Daemon.app/Contents/MacOS/exocortex-daemon";
const REPO = "/Users/me/Desktop/Exocortex";
const TARGET = { executable: EXE, repoDir: REPO };

// Shape of the hand-written agent on the owner's Mac (bash wrapper as the program).
const EXISTING = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.exocortex.daemon</string>
	<!-- the <dict> wrapper -->
	<key>ProgramArguments</key>
	<array>
		<string>/Users/me/.local/bin/exocortexd</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
		<key>ProgramArguments</key>
		<string>nested keys are not top-level</string>
	</dict>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/Users/me/Desktop/Exocortex/config/runtime/launchd.out.log</string>
</dict>
</plist>
`;

function programArguments(xml: string): string[] {
  const match = /^\t<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/m.exec(xml);
  if (!match) throw new Error("no top-level ProgramArguments");
  return [...match[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
}

describe("rewriteDaemonLaunchAgent", () => {
  test("replaces only the program and keeps every other key", () => {
    const next = rewriteDaemonLaunchAgent(EXISTING, TARGET);
    expect(programArguments(next)).toEqual([EXE, "--repo", REPO]);
    expect(next).toContain(`\t<key>AssociatedBundleIdentifiers</key>\n\t<string>${LAUNCHER_BUNDLE_ID}</string>\n</dict>`);
    // Everything except the ProgramArguments value is untouched.
    const strip = (xml: string) => xml
      .replace(/\t<key>ProgramArguments<\/key>\n\t<array>[\s\S]*?<\/array>/, "")
      .replace(/\t<key>AssociatedBundleIdentifiers<\/key>\n\t<string>[^<]*<\/string>\n/, "");
    expect(strip(next)).toBe(strip(EXISTING));
    expect(next).toContain("<string>nested keys are not top-level</string>");
    expect(next).toContain("\t\t<string>--repo</string>\n");
  });

  test("is idempotent", () => {
    const once = rewriteDaemonLaunchAgent(EXISTING, TARGET);
    expect(rewriteDaemonLaunchAgent(once, TARGET)).toBe(once);
  });

  test("drops Program, which would override the launcher executable", () => {
    const withProgram = EXISTING.replace("\t<key>ProgramArguments</key>", "\t<key>Program</key>\n\t<string>/opt/homebrew/bin/bash</string>\n\t<key>ProgramArguments</key>");
    const next = rewriteDaemonLaunchAgent(withProgram, TARGET);
    expect(next).not.toContain("<key>Program</key>");
    expect(next).not.toContain("/opt/homebrew/bin/bash");
    expect(programArguments(next)[0]).toBe(EXE);
  });

  test("inserts ProgramArguments when the agent only had Program", () => {
    const programOnly = EXISTING.replace(/\t<key>ProgramArguments<\/key>\n\t<array>[\s\S]*?<\/array>/, "\t<key>Program</key>\n\t<string>/Users/me/.local/bin/exocortexd</string>");
    const next = rewriteDaemonLaunchAgent(programOnly, TARGET);
    expect(next).not.toContain("<key>Program</key>");
    expect(programArguments(next)).toEqual([EXE, "--repo", REPO]);
  });

  test("escapes XML in paths", () => {
    const next = rewriteDaemonLaunchAgent(EXISTING, { executable: EXE, repoDir: "/Users/me/R&D <x>" });
    expect(programArguments(next)[2]).toBe("/Users/me/R&amp;D &lt;x&gt;");
  });

  test("refuses binary and non-plist input", () => {
    expect(() => rewriteDaemonLaunchAgent("bplist00\u0000", TARGET)).toThrow("binary plist");
    expect(() => rewriteDaemonLaunchAgent("<html></html>", TARGET)).toThrow("not an XML property list");
  });
});

describe("renderDaemonLaunchAgent", () => {
  test("fresh agents run the launcher with on-failure restarts and repo logs", () => {
    const xml = renderDaemonLaunchAgent({ ...TARGET, home: "/Users/me", bunDir: "/opt/homebrew/bin" });
    expect(programArguments(xml)).toEqual([EXE, "--repo", REPO]);
    expect(xml).toContain("<key>Label</key>\n\t<string>com.exocortex.daemon</string>");
    expect(xml).toContain(`<key>WorkingDirectory</key>\n\t<string>${REPO}/daemon</string>`);
    expect(xml).toContain("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>");
    expect(xml).toContain(`<string>${REPO}/config/runtime/launchd.out.log</string>`);
    expect(xml).toContain("<string>/Users/me/.local/bin:/opt/homebrew/bin:/Users/me/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
    // A fresh plist is already in its rewritten form.
    expect(rewriteDaemonLaunchAgent(xml, TARGET)).toBe(xml);
  });
});

describe("renderPlainDaemonLaunchAgent", () => {
  test("runs run-daemon.sh with Apple's bash and no launcher bundle", () => {
    const xml = renderPlainDaemonLaunchAgent({ repoDir: REPO, home: "/Users/me", bunDir: "/Users/me/.bun/bin" });
    expect(programArguments(xml)).toEqual(["/bin/bash", `${REPO}/scripts/setup/run-daemon.sh`]);
    expect(xml).not.toContain("AssociatedBundleIdentifiers");
    expect(xml).toContain(`<key>WorkingDirectory</key>\n\t<string>${REPO}/daemon</string>`);
    expect(xml).toContain("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>");
    // The launcher can take it over later.
    const upgraded = rewriteDaemonLaunchAgent(xml, TARGET);
    expect(programArguments(upgraded)).toEqual([EXE, "--repo", REPO]);
    expect(upgraded).toContain(`<string>${LAUNCHER_BUNDLE_ID}</string>`);
  });
});

describe("installDaemonLaunchAgent", () => {
  test("plain mode creates a missing agent and never rewrites one", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-launchagent-"));
    try {
      const plistPath = join(dir, "LaunchAgents", "com.exocortex.daemon.plist");
      const options = { mode: "plain" as const, repoDir: REPO, home: "/Users/me", plistPath };
      expect(installDaemonLaunchAgent(options)).toBe("created");
      expect(programArguments(readFileSync(plistPath, "utf-8"))[0]).toBe("/bin/bash");
      writeFileSync(plistPath, EXISTING);
      expect(installDaemonLaunchAgent(options)).toBe("unchanged");
      expect(readFileSync(plistPath, "utf-8")).toBe(EXISTING);
      // With the command-line tools installed later, the launcher takes it over.
      expect(installDaemonLaunchAgent({ ...TARGET, home: "/Users/me", plistPath, backupDir: join(dir, "b") })).toBe("updated");
      expect(programArguments(readFileSync(plistPath, "utf-8"))[0]).toBe(EXE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates, updates with a backup, then reports unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-launchagent-"));
    try {
      const plistPath = join(dir, "LaunchAgents", "com.exocortex.daemon.plist");
      const backupDir = join(dir, "backups");
      const options = { ...TARGET, home: "/Users/me", plistPath, backupDir, now: new Date(Date.UTC(2026, 9, 17)) };

      expect(installDaemonLaunchAgent(options)).toBe("created");
      expect(installDaemonLaunchAgent(options)).toBe("unchanged");

      writeFileSync(plistPath, EXISTING);
      expect(installDaemonLaunchAgent(options)).toBe("updated");
      expect(programArguments(readFileSync(plistPath, "utf-8"))[0]).toBe(EXE);
      expect(readdirSync(backupDir)).toEqual(["com.exocortex.daemon.plist.2026-10-17T00-00-00-000Z.bak"]);
      expect(readFileSync(join(backupDir, readdirSync(backupDir)[0]), "utf-8")).toBe(EXISTING);
      expect(installDaemonLaunchAgent(options)).toBe("unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
