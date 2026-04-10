import { log } from "../../log";
import { OPENAI_ACCOUNT_CHECK_URL, OPENAI_ACCOUNTS_URL } from "./constants";
import { parseOpenAIJson } from "./http";

export interface OpenAIAccountContext {
  accountId: string;
  organizationName: string | null;
  organizationType: string | null;
  organizationRole: string | null;
  workspaceRole: string | null;
  subscriptionType: string | null;
}

interface OpenAIAccountCheckEntry {
  account?: {
    account_id?: string;
    name?: string | null;
    structure?: string | null;
    plan_type?: string | null;
    account_user_role?: string | null;
    workspace_type?: string | null;
    is_deactivated?: boolean;
  };
}

interface OpenAIAccountCheckResponse {
  accounts?: Record<string, OpenAIAccountCheckEntry>;
}

interface OpenAIAccountsListItem {
  id?: string;
  name?: string | null;
  structure?: string | null;
  current_user_role?: string | null;
  is_deactivated?: boolean;
}

interface OpenAIAccountsListResponse {
  items?: OpenAIAccountsListItem[];
}

function requestHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

function pickPrimaryAccount<T extends { id: string; organizationType: string | null; deactivated: boolean }>(accounts: T[]): T | null {
  const active = accounts.filter((candidate) => !candidate.deactivated);
  if (active.length === 0) return null;
  const personal = active.find((candidate) => candidate.organizationType === "personal");
  return personal ?? active[0];
}

function toAccountContextFromCheck(data: OpenAIAccountCheckResponse): OpenAIAccountContext | null {
  const accounts = Object.values(data.accounts ?? {})
    .map((entry) => entry.account)
    .filter((account): account is NonNullable<OpenAIAccountCheckEntry["account"]> => !!account?.account_id)
    .map((account) => ({
      id: account.account_id!,
      deactivated: account.is_deactivated === true,
      organizationName: account.name ?? null,
      organizationType: account.structure ?? account.workspace_type ?? null,
      organizationRole: account.account_user_role ?? null,
      workspaceRole: account.account_user_role ?? null,
      subscriptionType: account.plan_type ?? null,
    }));

  const selected = pickPrimaryAccount(accounts);
  if (!selected) return null;
  return {
    accountId: selected.id,
    organizationName: selected.organizationName,
    organizationType: selected.organizationType,
    organizationRole: selected.organizationRole,
    workspaceRole: selected.workspaceRole,
    subscriptionType: selected.subscriptionType,
  };
}

function toAccountContextFromList(data: OpenAIAccountsListResponse): OpenAIAccountContext | null {
  const accounts = (data.items ?? [])
    .filter((account): account is OpenAIAccountsListItem & { id: string } => typeof account.id === "string" && account.id.length > 0)
    .map((account) => ({
      id: account.id,
      deactivated: account.is_deactivated === true,
      organizationName: account.name ?? null,
      organizationType: account.structure ?? null,
      organizationRole: account.current_user_role ?? null,
      workspaceRole: account.current_user_role ?? null,
      subscriptionType: null,
    }));

  const selected = pickPrimaryAccount(accounts);
  if (!selected) return null;
  return {
    accountId: selected.id,
    organizationName: selected.organizationName,
    organizationType: selected.organizationType,
    organizationRole: selected.organizationRole,
    workspaceRole: selected.workspaceRole,
    subscriptionType: selected.subscriptionType,
  };
}

async function fetchJson<T>(url: string, accessToken: string, label: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: requestHeaders(accessToken),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return parseOpenAIJson<T>(text, label);
    } catch {
      log("warn", `openai auth: ${label.toLowerCase()} returned non-JSON response from ${url}`);
      return null;
    }
  } catch {
    return null;
  }
}

export async function fetchAccountContext(accessToken: string): Promise<OpenAIAccountContext | null> {
  const accountCheck = await fetchJson<OpenAIAccountCheckResponse>(
    OPENAI_ACCOUNT_CHECK_URL,
    accessToken,
    "OpenAI account check",
  );
  const fromCheck = accountCheck ? toAccountContextFromCheck(accountCheck) : null;
  if (fromCheck) return fromCheck;

  const accounts = await fetchJson<OpenAIAccountsListResponse>(
    OPENAI_ACCOUNTS_URL,
    accessToken,
    "OpenAI accounts",
  );
  return accounts ? toAccountContextFromList(accounts) : null;
}
