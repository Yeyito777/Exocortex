import { afterEach, describe, expect, test } from "bun:test";
import { RemoteFileLinkController, remoteDirectoryUrl, remoteFileCopyArgs, type FileLinkContext } from "./remote-file-links";

const controllers: RemoteFileLinkController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.cancel(); });

function setup() {
  let context: FileLinkContext = { alias: "remote", conversationId: "conversation" };
  const requests: string[][] = [];
  const notices: string[] = [];
  const local: unknown[][] = [];
  const copies: unknown[][] = [];
  const files: string[] = [];
  const directories: string[][] = [];
  const discarded: string[] = [];
  let online = true;
  let directoryWorks = true;
  let downloadGate: Promise<void> = Promise.resolve();
  const controller = new RemoteFileLinkController({
    context: () => context,
    request: (convId, target) => {
      if (!online) return null;
      requests.push([convId, target]);
      return `file_link_${requests.length}`;
    },
    notify: message => notices.push(message),
    openLocal: (...args) => { local.push(args); return true; },
    download: async (alias, path, signal) => {
      copies.push([alias, path, signal]);
      await downloadGate;
      return { path: "/local/preview/file.md", discard: async () => { discarded.push(path); } };
    },
    openFile: path => { files.push(path); return true; },
    openDirectory: (alias, path) => { directories.push([alias, path]); return directoryWorks; },
  });
  controllers.push(controller);
  const response = (extra = {}) => controller.handleEvent({
    type: "file_link_resolved", reqId: "file_link_1", convId: "conversation",
    path: "/remote/workspace/report.md", kind: "file", size: 4, ...extra,
  });
  return {
    controller, requests, notices, local, copies, files, directories, discarded, response,
    route: (next: FileLinkContext) => { context = next; },
    offline: () => { online = false; },
    failDirectory: () => { directoryWorks = false; },
    gate: (promise: Promise<void>) => { downloadGate = promise; },
  };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe("SSH file links", () => {
  test("local mode and web URLs remain local; remote web links have no remote cwd", () => {
    const s = setup();
    s.controller.open("https://example.com/report");
    expect(s.local).toEqual([["https://example.com/report", null]]);
    s.route({ alias: null, conversationId: "local-conversation" });
    s.controller.open("reports/file.md");
    expect(s.local[1]).toEqual(["reports/file.md", "local-conversation"]);
    expect(s.requests).toHaveLength(0);
  });

  test("passes relative, home, absolute, and file URL targets unchanged to the remote daemon", () => {
    for (const target of ["reports/file.md", "~/notes.md", "/remote/file.md", "file:///remote/a%20b.md"]) {
      const s = setup();
      s.controller.open(target);
      expect(s.requests).toEqual([["conversation", target]]);
      expect(s.local).toHaveLength(0);
    }
  });

  test("downloads the daemon-resolved file before invoking the local viewer", async () => {
    const s = setup();
    s.controller.open("reports/file.md");
    expect(s.response()).toBe(true);
    expect(s.copies[0].slice(0, 2)).toEqual(["remote", "/remote/workspace/report.md"]);
    await settle();
    expect(s.files).toEqual(["/local/preview/file.md"]);
    expect(s.local).toHaveLength(0);
    expect(s.notices).toHaveLength(0);
  });

  test("directories open over SFTP without downloading or guessing a local path", () => {
    const s = setup();
    s.controller.open("reports/");
    s.response({ kind: "directory", path: "/remote/workspace/reports" });
    expect(s.directories).toEqual([["remote", "/remote/workspace/reports"]]);
    expect(s.copies).toHaveLength(0);
    expect(s.local).toHaveLength(0);
  });

  test("reports unavailable local SFTP folder handlers", async () => {
    const s = setup();
    s.failDirectory();
    s.controller.open("reports/");
    s.response({ kind: "directory" });
    await settle();
    expect(s.notices[0]).toContain("SFTP folder handler");
    expect(s.local).toHaveLength(0);
  });

  test("disconnects and daemon errors never fall back to local files", () => {
    const s = setup();
    s.offline();
    s.controller.open("report.md");
    expect(s.notices[0]).toContain("disconnected");
    expect(s.local).toHaveLength(0);
    const t = setup();
    t.controller.open("report.md");
    expect(t.controller.handleEvent({ type: "error", reqId: "file_link_1", message: "No such file" })).toBe(true);
    expect(t.notices[0]).toContain("No such file");
    expect(t.files).toHaveLength(0);
    expect(t.local).toHaveLength(0);
  });

  test("stale responses are discarded after route/conversation switches and cancellation", () => {
    for (const change of ["route", "conversation", "cancel"]) {
      const s = setup();
      s.controller.open("report.md");
      if (change === "cancel") s.controller.cancel();
      else s.route({ alias: change === "route" ? "other" : "remote", conversationId: change === "conversation" ? "other" : "conversation" });
      expect(s.response()).toBe(true);
      expect(s.copies).toHaveLength(0);
      expect(s.files).toHaveLength(0);
    }
  });

  test("switching routes during a transfer discards it without opening", async () => {
    const s = setup();
    let release!: () => void;
    s.gate(new Promise(resolve => { release = resolve; }));
    s.controller.open("report.md");
    s.response();
    s.controller.cancel();
    expect((s.copies[0][2] as AbortSignal).aborted).toBe(true);
    release();
    await settle();
    expect(s.discarded).toEqual(["/remote/workspace/report.md"]);
    expect(s.files).toHaveLength(0);
    expect(s.notices).toHaveLength(0);
  });

  test("transfer failure never opens a partial file or a local substitute", async () => {
    const s = setup();
    s.gate(Promise.reject(new Error("SFTP unavailable")));
    s.controller.open("report.md");
    s.response();
    await settle();
    expect(s.notices[0]).toContain("SFTP unavailable");
    expect(s.files).toHaveLength(0);
    expect(s.local).toHaveLength(0);
  });

  test("duplicate replies cannot launch duplicate downloads or viewers", async () => {
    const s = setup();
    s.controller.open("report.md");
    s.response();
    s.response();
    await settle();
    s.response();
    expect(s.copies).toHaveLength(1);
    expect(s.files).toHaveLength(1);
  });

  test("rejects oversized files, wrong conversations, and nonabsolute resolved paths", async () => {
    for (const response of [{ size: 129 * 1024 * 1024 }, { convId: "other" }, { path: "../local.md" }]) {
      const s = setup();
      s.controller.open("report.md");
      s.response(response);
      await settle();
      expect(s.notices).toHaveLength(1);
      expect(s.copies).toHaveLength(0);
      expect(s.files).toHaveLength(0);
    }
  });

  test("does not treat unrelated errors or unsafe schemes as remote file opens", () => {
    const s = setup();
    s.controller.open("javascript:alert(1)");
    expect(s.requests).toHaveLength(0);
    expect(s.controller.handleEvent({ type: "error", reqId: "other", message: "oops" })).toBe(false);
  });
});

describe("SFTP addressing", () => {
  test("remote folders percent-encode path characters without losing SSH aliases", () => {
    expect(remoteDirectoryUrl("whale", "/home/me/a #?%/中文")).toBe("sftp://whale/home/me/a%20%23%3F%25/%E4%B8%AD%E6%96%87");
    expect(() => remoteDirectoryUrl("-oProxyCommand=bad", "/tmp")).toThrow();
  });

  test("scp uses SFTP, exact glob-escaped paths, and argument arrays, never shell interpolation", () => {
    const args = remoteFileCopyArgs("whale", "/tmp/it's $(bad) [a]*?.md", "/local/preview/file.md");
    expect(args).toContain("-s");
    expect(args).not.toContain("-O");
    expect(args.slice(-3)).toEqual(["--", "whale:/tmp/it's $(bad) \\[a\\]\\*\\?.md", "/local/preview/file.md"]);
    expect(() => remoteFileCopyArgs("whale; touch bad", "/tmp/a", "/tmp/b")).toThrow();
    expect(() => remoteFileCopyArgs("whale", "/tmp/a\nb", "/tmp/b")).toThrow();
  });
});
