import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("validates numeric saves and exposes canonical legacy settings through status", async () => {
  const { bb, harness } = createFakePluginHost({ settings: { pollSeconds: "60", maxConcurrentReviews: "3" } });
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({ pollSeconds: 60 });
    for (const value of [14, 15.5, "60", true, NaN, Infinity]) {
      await expect(harness.behavior.setSettings({ pollSeconds: value })).rejects.toThrow();
    }
    for (const value of [0, 1.5, "3", true, NaN, Infinity]) {
      await expect(harness.behavior.setSettings({ maxConcurrentReviews: value })).rejects.toThrow();
    }
    for (const [pollSeconds, maxConcurrentReviews] of [[15, 1], [120, 1000]]) {
      await harness.behavior.setSettings({ pollSeconds, maxConcurrentReviews });
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({ pollSeconds });
    }
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("rejects invalid stored numbers before polling and leaves correction to the settings writer", async () => {
  for (const settings of [{ pollSeconds: 14 }, { maxConcurrentReviews: 0 }, { pollSeconds: 15.5 }, { maxConcurrentReviews: 1.5 }] as Record<string, number>[]) {
    const host = createFakePluginHost({ settings });
    let { harness } = host;
    try {
      await plugin(host.bb);
      await expect(harness.behavior.callRpc("status", null)).rejects.toThrow();
      const service = harness.behavior.runService("watcher");
      await expect(service.done).rejects.toThrow();
      expect(execFile).not.toHaveBeenCalled();
      ({ harness } = await harness.lifecycle.reload(plugin));
      await expect(harness.behavior.callRpc("status", null)).rejects.toThrow();
      await harness.behavior.setSettings({ pollSeconds: 15, maxConcurrentReviews: 1 });
      expect(await harness.behavior.callRpc("status", null)).toMatchObject({ pollSeconds: 15 });
    } finally {
      await harness.lifecycle.dispose();
    }
  }
});

it("uses typed defaults when numeric settings are absent", async () => {
  const { bb, harness } = createFakePluginHost();
  try {
    await plugin(bb);
    expect(await harness.behavior.callRpc("status", null)).toMatchObject({ pollSeconds: 60 });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each([
  { pollSeconds: "60", maxConcurrentReviews: "3", seconds: 60, cap: 3 },
  { pollSeconds: 15, maxConcurrentReviews: 1, seconds: 15, cap: 1 },
  { pollSeconds: undefined, maxConcurrentReviews: undefined, seconds: 60, cap: 3 },
])("polls every $seconds seconds and limits active reviews to $cap", async ({ pollSeconds, maxConcurrentReviews, seconds, cap }) => {
  vi.useFakeTimers();
  let polls = 0;
  vi.mocked(execFile).mockImplementation(((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    let response = "[]";
    if (args.includes("user")) response = "test-user";
    else if (args.some((arg: string) => arg.includes("pulls?"))) {
      polls += 1;
      response = JSON.stringify(Array.from({ length: 5 }, (_, index) => ({
        number: index + 1, title: `PR ${index + 1}`, draft: polls === 1,
        head: { sha: `sha-${index}` }, base: { ref: "main" },
        user: { login: "dana" }, author_association: "MEMBER", labels: [],
      })));
    }
    callback(null, response, "");
    return undefined as never;
  }) as unknown as typeof execFile);
  const { bb, harness } = createFakePluginHost({ settings: pollSeconds === undefined || maxConcurrentReviews === undefined ? {} : { pollSeconds, maxConcurrentReviews } });
  let spawned = 0;
  harness.inspection.sdk.stub("threads.spawn", () => makeThreadResponse({ id: `thr_${++spawned}` }));
  try {
    await plugin(bb);
    await harness.behavior.callRpc("saveRule", { id: null, rule: {
      name: "settings-review", repo: "acme/widgets",
      request: { projectId: "project", providerId: "codex", model: "test" },
    } });
    const service = harness.behavior.runService("watcher");
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(polls).toBe(1);
      expect(spawned).toBe(0);
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(polls).toBe(2);
      const result = await harness.behavior.callRpc("listRuns", {}) as { runs: { status: string }[] };
      expect(result.runs.filter(run => run.status === "reviewing")).toHaveLength(cap);
      expect(spawned).toBe(cap);
    } finally {
      service.controller.abort();
      await service.done;
    }
  } finally {
    await harness.lifecycle.dispose();
  }
});
