import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";

const HELPER = join(import.meta.dir, "computer");
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  requests: Array<Record<string, unknown>>;
}

async function runWithFakeDwm(
  args: string[],
  respond: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "computer-helper-test-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "dwm.sock");
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      socket.end(JSON.stringify({ id: request.id, ok: true, result: respond(request) }) + "\n");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const child = Bun.spawn([HELPER, ...args], {
    env: { ...process.env, DWM_IPC_SOCKET: socketPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return { exitCode, stdout, stderr, requests };
}

function exampleClient(): Record<string, unknown> {
  return {
    win: "0x0460000d",
    pid: 4242,
    title: "Example",
    class: "example",
    instance: "example",
    monitor: 0,
    tags: 1,
    selectedTags: 1,
    visible: true,
    focused: false,
    floating: false,
    fullscreen: false,
    geometry: { x: 10, y: 20, w: 800, h: 600, border: 1 },
    aiToken: null,
    aiLabel: null,
    isWidget: false,
    neverFocus: false,
    noFocusManage: false,
  };
}

describe("computer helper", () => {
  test("provides concise help through the executable", async () => {
    const child = Bun.spawn([HELPER, "-h"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: computer <command>");
    expect(stdout).toContain("type APP                    Read exact UTF-8 stdin");
  });

  test("rejects conflicting workspace placement options before IPC", async () => {
    const child = Bun.spawn([HELPER, "create-tag", "--index", "1", "--side", "right"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--index, --position, and --side are mutually exclusive");
  });

  test("lists windows through dwm IPC", async () => {
    const result = await runWithFakeDwm(["list-apps"], (request) => {
      expect(request.method).toBe("clients/list");
      return { clients: [exampleClient()] };
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Windows (1):");
    expect(result.stdout).toContain('"Example" id=0x0460000d pid=4242 class=example');
  });

  test("captures state without invoking screenshot programs when disabled", async () => {
    const result = await runWithFakeDwm(["state", "Example", "--no-screenshot"], (request) => {
      if (request.method === "clients/list") return { clients: [exampleClient()] };
      if (request.method === "monitors/list") {
        return {
          monitors: [{
            num: 0,
            focused: true,
            numTags: 9,
            selectedTags: 1,
            screen: { x: 0, y: 0, w: 1920, h: 1080, border: 0 },
            workarea: { x: 0, y: 20, w: 1920, h: 1060, border: 0 },
            selectedClient: null,
          }],
        };
      }
      throw new Error(`unexpected method: ${String(request.method)}`);
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("<app_state>");
    expect(result.stdout).toContain("bounds: x=10 y=20 w=800 h=600");
    expect(result.stdout).not.toContain("screenshot:");
    expect(result.requests.map((request) => request.method)).toEqual(["clients/list", "monitors/list"]);
  });

  test("workspace creation is background-first by default", async () => {
    const result = await runWithFakeDwm(["create-tag", "--index", "2"], (request) => {
      if (request.method === "tag/create") {
        return { action: "created", numTags: 10, selectedTags: 1 };
      }
      if (request.method === "tags/list") return { tags: [] };
      throw new Error(`unexpected method: ${String(request.method)}`);
    });

    expect(result.exitCode).toBe(0);
    expect(result.requests[0]).toMatchObject({ method: "tag/create", index: 2, select: false });
  });
});
