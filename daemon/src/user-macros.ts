/**
 * Daemon-owned persistence for user macros: config/macros.json on this host.
 *
 * Every client of this daemon (local, or a Mac TUI over /ssh) sees the same
 * list. The file is small and re-read on each request, so a hand edit shows
 * up at the next connect or change without a restart. Writes replace the file
 * atomically; an unreadable file is never overwritten by a save.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { configDir } from "@exocortex/shared/paths";
import { MAX_USER_MACROS, normalizeUserMacro, normalizeUserMacroList, userMacroNameError, type UserMacro } from "@exocortex/shared/user-macros";

const FILE_VERSION = 1;

export function userMacrosPath(): string {
  return join(configDir(), "macros.json");
}

/** Read the file; throws when it exists but cannot be parsed. */
function readFile(): UserMacro[] {
  const path = userMacrosPath();
  if (!existsSync(path)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or move it before changing macros.`);
  }
  const macros = data && typeof data === "object" && !Array.isArray(data) ? (data as { macros?: unknown }).macros : data;
  return normalizeUserMacroList(macros);
}

function writeFile(macros: UserMacro[]): void {
  const path = userMacrosPath();
  mkdirSync(configDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, macros }, null, 2) + "\n");
  renameSync(tmp, path);
}

/** The saved macros, or none when the file is missing or unreadable. */
export function listUserMacros(): UserMacro[] {
  try { return readFile(); }
  catch { return []; }
}

/** Create or replace one macro. Returns the stored form and whether it replaced one. */
export function saveUserMacro(value: unknown, options: { create?: boolean } = {}): { macro: UserMacro; replaced: boolean; macros: UserMacro[] } {
  const macro = normalizeUserMacro(value);
  const current = readFile();
  const index = current.findIndex(item => item.name === macro.name);
  if (index >= 0 && options.create) throw new Error(`${macro.name} already exists. Use /macro edit ${macro.name} to change it.`);
  if (index < 0 && current.length >= MAX_USER_MACROS) throw new Error(`You already have ${MAX_USER_MACROS} macros; delete one first.`);
  const next = index >= 0 ? current.map((item, i) => i === index ? macro : item) : [...current, macro];
  next.sort((a, b) => a.name.localeCompare(b.name));
  writeFile(next);
  return { macro, replaced: index >= 0, macros: next };
}

/** Delete one macro by name. Returns what was deleted so a client can offer undo. */
export function deleteUserMacro(name: unknown): { macro: UserMacro; macros: UserMacro[] } {
  if (typeof name !== "string" || userMacroNameError(name)) throw new Error("Invalid macro name.");
  const current = readFile();
  const macro = current.find(item => item.name === name);
  if (!macro) throw new Error(`No macro named ${name}.`);
  const next = current.filter(item => item !== macro);
  writeFile(next);
  return { macro, macros: next };
}
