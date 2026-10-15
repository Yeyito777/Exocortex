/** Test doubles for /proxy: a fake `ssh` whose far end is a real endpoint, and stub upstream credentials. */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SshProcess } from "@exocortex/shared/ssh-transport";
import type { ProviderProxyRemoteStatus } from "@exocortex/shared/provider-proxy";
import { ProviderProxyEndpoint, type ProviderProxyEndpointDeps } from "./endpoint";
import type { UpstreamAuth } from "./upstream-auth";

export const loggedIn: ProviderProxyRemoteStatus = { loggedIn: true, authInfo: null, accountScope: "sha256:remote", usage: { fiveHour: { utilization: 12, resetsAt: null }, sevenDay: null } };

export interface UpstreamCall { url: string; init: RequestInit & { headers: Record<string, string> } }

export function stubAuth(overrides: Partial<UpstreamAuth> = {}): UpstreamAuth & { rejections: boolean[] } {
  const rejections: boolean[] = [];
  return {
    rejections,
    origin: (provider) => provider === "anthropic" ? "https://anthropic.test" : "https://openai.test",
    async headers(provider, _url, { afterRejection }) {
      rejections.push(afterRejection);
      return { authorization: `Bearer remote-${provider}-${afterRejection ? "fresh" : "token"}` };
    },
    async status() { return loggedIn; },
    async consumeReset() { return { outcome: "reset", windowsReset: 1 }; },
    ...overrides,
  };
}

/** A fake `ssh` whose far end is a real endpoint (or an outdated daemon). */
export function fakeSsh(options: {
  deps?: ProviderProxyEndpointDeps;
  outdated?: boolean;
  /** Command types the far end answers like a daemon that predates them. */
  unknownCommands?: string[];
  /** Leave `features` out of the hello, like a daemon that predates them. */
  noFeatures?: boolean;
  drain?: { needs: boolean; waiters: Array<() => void> };
} = {}) {
  const spawned: Array<{ process: SshProcess; endpoint: ProviderProxyEndpoint; kill(): void; commands: Array<Record<string, unknown>> }> = [];
  const spawn = (): SshProcess => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const commands: Array<Record<string, unknown>> = [];
    let alive = true;
    const endpoint = new ProviderProxyEndpoint({
      send: (event) => {
        if (!alive) return;
        const sent = options.noFeatures && event.type === "provider_proxy_hello_result" ? { ...event, features: undefined } : event;
        stdout.write(`${JSON.stringify(sent)}\n`);
      },
      needsDrain: () => options.drain?.needs ?? false,
      waitDrain: () => new Promise(resolve => { options.drain?.waiters.push(resolve); }),
    }, options.deps);
    let buffer = "";
    stdin.on("data", chunk => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const command = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        commands.push(command);
        if (options.outdated || options.unknownCommands?.includes(command.type)) stdout.write(`${JSON.stringify({ type: "error", reqId: command.reqId, message: `Unknown command: ${command.type}` })}\n`);
        else endpoint.handle(command);
      }
    });
    const kill = () => {
      if (!alive) return;
      alive = false;
      endpoint.close();
      emitter.emit("close", null, "SIGTERM");
    };
    const process = Object.assign(emitter, { stdin, stdout, stderr, kill: () => { kill(); return true; } }) as unknown as SshProcess;
    spawned.push({ process, endpoint, kill, commands });
    return process;
  };
  return { spawn, spawned };
}

