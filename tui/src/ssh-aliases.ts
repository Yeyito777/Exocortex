/** Discover concrete Host aliases from OpenSSH config files and Includes. */

import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function configTokens(line: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of line) {
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#") break;
    if (/\s/.test(ch)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += ch;
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

function includeFiles(pattern: string, includingFile: string, home: string): string[] {
  const expanded = expandHome(pattern, home);
  const absolute = isAbsolute(expanded) ? expanded : resolve(dirname(includingFile), expanded);
  try {
    if (!/[*?\[\]{}]/.test(absolute)) return existsSync(absolute) ? [absolute] : [];
    return globSync(absolute).sort();
  } catch {
    return [];
  }
}

function isConcreteAlias(value: string): boolean {
  return value.length > 0
    && !value.startsWith("!")
    && !/[*?\[\]]/.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

export interface LoadSshAliasesOptions {
  configFiles?: string[];
  home?: string;
}

export function loadSshAliases(options: LoadSshAliasesOptions = {}): string[] {
  const home = options.home ?? homedir();
  const configuredPath = process.env.EXOCORTEX_SSH_CONFIG?.trim();
  const roots = options.configFiles
    ?? (configuredPath ? [configuredPath] : [join(home, ".ssh", "config"), "/etc/ssh/ssh_config"]);
  const aliases = new Set<string>();
  const visited = new Set<string>();

  const readConfig = (path: string) => {
    const expanded = expandHome(path, home);
    if (!existsSync(expanded)) return;
    let canonical: string;
    try { canonical = realpathSync(expanded); } catch { canonical = resolve(expanded); }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    let text: string;
    try { text = readFileSync(canonical, "utf8"); } catch { return; }
    for (const line of text.split(/\r?\n/)) {
      const tokens = configTokens(line);
      if (tokens.length < 2) continue;
      const keyword = tokens[0].toLowerCase();
      if (keyword === "host") {
        for (const candidate of tokens.slice(1)) {
          if (isConcreteAlias(candidate)) aliases.add(candidate);
        }
      } else if (keyword === "include") {
        for (const pattern of tokens.slice(1)) {
          for (const included of includeFiles(pattern, canonical, home)) readConfig(included);
        }
      }
    }
  };

  for (const root of roots) readConfig(root);
  return [...aliases].sort((a, b) => a.localeCompare(b));
}
