/**
 * User-defined macros: plain text shortcuts saved in the daemon host's config.
 *
 * The daemon owns persistence and syntax validation; clients own the clash
 * check against their built-in slash commands and macros, which the daemon
 * does not know. The name rule matches what the TUI's macro expansion
 * recognizes, so every saved macro can actually expand.
 */

export interface UserMacro {
  /** Starts with "/", then letters, digits, "_" or "-". */
  name: string;
  /** Text sent in place of the name. May span lines. */
  expansion: string;
  /** Short autocomplete label; absent shows a preview of the expansion. */
  description?: string;
}

export const USER_MACRO_NAME_PATTERN = /^\/[A-Za-z0-9_-]+$/;
export const MAX_USER_MACRO_NAME_LENGTH = 48;
export const MAX_USER_MACRO_DESCRIPTION_LENGTH = 120;
export const MAX_USER_MACRO_EXPANSION_LENGTH = 32_000;
export const MAX_USER_MACROS = 500;

/** Why `name` cannot name a macro, or null when it can. */
export function userMacroNameError(name: string): string | null {
  if (!name) return "Give the macro a name, e.g. /standup.";
  if (!name.startsWith("/")) return `Macro names start with "/": try /${name}.`;
  if (name.length === 1) return "Give the macro a name after the \"/\", e.g. /standup.";
  if (/\s/.test(name)) return "Macro names cannot contain spaces.";
  if (name.length > MAX_USER_MACRO_NAME_LENGTH) return `Macro names are at most ${MAX_USER_MACRO_NAME_LENGTH} characters.`;
  if (!USER_MACRO_NAME_PATTERN.test(name)) return "Macro names may only use letters, digits, \"_\" and \"-\" after the \"/\".";
  return null;
}

/**
 * Validate and canonicalize an untrusted macro. The expansion keeps its inner
 * line breaks but loses leading/trailing blank space; descriptions are one line.
 */
export function normalizeUserMacro(value: unknown): UserMacro {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid macro.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string") throw new Error("Invalid macro name.");
  const nameError = userMacroNameError(raw.name);
  if (nameError) throw new Error(nameError);
  if (typeof raw.expansion !== "string") throw new Error("Invalid macro expansion.");
  const expansion = raw.expansion.replace(/\r\n?/g, "\n").trim();
  if (!expansion) throw new Error(`${raw.name} needs some text to expand to.`);
  if (expansion.length > MAX_USER_MACRO_EXPANSION_LENGTH) {
    throw new Error(`Macro text is limited to ${MAX_USER_MACRO_EXPANSION_LENGTH.toLocaleString("en-US")} characters.`);
  }
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== "string") {
    throw new Error("Invalid macro description.");
  }
  const description = typeof raw.description === "string" ? raw.description.replace(/\s+/g, " ").trim() : "";
  if (description.length > MAX_USER_MACRO_DESCRIPTION_LENGTH) {
    throw new Error(`Macro descriptions are at most ${MAX_USER_MACRO_DESCRIPTION_LENGTH} characters.`);
  }
  return { name: raw.name, expansion, ...(description ? { description } : {}) };
}

/** Keep the valid, uniquely named macros of an untrusted list, sorted by name. */
export function normalizeUserMacroList(value: unknown): UserMacro[] {
  if (!Array.isArray(value)) return [];
  const byName = new Map<string, UserMacro>();
  for (const item of value) {
    try {
      const macro = normalizeUserMacro(item);
      if (!byName.has(macro.name)) byName.set(macro.name, macro);
    } catch { /* Skip a hand-edited entry the TUI could not expand. */ }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_USER_MACROS);
}
