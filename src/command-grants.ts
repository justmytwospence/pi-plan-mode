/**
 * Command grants: named, user-configured command prefixes that Plan mode's read-only bash policy
 * lets through, for tools that need to run code to inspect things (for example the marimo-pair
 * skill, which runs Python in a live notebook kernel). A grant only admits one simple command
 * that starts with one of its prefixes, optionally fed by a quoted heredoc; anything that could
 * chain, redirect, or expand into another command is still blocked.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";

export const COMMAND_GRANTS_ENV = "PI_PLAN_MODE_COMMAND_GRANTS";

export interface CommandGrant {
  label: string;
  /** What the grant lets planners do; shown in the picker and read by Jev. */
  description?: string;
  /** Allowed command prefixes, e.g. `bash ~/.agents/skills/marimo-pair/scripts/execute-code.sh`. */
  commands: string[];
  /** Skills loaded into planners while the grant is on (planners otherwise run without skills). */
  skills: string[];
  /** Preselected for planners when Jev is unavailable. */
  enabled: boolean;
  /** Also allowed in the main Plan mode session. */
  planMode: boolean;
}

/** A grant as passed to planners (resolved and self-contained). */
export interface ResolvedGrant {
  id: string;
  label: string;
  description?: string;
  commands: string[];
  skills: string[];
}

const SAFE_REDIRECTS = ["2>&1", "2>/dev/null", ">/dev/null"];

interface Parsed {
  words: string[];
}

/**
 * Split one simple command into words the way a POSIX shell would, or return undefined when it
 * uses anything beyond words, quotes, `~/`, and a trailing heredoc with a quoted delimiter:
 * separators, pipes, redirections, substitutions, globs, variables, comments, or assignments.
 */
export function parseSimpleCommand(command: string, home = homedir()): Parsed | undefined {
  const text = command.replace(/^\s+/u, "");
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  let tildeCandidate = false;
  const endWord = () => {
    if (!inWord) return;
    words.push(tildeCandidate ? expandTilde(word, home) : word);
    word = "";
    inWord = false;
    tildeCandidate = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "$" || character === "`") return undefined;
      else if (character === "\\") {
        const next = text[index + 1];
        if (next === undefined) return undefined;
        if (next === "\n") index += 1;
        else if ('$`"\\'.includes(next)) {
          word += next;
          index += 1;
        } else word += character;
      } else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      inWord = true;
      continue;
    }
    if (character === "\\") {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      index += 1;
      if (next === "\n") continue; // line continuation
      word += next;
      inWord = true;
      continue;
    }
    if (character === " " || character === "\t") {
      endWord();
      continue;
    }
    if (!inWord) {
      // Harmless output plumbing models add by habit.
      const redirect = SAFE_REDIRECTS.find((candidate) => text.startsWith(candidate, index));
      const after = redirect ? text[index + redirect.length] : undefined;
      if (redirect && (after === undefined || after === " " || after === "\t" || after === "\n")) {
        index += redirect.length - 1;
        continue;
      }
    }
    if (character === "<" && text[index + 1] === "<") {
      // Only a heredoc with a quoted delimiter (no expansion in its body), and nothing after it.
      endWord();
      return words.length > 0 && heredocEndsCommand(text.slice(index + 2)) ? { words } : undefined;
    }
    if (character === "\n" || character === "\r") {
      // A newline outside quotes ends the command; only trailing whitespace may follow.
      if (text.slice(index).trim()) return undefined;
      break;
    }
    if (";&|<>()`$*?[]{}#".includes(character)) return undefined;
    if (character === "=" && words.length === 0) return undefined; // VAR=value command
    if (!inWord && character === "~") tildeCandidate = true;
    word += character;
    inWord = true;
  }
  if (quote) return undefined;
  endWord();
  return words.length > 0 ? { words } : undefined;
}

function heredocEndsCommand(rest: string) {
  const match = /^(-?)[ \t]*(['"])([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*\r?\n/u.exec(rest);
  if (!match) return false;
  const stripTabs = match[1] === "-";
  const tag = match[3] ?? "";
  const lines = rest.slice(match[0].length).split(/\r?\n/u);
  const end = lines.findIndex((line) => (stripTabs ? line.replace(/^\t+/u, "") : line) === tag);
  return (
    end >= 0 &&
    lines
      .slice(end + 1)
      .join("\n")
      .trim() === ""
  );
}

function expandTilde(word: string, home: string) {
  if (word === "~") return home;
  if (word.startsWith("~/")) return `${home}${word.slice(1)}`;
  return word;
}

/** Same file, following symlinks when both exist. */
function samePath(left: string, right: string) {
  if (!isAbsolute(left) || !isAbsolute(right)) return false;
  if (normalize(left) === normalize(right)) return true;
  try {
    return realpathSync(resolve(left)) === realpathSync(resolve(right));
  } catch {
    return false;
  }
}

/** True when the whole command is one simple command starting with one of the granted prefixes. */
export function commandGrantAllows(command: string, prefixes: readonly string[], home = homedir()) {
  if (prefixes.length === 0) return false;
  const parsed = parseSimpleCommand(command, home);
  if (!parsed) return false;
  return prefixes.some((prefix) => {
    const wanted = parseSimpleCommand(prefix, home)?.words;
    if (!wanted || wanted.length > parsed.words.length) return false;
    return wanted.every((expected, index) => {
      const actual = parsed.words[index] ?? "";
      return actual === expected || (expected.includes("/") && samePath(actual, expected));
    });
  });
}

/** Prefixes granted to this planner process (from its environment). */
export function grantedPrefixesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[COMMAND_GRANTS_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function resolveGrant(id: string, grant: CommandGrant, expand: (path: string) => string): ResolvedGrant {
  return {
    id,
    label: grant.label,
    ...(grant.description ? { description: grant.description } : {}),
    commands: [...grant.commands],
    skills: grant.skills.map(expand),
  };
}

/** One line for prompts: what else bash may run. */
export function describeGrants(grants: readonly ResolvedGrant[]) {
  return grants
    .map(
      (grant) =>
        `${grant.label} (${grant.commands.map((command) => `\`${command} …\``).join(", ")})${grant.description ? `: ${grant.description}` : ""}`,
    )
    .join("; ");
}
