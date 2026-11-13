/**
 * Claude accounts: one Claude Code configuration directory each.
 *
 * Claude Code keeps a login per configuration directory (`CLAUDE_CONFIG_DIR`,
 * its documented way to stay signed in to several accounts). Account `main`
 * is whatever the daemon's environment already uses (normally `~/.claude`);
 * every other account is a directory of its own that the owner signs in to
 * with Claude Code's own login. Exocortex never reads, copies or proxies the
 * credentials in these directories: it only picks the directory a Claude
 * Code process starts with.
 *
 * An account may also carry a long-lived token (`claude setup-token`), kept in
 * the secrets store and named here: its turns then run on the token, which
 * lasts a year instead of the login's four weeks (account-token.ts,
 * docs/claude-accounts.md#long-lived-tokens).
 *
 * Each added directory links the main directory's sessions (`projects/`) and
 * user settings, so a conversation's Claude Code session resumes on any
 * account and every account runs with the same settings, skills and plugins.
 * The login (`.credentials.json`, `.claude.json`) stays per directory.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { dataDir } from "@exocortex/shared/paths";

export const MAIN_ACCOUNT_ID = "main";

/**
 * An account's long-lived token (`claude setup-token`). The token carries the
 * inference scope only, so it cannot say whose it is or when it ends: both
 * are recorded here when it is set (scripts/claude-account-token).
 */
export interface ClaudeAccountToken {
  /** Its name in the secrets store; the value is never written anywhere else. */
  secret: string;
  /** When it was minted (ISO 8601). Anthropic issues it for a year. */
  mintedAt: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

export interface ClaudeAccount {
  id: string;
  /** Claude Code configuration directory. */
  configDir: string;
  /** Whether Exocortex created the directory (and its links) itself. */
  managed?: boolean;
  addedAt?: string;
  /** Its long-lived token, when it has one. */
  token?: ClaudeAccountToken;
}

interface AccountsFile {
  accounts: ClaudeAccount[];
  /** Long-lived tokens by account name, `main` included (which has no entry in `accounts`). */
  tokens?: Record<string, ClaudeAccountToken>;
}

/** How long Anthropic issues a `claude setup-token` token for. */
export const CLAUDE_TOKEN_LIFETIME_MS = 365 * 86_400_000;
/** The owner is told this long before a token ends. */
export const CLAUDE_TOKEN_WARNING_MS = 30 * 86_400_000;
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Entries of the main configuration directory every account shares. */
export const SHARED_CONFIG_ENTRIES = [
  "projects",
  "settings.json",
  "CLAUDE.md",
  "skills",
  "agents",
  "commands",
  "plugins",
  "output-styles",
  "hooks",
  "statusline-command.sh",
] as const;

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

let accountsFileOverride: string | null = null;

/** Tests point the registry at a scratch file. */
export function setClaudeAccountsFileForTests(path: string | null): void {
  accountsFileOverride = path;
}

function accountsFile(): string {
  return accountsFileOverride ?? join(dataDir(), "anthropic-accounts.json");
}

/** The configuration directory Claude Code uses without CLAUDE_CONFIG_DIR overrides from Exocortex. */
export function mainClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseToken(value: unknown): ClaudeAccountToken | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.secret !== "string" || !SECRET_NAME_RE.test(raw.secret)) return null;
  if (typeof raw.mintedAt !== "string" || !Number.isFinite(Date.parse(raw.mintedAt))) return null;
  const str = (field: unknown) => typeof field === "string" && field ? field : undefined;
  const token: ClaudeAccountToken = { secret: raw.secret, mintedAt: raw.mintedAt };
  for (const name of ["email", "orgId", "orgName", "subscriptionType"] as const) {
    const field = str(raw[name]);
    if (field) token[name] = field;
  }
  return token;
}

function readRegistry(): { accounts: ClaudeAccount[]; tokens: Record<string, ClaudeAccountToken> } {
  try {
    const path = accountsFile();
    if (!existsSync(path)) return { accounts: [], tokens: {} };
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AccountsFile>;
    const accounts = !Array.isArray(parsed.accounts) ? [] : parsed.accounts.filter((account): account is ClaudeAccount =>
      typeof account?.id === "string" && ACCOUNT_ID_RE.test(account.id) && account.id !== MAIN_ACCOUNT_ID
      && typeof account.configDir === "string" && account.configDir.length > 0)
      // Tokens live in `tokens` only.
      .map(({ token: _token, ...account }) => account);
    const tokens: Record<string, ClaudeAccountToken> = {};
    if (parsed.tokens && typeof parsed.tokens === "object") {
      for (const [id, value] of Object.entries(parsed.tokens)) {
        const token = parseToken(value);
        if (token && (id === MAIN_ACCOUNT_ID || accounts.some(account => account.id === id))) tokens[id] = token;
      }
    }
    return { accounts, tokens };
  } catch {
    return { accounts: [], tokens: {} };
  }
}

function readAccountsFile(): ClaudeAccount[] {
  return readRegistry().accounts;
}

function writeRegistry(accounts: ClaudeAccount[], tokens: Record<string, ClaudeAccountToken>): void {
  const path = accountsFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const file: AccountsFile = { accounts, ...(Object.keys(tokens).length > 0 ? { tokens } : {}) };
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Rewrite the accounts, keeping the tokens of those that remain. */
function writeAccountsFile(accounts: ClaudeAccount[]): void {
  const tokens = readRegistry().tokens;
  for (const id of Object.keys(tokens)) {
    if (id !== MAIN_ACCOUNT_ID && !accounts.some(account => account.id === id)) delete tokens[id];
  }
  writeRegistry(accounts, tokens);
}

/** Every account, `main` first, in the order they were added. */
export function listClaudeAccounts(): ClaudeAccount[] {
  const { accounts, tokens } = readRegistry();
  return [{ id: MAIN_ACCOUNT_ID, configDir: mainClaudeConfigDir() }, ...accounts]
    .map(account => tokens[account.id] ? { ...account, token: tokens[account.id] } : account);
}

/** The secret a token is kept under unless another is named: CLAUDE_SETUP_TOKEN_MAIN, CLAUDE_SETUP_TOKEN_MAX2, … */
export function claudeTokenSecretName(account: string): string {
  return `CLAUDE_SETUP_TOKEN_${account.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** When the token ends: a year after it was minted. */
export function claudeTokenExpiresAt(token: ClaudeAccountToken): number {
  return Date.parse(token.mintedAt) + CLAUDE_TOKEN_LIFETIME_MS;
}

/** Give an account a long-lived token, or take it away (`null`): its turns then run on its own login again. */
export function setClaudeAccountToken(id: string, token: ClaudeAccountToken | null): void {
  const { accounts, tokens } = readRegistry();
  if (id !== MAIN_ACCOUNT_ID && !accounts.some(account => account.id === id)) throw new Error(`Unknown Claude account "${id}".`);
  if (token === null) delete tokens[id];
  else {
    const parsed = parseToken(token);
    if (!parsed) throw new Error("A token needs a secret name and the date it was minted.");
    tokens[id] = parsed;
  }
  writeRegistry(accounts, tokens);
}

export function getClaudeAccount(id: string): ClaudeAccount | undefined {
  return listClaudeAccounts().find(account => account.id === id);
}

/**
 * Environment additions that select the account. `main` adds nothing, so it
 * behaves exactly as Claude Code does on its own (including which macOS
 * Keychain entry it reads).
 */
export function claudeAccountEnv(accountId: string | undefined): Record<string, string> {
  if (!accountId || accountId === MAIN_ACCOUNT_ID) return {};
  const account = getClaudeAccount(accountId);
  if (!account) throw new Error(`Unknown Claude account "${accountId}".`);
  return { CLAUDE_CONFIG_DIR: account.configDir };
}

export function defaultAccountConfigDir(id: string): string {
  return join(homedir(), `.claude-${id}`);
}

/** Link the main directory's shared entries into an account directory; existing entries are left alone. */
export function linkSharedConfig(configDir: string, mainDir = mainClaudeConfigDir()): string[] {
  const linked: string[] = [];
  for (const name of SHARED_CONFIG_ENTRIES) {
    const source = join(mainDir, name);
    const target = join(configDir, name);
    // `projects/` is always shared, even before the main account has any sessions.
    if (name === "projects" && !existsSync(source)) mkdirSync(source, { recursive: true, mode: 0o700 });
    if (!existsSync(source)) continue;
    let present = false;
    try {
      lstatSync(target);
      present = true;
    } catch {
      // missing
    }
    if (present) continue;
    symlinkSync(source, target);
    linked.push(name);
  }
  return linked;
}

export interface AddedClaudeAccount {
  account: ClaudeAccount;
  created: boolean;
  linked: string[];
}

/**
 * Register an account and prepare its directory. It still has to be signed in
 * with Claude Code's own login (see claudeLoginCommand).
 */
export function addClaudeAccount(id: string, configDir?: string): AddedClaudeAccount {
  const normalized = id.trim().toLowerCase();
  if (!ACCOUNT_ID_RE.test(normalized)) {
    throw new Error("Account names use lowercase letters, digits and dashes (at most 32 characters).");
  }
  if (normalized === MAIN_ACCOUNT_ID) throw new Error(`"${MAIN_ACCOUNT_ID}" is the existing Claude Code login.`);
  const accounts = readAccountsFile();
  if (accounts.some(account => account.id === normalized)) throw new Error(`Claude account "${normalized}" already exists.`);
  const dir = resolve(expandHome(configDir?.trim() || defaultAccountConfigDir(normalized)));
  const mainDir = resolve(mainClaudeConfigDir());
  if (dir === mainDir) throw new Error(`${dir} is the main account's directory.`);
  const taken = accounts.find(account => resolve(account.configDir) === dir);
  if (taken) throw new Error(`${dir} already belongs to account "${taken.id}".`);
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const linked = linkSharedConfig(dir, mainDir);
  const account: ClaudeAccount = { id: normalized, configDir: dir, managed: created, addedAt: new Date().toISOString() };
  writeAccountsFile([...accounts, account]);
  return { account, created, linked };
}

/** Unregister an account. Its directory and login are left untouched. */
export function removeClaudeAccount(id: string): ClaudeAccount {
  const normalized = id.trim().toLowerCase();
  if (normalized === MAIN_ACCOUNT_ID) throw new Error(`The main Claude account cannot be removed.`);
  const accounts = readAccountsFile();
  const account = accounts.find(entry => entry.id === normalized);
  if (!account) throw new Error(`Unknown Claude account "${normalized}".`);
  writeAccountsFile(accounts.filter(entry => entry !== account));
  return account;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/**
 * The terminal command that signs an account in through Claude Code's own
 * login. `command` skips shell aliases such as `claude --permission-mode …`.
 */
export function claudeLoginCommand(account: ClaudeAccount): string {
  const env = account.id === MAIN_ACCOUNT_ID ? "" : `CLAUDE_CONFIG_DIR=${shellQuote(displayPath(account.configDir))} `;
  return `${env}command claude auth login --claudeai`;
}
