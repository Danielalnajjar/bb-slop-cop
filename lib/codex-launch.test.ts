import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import reviewHost from "../host";
import {
  LEAN_CODEX_CONFIG_OVERRIDES,
  buildLeanCodexArgs,
  buildLeanCodexEnvEntries,
  readCodexMcpServerNames,
  resolveCodexAppServerLaunch,
  scanCodexMcpServerNamesFromText,
} from "./codex-launch";

describe("scanCodexMcpServerNamesFromText", () => {
  it("extracts sorted unique top-level server names from header lines only", () => {
    const fixture = [
      "\uFEFF# Top comment [mcp_servers.commented_out]",
      'model = "gpt-6.2-sol"',
      "",
      "[mcp_servers.btca]",
      'command = "btca"',
      "[mcp_servers.btca.env]",
      'API_KEY = "not_parsed_here"',
      "",
      '[  mcp_servers . "with.dot" . headers  ] # inline comment',
      'X = "val"',
      "",
      "[mcp_servers.'lit#hash'.env]",
      'FOO = "1"',
      "",
      'note = "[mcp_servers.inside_string_value]"',
      "[[mcp_servers.array_table]]",
      '[mcp_servers."esc\\"quote"]',
      "[mcp_servers.zeta]",
      "[mcp_servers.btca]",
      "[mcp_servers.unterminated",
      "[mcp_servers.trailing] extra",
      "[mcp_servers]",
      '[mcp_servers.""]',
    ].join("\r\n");

    expect(scanCodexMcpServerNamesFromText(fixture)).toEqual([
      'esc"quote',
      "btca",
      "lit#hash",
      "with.dot",
      "zeta",
    ].sort());
  });

  it("ignores broken escape sequences on malformed header lines instead of failing", () => {
    const fixture = [
      '[mcp_servers."bad\\qescape"]',
      '[mcp_servers."bad\\u12"]',
      "[mcp_servers.valid_one]",
    ].join("\n");

    expect(scanCodexMcpServerNamesFromText(fixture)).toEqual(["valid_one"]);
  });
});

describe("readCodexMcpServerNames", () => {
  it("reads from CODEX_HOME fixture config.toml and treats missing files as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slopcop-codex-cfg-"));
    try {
      const env = { CODEX_HOME: dir };
      expect(await readCodexMcpServerNames({ env })).toEqual({ ok: true, names: [] });

      writeFileSync(
        join(dir, "config.toml"),
        '[mcp_servers.excalidraw]\ncommand = "node"\n[mcp_servers.tldraw]\ncommand = "node"\n',
      );
      expect(await readCodexMcpServerNames({ env })).toEqual({
        ok: true,
        names: ["excalidraw", "tldraw"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns only a sanitized error code on unreadable config paths without leaking contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slopcop-codex-err-"));
    try {
      // Directory at configPath triggers EISDIR deterministically without relying on root/umask rules.
      const result = await readCodexMcpServerNames({ configPath: dir });
      expect(result).toEqual({ ok: false, code: "EISDIR" });
      expect(JSON.stringify(result)).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveCodexAppServerLaunch", () => {
  it("picks the first executable regular codex binary on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "slopcop-codex-bin-"));
    try {
      const dirBad = join(dir, "bad");
      const dirFirst = join(dir, "first");
      const dirSecond = join(dir, "second");
      mkdirSync(join(dirBad, "codex"), { recursive: true });
      mkdirSync(dirFirst, { recursive: true });
      mkdirSync(dirSecond, { recursive: true });
      writeFileSync(join(dirBad, "nonexec"), "");
      const nonExec = join(dirBad, "codex_no");
      writeFileSync(nonExec, "");
      chmodSync(nonExec, 0o644);

      const firstCodex = join(dirFirst, "codex");
      const secondCodex = join(dirSecond, "codex");
      writeFileSync(firstCodex, "#!/bin/sh\n");
      writeFileSync(secondCodex, "#!/bin/sh\n");
      chmodSync(firstCodex, 0o755);
      chmodSync(secondCodex, 0o755);

      const result = resolveCodexAppServerLaunch({
        platform: "linux",
        env: { PATH: `${dirBad}:${dirFirst}:${dirSecond}` },
      });
      expect(result).toEqual({
        ok: true,
        command: firstCodex,
        baseArgs: ["app-server"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors BB_CODEX_BRIDGE_APP_SERVER_COMMAND and ARGS and rejects invalid args without quoting", () => {
    expect(
      resolveCodexAppServerLaunch({
        env: {
          BB_CODEX_BRIDGE_APP_SERVER_COMMAND: "/custom/bin/codex",
          BB_CODEX_BRIDGE_APP_SERVER_ARGS: JSON.stringify(["--flag", "app-server"]),
        },
      }),
    ).toEqual({
      ok: true,
      command: "/custom/bin/codex",
      baseArgs: ["--flag", "app-server"],
    });

    expect(
      resolveCodexAppServerLaunch({
        env: {
          BB_CODEX_BRIDGE_APP_SERVER_COMMAND: "/custom/bin/codex",
          BB_CODEX_BRIDGE_APP_SERVER_ARGS: "secret-not-json",
        },
      }),
    ).toEqual({ ok: false, reason: "invalid_app_server_args" });
  });

  it("returns unavailable rather than hard-coding bare codex when absent from PATH", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "slopcop-codex-empty-"));
    try {
      expect(resolveCodexAppServerLaunch({ platform: "linux", env: { PATH: emptyDir } })).toEqual({
        ok: false,
        reason: "codex_not_found",
      });
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("buildLeanCodexArgs & host entry", () => {
  it("appends lean overrides and inline mcp_servers disablement", () => {
    const args = buildLeanCodexArgs(["app-server"], ["zeta", "with.dot", "zeta"]);
    expect(args).toEqual([
      "app-server",
      ...LEAN_CODEX_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]),
      "-c",
      'mcp_servers={"with.dot"={enabled=false},"zeta"={enabled=false}}',
    ]);

    const entries = buildLeanCodexEnvEntries("/usr/local/bin/codex", args);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe("BB_CODEX_BRIDGE_APP_SERVER_COMMAND");
    expect(entries[0]?.value).toBe("/usr/local/bin/codex");
    expect(entries[1]?.name).toBe("BB_CODEX_BRIDGE_APP_SERVER_ARGS");
    expect(JSON.parse(String(entries[1]?.value))).toEqual(args);
  });

  it("omits mcp_servers override when no configured servers are discovered", () => {
    const args = buildLeanCodexArgs(["app-server"], []);
    expect(args).toEqual([
      "app-server",
      ...LEAN_CODEX_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]),
    ]);
  });

  it("serves codexLaunchConfig from temp CODEX_HOME and temp PATH via host harness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slopcop-host-launch-"));
    const prevPath = process.env.PATH;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevCmd = process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND;
    const prevArgs = process.env.BB_CODEX_BRIDGE_APP_SERVER_ARGS;
    const harness = experimental_createHostEntryHarness(reviewHost);

    try {
      const binDir = join(dir, "bin");
      const codexHome = join(dir, "codex-home");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(codexHome, { recursive: true });
      const codexPath = join(binDir, "codex");
      writeFileSync(codexPath, "#!/bin/sh\n");
      chmodSync(codexPath, 0o755);
      writeFileSync(
        join(codexHome, "config.toml"),
        '[mcp_servers.btca]\ncommand = "echo"\n[mcp_servers."my.srv".env]\nK = "V"\n',
      );

      process.env.PATH = binDir;
      process.env.CODEX_HOME = codexHome;
      delete process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND;
      delete process.env.BB_CODEX_BRIDGE_APP_SERVER_ARGS;

      const result = await harness.experimental_call("codexLaunchConfig", {});
      expect(result).toEqual({
        kind: "ready",
        command: codexPath,
        baseArgs: ["app-server"],
        mcpServers: ["btca", "my.srv"],
      });
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      if (prevCmd === undefined) delete process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND;
      else process.env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND = prevCmd;
      if (prevArgs === undefined) delete process.env.BB_CODEX_BRIDGE_APP_SERVER_ARGS;
      else process.env.BB_CODEX_BRIDGE_APP_SERVER_ARGS = prevArgs;
      await harness.experimental_dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
