import type { RenderState } from "../state";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { ProviderId } from "../messages";
import type { CommandResult } from "./types";
import { availableProviders } from "./shared";

interface ProviderCommandParseSuccess {
  ok: true;
  provider?: ProviderId;
  providers: ProviderId[];
}

interface ProviderCommandParseFailure {
  ok: false;
  result: CommandResult;
}

export type ProviderCommandParseResult = ProviderCommandParseSuccess | ProviderCommandParseFailure;

function handleProviderCommandError(state: RenderState, message: string): ProviderCommandParseFailure {
  pushSystemMessage(state, message);
  clearPrompt(state);
  return { ok: false, result: { type: "handled" } };
}

export function parseOptionalProviderCommand(
  text: string,
  state: RenderState,
  commandName: "/login" | "/logout",
): ProviderCommandParseResult {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const providers = availableProviders(state);

  if (parts.length > 2) {
    return handleProviderCommandError(state, `Usage: ${commandName} [${providers.join("|")}]`);
  }

  const provider = parts[1] as ProviderId | undefined;
  if (provider && !providers.includes(provider)) {
    return handleProviderCommandError(state, `Unknown provider: ${provider}. Available: ${providers.join(", ")}`);
  }

  return { ok: true, provider, providers };
}
