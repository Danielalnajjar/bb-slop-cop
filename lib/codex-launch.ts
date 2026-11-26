import { defineRpcContract, type ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { reviewDeltaContract } from "./review-delta";

export const LEAN_CODEX_CONFIG_OVERRIDES = [
  "skills.include_instructions=false",
  "skills.bundled.enabled=false",
  "include_collaboration_mode_instructions=false",
  "include_apps_instructions=false",
  "features.apps=false",
  "features.multi_agent=false",
  "features.multi_agent_v2=false",
  "agents.enabled=false",
  "features.memories=false",
  'web_search="disabled"',
] as const;

export const codexLaunchContract = defineRpcContract({
  codexLaunchConfig: {
    input: z.object({}).strict(),
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("ready"),
        command: z.string().min(1),
        baseArgs: z.array(z.string()),
        mcpServers: z.array(z.string()),
      }),
      z.object({
        kind: z.literal("unavailable"),
        reason: z.string().min(1),
      }),
    ]),
  },
});

export const slopcopHostContract = {
  ...reviewDeltaContract,
  ...codexLaunchContract,
};

export type CodexLaunchConfigResult = z.infer<typeof codexLaunchContract.codexLaunchConfig.output>;

const appServerArgsEnvSchema = z.array(z.string());
const BARE_KEY_SEGMENT_RE = /^[A-Za-z0-9_-]+/;
const WINDOWS_PATHEXT_DEFAULT = ".COM;.EXE;.BAT;.CMD";

function skipWhitespace(line: string, index: number): number {
  let cursor = index;
  while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t")) {
    cursor += 1;
  }
  return cursor;
}

function parseBasicQuotedSegment(line: string, start: number): { value: string; next: number } | null {
  let cursor = start + 1;
  let decoded = "";
  while (cursor < line.length) {
    const ch = line[cursor]!;
    if (ch === '"') {
      return { value: decoded, next: cursor + 1 };
    }
    if (ch === "\\") {
      cursor += 1;
      if (cursor >= line.length) return null;
      const esc = line[cursor]!;
      switch (esc) {
        case "\\":
          decoded += "\\";
          cursor += 1;
          break;
        case '"':
          decoded += '"';
          cursor += 1;
          break;
        case "b":
          decoded += "\b";
          cursor += 1;
          break;
        case "f":
          decoded += "\f";
          cursor += 1;
          break;
        case "n":
          decoded += "\n";
          cursor += 1;
          break;
        case "r":
          decoded += "\r";
          cursor += 1;
          break;
        case "t":
          decoded += "\t";
          cursor += 1;
          break;
        case "u":
        case "U": {
          const width = esc === "u" ? 4 : 8;
          const hex = line.slice(cursor + 1, cursor + 1 + width);
          if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) return null;
          const codePoint = Number.parseInt(hex, 16);
          if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
          decoded += String.fromCodePoint(codePoint);
          cursor += 1 + width;
          break;
        }
        default:
          return null;
      }
      continue;
    }
    if (ch.charCodeAt(0) < 0x20 && ch !== "\t") return null;
    decoded += ch;
    cursor += 1;
  }
  return null;
}

function parseLiteralQuotedSegment(line: string, start: number): { value: string; next: number } | null {
  const close = line.indexOf("'", start + 1);
  if (close === -1) return null;
  const value = line.slice(start + 1, close);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09) return null;
  }
  return { value, next: close + 1 };
}

function parseTableHeaderSegments(rawLine: string): string[] | null {
  let cursor = skipWhitespace(rawLine, 0);
  if (rawLine[cursor] !== "[" || rawLine[cursor + 1] === "[") return null;
  cursor = skipWhitespace(rawLine, cursor + 1);

  const segments: string[] = [];
  while (cursor < rawLine.length) {
    const ch = rawLine[cursor]!;
    let parsed: { value: string; next: number } | null = null;
    if (ch === '"') {
      parsed = parseBasicQuotedSegment(rawLine, cursor);
    } else if (ch === "'") {
      parsed = parseLiteralQuotedSegment(rawLine, cursor);
    } else {
      const bare = BARE_KEY_SEGMENT_RE.exec(rawLine.slice(cursor))?.[0];
      if (bare) parsed = { value: bare, next: cursor + bare.length };
    }
    if (!parsed) return null;
    segments.push(parsed.value);
    cursor = skipWhitespace(rawLine, parsed.next);
    if (cursor >= rawLine.length) return null;
    const sep = rawLine[cursor]!;
    if (sep === "]") {
      const after = skipWhitespace(rawLine, cursor + 1);
      if (after >= rawLine.length || rawLine[after] === "#") return segments;
      return null;
    }
    if (sep !== ".") return null;
    cursor = skipWhitespace(rawLine, cursor + 1);
  }
  return null;
}

/**
 * Scan table-header lines only (`[mcp_servers.<name>]` and its subtables) without
 * parsing the whole file as TOML, returning unique sorted top-level server names.
 */
export function scanCodexMcpServerNamesFromText(text: string): string[] {
  const names = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i]!;
    if (i === 0 && line.startsWith("\uFEFF")) line = line.slice(1);
    const segments = parseTableHeaderSegments(line);
    if (segments !== null && segments.length >= 2 && segments[0] === "mcp_servers" && segments[1]!.length > 0) {
      names.add(segments[1]!);
    }
  }
  return [...names].sort();
}

export function resolveCodexConfigPath(options: { env?: NodeJS.ProcessEnv; homeDir?: string; configPath?: string } = {}): string {
  if (options.configPath) return options.configPath;
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return join(codexHome, "config.toml");
  return join(options.homeDir ?? homedir(), ".codex", "config.toml");
}

function sanitizeFsErrorCode(error: unknown): string {
  const raw = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  return /^[A-Za-z0-9_]+$/.test(raw) ? raw.toUpperCase() : "READ_ERROR";
}

/** Read only `[mcp_servers.<name>]` header names from Codex config without surfacing file text. */
export async function readCodexMcpServerNames(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string; configPath?: string; signal?: AbortSignal } = {},
): Promise<{ ok: true; names: string[] } | { ok: false; code: string }> {
  options.signal?.throwIfAborted();
  const configPath = resolveCodexConfigPath(options);
  try {
    const content = await readFile(configPath, { encoding: "utf8", signal: options.signal });
    return { ok: true, names: scanCodexMcpServerNamesFromText(content) };
  } catch (error) {
    options.signal?.throwIfAborted();
    const code = sanitizeFsErrorCode(error);
    if (code === "ENOENT") return { ok: true, names: [] };
    return { ok: false, code };
  }
}

function defaultIsExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateBinaryNames(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return ["codex"];
  const exts = (env.PATHEXT || WINDOWS_PATHEXT_DEFAULT)
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return ["codex", ...exts.map((ext) => `codex${ext.startsWith(".") ? ext : `.${ext}`}`)];
}

export type CodexLaunchResolution =
  | { ok: true; command: string; baseArgs: string[] }
  | { ok: false; reason: string };

/** Mirror BB `provider-codex`'s `resolveAppServerLaunch` command/args resolution on the target host. */
export function resolveCodexAppServerLaunch(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutableFile?: (candidate: string) => boolean;
} = {}): CodexLaunchResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile;

  const overrideCommand = env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND?.trim();
  if (overrideCommand) {
    const rawArgs = env.BB_CODEX_BRIDGE_APP_SERVER_ARGS;
    if (rawArgs === undefined) {
      return { ok: true, command: overrideCommand, baseArgs: [] };
    }
    try {
      const parsed = appServerArgsEnvSchema.safeParse(JSON.parse(rawArgs));
      if (!parsed.success) return { ok: false, reason: "invalid_app_server_args" };
      return { ok: true, command: overrideCommand, baseArgs: parsed.data };
    } catch {
      return { ok: false, reason: "invalid_app_server_args" };
    }
  }

  const pathValue = env.PATH ?? "";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const names = candidateBinaryNames(platform, env);
  for (const dir of pathValue.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (isExecutableFile(candidate)) {
        return { ok: true, command: candidate, baseArgs: ["app-server"] };
      }
    }
  }

  return { ok: false, reason: "codex_not_found" };
}

/**
 * Codex `-c` dotted-path overrides split on `.` without unquoting quotes, whereas
 * an inline TOML table under `mcp_servers` merges cleanly for both bare and quoted names.
 */
export function buildLeanCodexArgs(baseArgs: readonly string[], mcpServers: readonly string[]): string[] {
  const args = [...baseArgs];
  for (const override of LEAN_CODEX_CONFIG_OVERRIDES) {
    args.push("-c", override);
  }
  const uniqueNames = [...new Set(mcpServers.filter((name) => name.length > 0))].sort();
  if (uniqueNames.length > 0) {
    const entries = uniqueNames.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",");
    args.push("-c", `mcp_servers={${entries}}`);
  }
  return args;
}

export function buildLeanCodexEnvEntries(
  command: string,
  args: readonly string[],
): ExperimentalPluginProviderEnvEntry[] {
  return [
    {
      name: "BB_CODEX_BRIDGE_APP_SERVER_COMMAND",
      value: command,
      reason: "SlopCop lean Codex reviewer launch binary",
    },
    {
      name: "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
      value: JSON.stringify(args),
      reason: "SlopCop lean Codex reviewer launch overrides",
    },
  ];
}
