import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { LEAN_CODEX_CONFIG_OVERRIDES } from "./lib/codex-launch";
import plugin from "./server";

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

  it("fails open to [] when host returns unavailable or errors without caching failures", async () => {
    let attempt = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: () => {
        attempt += 1;
        if (attempt === 1) return { kind: "unavailable", reason: "codex_not_found" };
        if (attempt === 2) throw new Error("host offline");
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

    await plugin(bb);

    const ctx = { threadId: "thr_s1", projectId: "proj_1", hostId: "host_pc" };
    expect(await harness.behavior.resolveProviderEnv("codex", ctx)).toEqual([]);
    expect(await harness.behavior.resolveProviderEnv("codex", ctx)).toEqual([]);
    const ok = await harness.behavior.resolveProviderEnv("codex", ctx);
    expect(ok[0]?.value).toBe("/home/exedev/.local/bin/codex");
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(3);

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

    await plugin(bb);
    const ctx = { threadId: "thr_flaky", projectId: "proj_1", hostId: "host_pc" };
    expect(await harness.behavior.resolveProviderEnv("codex", ctx)).toEqual([]);
    expect(await harness.behavior.resolveProviderEnv("codex", ctx)).toEqual([]);
    expect(calls).toBe(2);
    expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(0);

    await harness.lifecycle.dispose();
  });

  it("aborts in-flight codexLaunchConfig RPCs on dispose and returns [] without caching", async () => {
    let seenSignal: AbortSignal | undefined;
    let resolveRpc!: (value: unknown) => void;

    const { bb, harness } = createFakePluginHost({
      pluginId: "slopcop",
      experimental_callHostRpc: (call) => {
        seenSignal = call.signal;
        return new Promise((resolve) => {
          resolveRpc = resolve;
        });
      },
    });
    harness.inspection.sdk.stub("threads.get", ({ threadId }) =>
      makeThreadResponse({ id: threadId, originPluginId: "slopcop" }),
    );

    await plugin(bb);

    const pending = harness.behavior.resolveProviderEnv("codex", {
      threadId: "thr_dispose",
      projectId: "proj_1",
      hostId: "host_pc",
    });
    await vi.waitFor(() => {
      expect(seenSignal).toBeDefined();
    });
    expect(seenSignal?.aborted).toBe(false);

    await harness.lifecycle.dispose();
    expect(seenSignal?.aborted).toBe(true);

    resolveRpc({
      kind: "ready",
      command: "/home/exedev/.local/bin/codex",
      baseArgs: ["app-server"],
      mcpServers: ["btca"],
    });
    expect(await pending).toEqual([]);
  });
});
