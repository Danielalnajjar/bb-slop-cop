import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { LEAN_CODEX_CONFIG_OVERRIDES } from "./lib/codex-launch";
import plugin from "./server";

type EnvVarDescriptor = { name: string; note: string | null; secret: true; value: null };

function stubCleanProjectEnv(
  harness: ReturnType<typeof createFakePluginHost>["harness"],
  overrides: Partial<{
    inheritedVariables: EnvVarDescriptor[];
    variables: EnvVarDescriptor[];
  }> = {},
) {
  harness.inspection.sdk.stub("projects.machineEnvironment", () => ({
    builtInGit: { status: "logged in" as const, statusMessage: "ok" },
    inheritedVariables: overrides.inheritedVariables ?? [],
    variables: overrides.variables ?? [],
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("codex provider env contribution", () => {
  it("withholds launch overrides and skips host RPCs for non-SlopCop threads", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: () => ({
        kind: "ready",
        command: "/home/exedev/.local/bin/codex",
        baseArgs: ["app-server"],
        mcpServers: ["btca"],
      }),
    });
    harness.inspection.sdk.stub("threads.get", ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        originPluginId: threadId === "thr_crew" ? "crew" : null,
      }),
    );
    stubCleanProjectEnv(harness);

    await plugin(bb);

    expect(
      await harness.behavior.resolveProviderEnv("codex", {
        threadId: null,
        projectId: null,
        hostId: "host_pc",
      }),
    ).toEqual([]);
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);

    expect(
      await harness.behavior.resolveProviderEnv("codex", {
        threadId: "thr_ordinary",
        projectId: "proj_1",
        hostId: "host_pc",
      }),
    ).toEqual([]);
    expect(
      await harness.behavior.resolveProviderEnv("codex", {
        threadId: "thr_crew",
        projectId: "proj_1",
        hostId: "host_pc",
      }),
    ).toEqual([]);

    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
    expect(harness.inspection.sdk.callsTo("projects.machineEnvironment")).toHaveLength(0);
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("injects exact host Codex binary and lean overrides only for originPluginId=slopcop", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: () => ({
        kind: "ready",
        command: "/home/exedev/.local/bin/codex",
        baseArgs: ["app-server"],
        mcpServers: ["tldraw", "with.dot", "btca"],
      }),
    });
    harness.inspection.sdk.stub("threads.get", ({ threadId }) =>
      makeThreadResponse({ id: threadId, originPluginId: "slopcop" }),
    );
    stubCleanProjectEnv(harness, {
      inheritedVariables: [{ name: "CODEX_HOME", note: null, secret: true, value: null }],
    });

    await plugin(bb);

    const entries = await harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_slopcop_1",
      projectId: "proj_placecard",
      hostId: "host_pc",
    });

    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(1);
    expect(harness.inspection.experimental_hostRpcCalls[0]).toMatchObject({
      hostId: "host_pc",
      method: "codexLaunchConfig",
      input: {},
      timeoutMs: 3_000,
      signal: expect.any(AbortSignal),
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "BB_CODEX_BRIDGE_APP_SERVER_COMMAND",
      value: "/home/exedev/.local/bin/codex",
    });
    expect(entries[1]).toMatchObject({
      name: "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    });
    expect(JSON.parse(entries[1]!.value as string)).toEqual([
      "app-server",
      ...LEAN_CODEX_CONFIG_OVERRIDES.flatMap((value) => ["-c", value]),
      "-c",
      'mcp_servers={"btca"={enabled=false},"tldraw"={enabled=false},"with.dot"={enabled=false}}',
    ]);

    await harness.lifecycle.dispose();
  });

  it("withholds overrides without host RPCs when project machine environment overrides launch vars or lookup fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: () => ({
        kind: "ready",
        command: "/home/exedev/.local/bin/codex",
        baseArgs: ["app-server"],
        mcpServers: ["btca"],
      }),
    });
    harness.inspection.sdk.stub("threads.get", ({ threadId }) =>
      makeThreadResponse({ id: threadId, originPluginId: "slopcop" }),
    );
    harness.inspection.sdk.stub("projects.machineEnvironment", ({ projectId }) => {
      if (projectId === "proj_err") throw new Error("lookup unavailable");
      if (projectId === "proj_custom_home") {
        return {
          builtInGit: { status: "logged in" as const, statusMessage: "ok" },
          inheritedVariables: [],
          variables: [{ name: "HOME", note: null, secret: true, value: null }],
        };
      }
      return {
        builtInGit: { status: "logged in" as const, statusMessage: "ok" },
        inheritedVariables: [],
        variables: [{ name: "CODEX_HOME", note: null, secret: true, value: null }],
      };
    });

    await plugin(bb);

    expect(
      await harness.behavior.resolveProviderEnv("codex", {
        threadId: "thr_s_proj",
        projectId: "proj_custom_codex_home",
        hostId: "host_pc",
      }),
    ).toEqual([]);
    expect(
      await harness.behavior.resolveProviderEnv("codex", {
        threadId: "thr_s_home",
        projectId: "proj_custom_home",
        hostId: "host_pc",
      }),
    ).toEqual([]);
    expect(
      await harness.behavior.resolveProviderEnv("codex", {
        threadId: "thr_s_err",
        projectId: "proj_err",
        hostId: "host_pc",
      }),
    ).toEqual([]);
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);

    await harness.lifecycle.dispose();
  });

  it("coalesces concurrent lookups, caches per-host config for TTL, and refreshes after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T00:00:00Z"));
    let resolveRpc!: (value: unknown) => void;
    let callCount = 0;

    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: () => {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveRpc = resolve;
          });
        }
        return {
          kind: "ready",
          command: "/usr/local/bin/codex",
          baseArgs: ["app-server"],
          mcpServers: ["executor"],
        };
      },
    });
    harness.inspection.sdk.stub("threads.get", ({ threadId }) =>
      makeThreadResponse({ id: threadId, originPluginId: "slopcop" }),
    );
    stubCleanProjectEnv(harness);

    await plugin(bb);

    const p1 = harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_slopcop_1",
      projectId: "proj_1",
      hostId: "host_pc",
    });
    const p2 = harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_slopcop_2",
      projectId: "proj_1",
      hostId: "host_pc",
    });
    await vi.waitFor(() => {
      expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(1);
    });
    resolveRpc({
      kind: "ready",
      command: "/home/exedev/.local/bin/codex",
      baseArgs: ["app-server"],
      mcpServers: ["btca"],
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);

    // Within 30s TTL: cached result reuses host launch config and thread origin.
    await harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_slopcop_1",
      projectId: "proj_1",
      hostId: "host_pc",
    });
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(2);
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(1);

    // After 30s TTL: re-queries host.
    vi.advanceTimersByTime(31_000);
    const refreshed = await harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_slopcop_1",
      projectId: "proj_1",
      hostId: "host_pc",
    });
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(2);
    expect(refreshed[0]?.value).toBe("/usr/local/bin/codex");

    await harness.lifecycle.dispose();
  });

  it("evicts at most one cached host when coalesced callers land at cache capacity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T00:00:00Z"));
    let resolveHost65!: (value: unknown) => void;

    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: (call) => {
        if (call.hostId === "host_65") {
          return new Promise((resolve) => {
            resolveHost65 = resolve;
          });
        }
        return {
          kind: "ready",
          command: "/home/exedev/.local/bin/codex",
          baseArgs: ["app-server"],
          mcpServers: [],
        };
      },
    });
    harness.inspection.sdk.stub("threads.get", ({ threadId }) =>
      makeThreadResponse({ id: threadId, originPluginId: "slopcop" }),
    );
    stubCleanProjectEnv(harness);

    await plugin(bb);

    for (let i = 1; i <= 64; i += 1) {
      await harness.behavior.resolveProviderEnv("codex", {
        threadId: `thr_s_${i}`,
        projectId: null,
        hostId: `host_${i}`,
      });
    }
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(64);

    // Coalesce two concurrent lookups for host_65; only host_1 should be evicted.
    const c1 = harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_s_1",
      projectId: null,
      hostId: "host_65",
    });
    const c2 = harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_s_2",
      projectId: null,
      hostId: "host_65",
    });
    await vi.waitFor(() => {
      expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(65);
    });
    resolveHost65({
      kind: "ready",
      command: "/home/exedev/.local/bin/codex",
      baseArgs: ["app-server"],
      mcpServers: [],
    });
    await Promise.all([c1, c2]);

    // host_2 must still be cached (no new RPC), proving at most 1 entry was evicted.
    await harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_s_2",
      projectId: null,
      hostId: "host_2",
    });
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(65);

    await harness.lifecycle.dispose();
  });

  it("fails open to [] when host returns unavailable, errors, or hangs past the RPC timeout", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: () => {
        attempt += 1;
        if (attempt === 1) return { kind: "unavailable", reason: "codex_not_found" };
        if (attempt === 2) throw new Error("host offline");
        if (attempt === 3) return new Promise(() => {});
        return {
          kind: "ready",
          command: "/home/exedev/.local/bin/codex",
          baseArgs: ["app-server"],
          mcpServers: [],
        };
      },
    });
    harness.inspection.sdk.stub("threads.get", ({ threadId }) =>
      makeThreadResponse({ id: threadId, originPluginId: "slopcop" }),
    );
    stubCleanProjectEnv(harness);

    await plugin(bb);

    const ctx = { threadId: "thr_s1", projectId: "proj_1", hostId: "host_pc" };
    expect(await harness.behavior.resolveProviderEnv("codex", ctx)).toEqual([]);
    expect(await harness.behavior.resolveProviderEnv("codex", ctx)).toEqual([]);

    const timedOut = harness.behavior.resolveProviderEnv("codex", ctx);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(await timedOut).toEqual([]);

    const ok = await harness.behavior.resolveProviderEnv("codex", ctx);
    expect(ok[0]?.value).toBe("/home/exedev/.local/bin/codex");
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(4);

    await harness.lifecycle.dispose();
  });

  it("does not cache threads.get lookup failures across retries", async () => {
    let calls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: () => ({
        kind: "ready",
        command: "/home/exedev/.local/bin/codex",
        baseArgs: ["app-server"],
        mcpServers: [],
      }),
    });
    harness.inspection.sdk.stub("threads.get", () => {
      calls += 1;
      throw new Error("transient failure");
    });
    stubCleanProjectEnv(harness);

    await plugin(bb);
    const ctx = { threadId: "thr_flaky", projectId: "proj_1", hostId: "host_pc" };
    expect(await harness.behavior.resolveProviderEnv("codex", ctx)).toEqual([]);
    expect(await harness.behavior.resolveProviderEnv("codex", ctx)).toEqual([]);
    expect(calls).toBe(2);
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);

    await harness.lifecycle.dispose();
  });

  it("aborts in-flight codexLaunchConfig RPCs and cache-hit contributions on dispose", async () => {
    let seenSignal: AbortSignal | undefined;
    let resolveRpc!: (value: unknown) => void;
    let resolveSlowProj!: (value: unknown) => void;
    let attempt = 0;

    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: (call) => {
        attempt += 1;
        seenSignal = call.signal;
        if (attempt === 1) {
          return {
            kind: "ready",
            command: "/home/exedev/.local/bin/codex",
            baseArgs: ["app-server"],
            mcpServers: ["btca"],
          };
        }
        return new Promise((resolve) => {
          resolveRpc = resolve;
        });
      },
    });
    let seenThreadSignal: AbortSignal | undefined;
    harness.inspection.sdk.stub("threads.get", ({ threadId, signal }) => {
      if (threadId === "thr_dispose_cached") seenThreadSignal = signal;
      return makeThreadResponse({ id: threadId, originPluginId: "slopcop" });
    });
    harness.inspection.sdk.stub("projects.machineEnvironment", ({ projectId }) => {
      if (projectId === "proj_slow") {
        return new Promise((resolve) => {
          resolveSlowProj = resolve;
        });
      }
      return {
        builtInGit: { status: "logged in" as const, statusMessage: "ok" },
        inheritedVariables: [],
        variables: [],
      };
    });

    await plugin(bb);
    const watcher = harness.behavior.runService("watcher");
    const registeredResolver = harness.inspection.registrations.providerEnvResolvers.get("codex");
    expect(registeredResolver).toBeTypeOf("function");

    // Populate cache for thr_dispose_cached / host_cached, then start an in-flight RPC
    // (host_pc) and an in-flight cache-hit contribution (host_cached / proj_slow).
    expect(
      await harness.behavior.resolveProviderEnv("codex", {
        threadId: "thr_dispose_cached",
        projectId: null,
        hostId: "host_cached",
      }),
    ).toHaveLength(2);
    expect(seenThreadSignal).toBeInstanceOf(AbortSignal);

    let cacheHitDuringDispose: unknown;
    bb.onDispose(async () => {
      cacheHitDuringDispose = await registeredResolver!({
        threadId: "thr_dispose_cached",
        projectId: null,
        hostId: "host_cached",
      });
    });

    const pendingRpc = harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_dispose",
      projectId: "proj_1",
      hostId: "host_pc",
    });
    const pendingCached = harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_dispose_slow_proj",
      projectId: "proj_slow",
      hostId: "host_cached",
    });
    await vi.waitFor(() => {
      expect(seenSignal).toBeDefined();
      expect(resolveSlowProj).toBeDefined();
    });
    expect(seenSignal?.aborted).toBe(false);

    await harness.lifecycle.dispose();
    await watcher.done.catch(() => {});
    expect(seenSignal?.aborted).toBe(true);
    expect(cacheHitDuringDispose).toEqual([]);

    resolveRpc({
      kind: "ready",
      command: "/home/exedev/.local/bin/codex",
      baseArgs: ["app-server"],
      mcpServers: ["btca"],
    });
    resolveSlowProj({
      builtInGit: { status: "logged in" as const, statusMessage: "ok" },
      inheritedVariables: [],
      variables: [],
    });
    expect(await pendingRpc).toEqual([]);
    expect(await pendingCached).toEqual([]);
    // Even if the previously registered callback runs after disposal begins, return [].
    expect(
      await registeredResolver!({
        threadId: "thr_dispose_cached",
        projectId: null,
        hostId: "host_cached",
      }),
    ).toEqual([]);
  });
});
