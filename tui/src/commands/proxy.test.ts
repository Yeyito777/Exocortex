import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateAutocomplete } from "../autocomplete";
import { tryCommand } from "../commands";
import { handleEvent, type DaemonActions } from "../events";
import { stripAnsi } from "../historycursor";
import { createInitialState } from "../state";
import { renderStatusLine } from "../statusline";
import { providerProxyBlock } from "../statusblocks/provider-proxy";
import type { ProviderProxyInfo } from "../protocol";

const originalConfig = process.env.EXOCORTEX_SSH_CONFIG;
const tempDirs: string[] = [];
const daemon: DaemonActions = { subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} };

afterEach(() => {
  if (originalConfig === undefined) delete process.env.EXOCORTEX_SSH_CONFIG;
  else process.env.EXOCORTEX_SSH_CONFIG = originalConfig;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const lastMessage = (state: ReturnType<typeof createInitialState>) => (state.messages.at(-1) as { text?: string }).text;
const connected: ProviderProxyInfo = { provider: "anthropic", alias: "whale", state: "connected", remoteHost: "yeyito@whale", remoteLoggedIn: true, remoteAccount: "someone@example.com" };

describe("/proxy", () => {
  test("parses status, set and off", () => {
    const state = createInitialState();
    expect(tryCommand("/proxy", state)).toEqual({ type: "provider_proxy", action: "status" });
    expect(tryCommand("/proxy anthropic whale", state)).toEqual({ type: "provider_proxy", action: "set", provider: "anthropic", alias: "whale" });
    expect(tryCommand("/proxy openai off", state)).toEqual({ type: "provider_proxy", action: "off", provider: "openai" });
  });

  test("rejects other providers, bad aliases and wrong arity", () => {
    const state = createInitialState();
    expect(tryCommand("/proxy deepseek whale", state)).toEqual({ type: "handled" });
    expect(lastMessage(state)).toBe("Only openai and anthropic can go through /proxy.");
    expect(tryCommand("/proxy openai -oProxyCommand=x", state)).toEqual({ type: "handled" });
    expect(lastMessage(state)).toContain("SSH alias may contain only");
    expect(tryCommand("/proxy openai", state)).toEqual({ type: "handled" });
    expect(lastMessage(state)).toBe("Usage: /proxy [openai|anthropic <ssh-alias>|off]");
    expect(tryCommand("/proxy openai whale extra", state)).toEqual({ type: "handled" });
  });

  test("autocompletes providers, then SSH aliases and off", () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-proxy-command-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, ".ssh"), { recursive: true });
    writeFileSync(join(dir, ".ssh", "config"), "Host whale\nHost *\n");
    process.env.EXOCORTEX_SSH_CONFIG = join(dir, ".ssh", "config");
    const state = createInitialState();
    state.inputBuffer = "/proxy anth";
    state.cursorPos = state.inputBuffer.length;
    updateAutocomplete(state);
    expect(state.autocomplete?.matches[0]?.name).toBe("anthropic");
    state.inputBuffer = "/proxy anthropic ";
    state.cursorPos = state.inputBuffer.length;
    updateAutocomplete(state);
    expect(state.autocomplete?.matches.map(match => match.name)).toEqual(["whale", "off"]);
  });

  test("shows the daemon's answer and lists proxies", () => {
    const state = createInitialState();
    handleEvent({ type: "provider_proxies", reqId: "r1", proxies: [] }, state, daemon);
    expect(lastMessage(state)).toContain("No provider goes through /proxy.");
    handleEvent({ type: "provider_proxies", reqId: "r2", proxies: [connected], message: "Anthropic now goes through whale." }, state, daemon);
    expect(lastMessage(state)).toBe("Anthropic now goes through whale.");
    handleEvent({ type: "provider_proxies", reqId: "r3", proxies: [connected] }, state, daemon);
    expect(lastMessage(state)).toContain("anthropic → whale: connected (yeyito@whale, someone@example.com)");
    const before = state.messages.length;
    handleEvent({ type: "provider_proxies", proxies: [{ ...connected, state: "disconnected", message: "lost" }] }, state, daemon);
    expect(state.messages.length).toBe(before);
    expect(state.providerProxies?.[0].state).toBe("disconnected");
  });

  test("explains a daemon too old for /proxy", () => {
    const state = createInitialState();
    handleEvent({ type: "error", reqId: "proxy_1", message: "Unknown command: provider_proxy" }, state, daemon);
    expect(lastMessage(state)).toBe("✗ The connected Exocortex daemon does not support /proxy; update it.");
  });
});

describe("/proxy status block", () => {
  test("appears only while the current provider is proxied, naming the alias and link state", () => {
    const state = createInitialState();
    state.provider = "anthropic";
    expect(providerProxyBlock(state)).toBeNull();
    state.providerProxies = [connected];
    const rendered = stripAnsi(renderStatusLine(state, 200).lines.join("\n"));
    expect(rendered).toContain("Proxy: whale connected");
    expect(rendered).toContain("someone@example.com");
    state.hideSensitiveInfo = true;
    expect(stripAnsi(renderStatusLine(state, 200).lines.join("\n"))).not.toContain("someone@example.com");
    state.providerProxies = [{ provider: "anthropic", alias: "whale", state: "disconnected", message: "The SSH connection to whale was lost." }];
    expect(stripAnsi(renderStatusLine(state, 200).lines.join("\n"))).toContain("Proxy: whale down");
    state.provider = "openai";
    expect(providerProxyBlock(state)).toBeNull();
  });
});
