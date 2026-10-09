import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isTrustedAuthor } from "./matcher";
import type { PullRequest, ThreadRequest } from "./types";

const machineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("existing"), hostId: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("new"),
    machineProviderId: z.string().min(1),
    inputs: z.json().nullable().default(null),
  }).strict(),
]);

// Validate the fields used for placement; workspace and provider inputs are
// discarded, not replayed into the fresh review worktree.
const environmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-default") }).strict(),
  z.object({ type: z.literal("reuse"), environmentId: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("host"),
    hostId: z.string().min(1).optional(),
    workspace: z.unknown(),
  }).strict(),
  z.object({
    type: z.literal("provider"),
    environmentProviderId: z.string().min(1),
    inputs: z.unknown().optional(),
    machine: machineSchema.optional(),
  }).strict(),
]);

type EnvironmentInput = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"];

/** Pin a fresh built-in worktree, retaining machine placement but never a path. */
export async function buildReviewEnvironment(
  sdk: BbPluginApi["sdk"],
  request: ThreadRequest,
  pullRequest: PullRequest,
): Promise<EnvironmentInput> {
  // Managed provisioning runs trusted repository setup. Force may bypass rule
  // matching, but cannot authorize that execution for a drive-by fork author.
  if (!isTrustedAuthor(pullRequest.authorAssociation, "write_access")) {
    throw new Error("review input preparation requires a write-access trusted PR author");
  }
  if (!pullRequest.headRefOid || !pullRequest.baseRefOid) {
    throw new Error("review input preparation requires captured head and base SHAs");
  }
  const selection = environmentSchema.safeParse(
    request.environment === undefined ? { type: "project-default" } : request.environment,
  );
  if (!selection.success) {
    throw new Error("review input preparation cannot preserve an invalid environment selection");
  }
  const environment = selection.data;
  let machine: z.infer<typeof machineSchema> | undefined;
  if (environment.type === "provider") {
    machine = environment.machine;
  } else if (environment.type === "host" && environment.hostId !== undefined) {
    machine = { type: "existing", hostId: environment.hostId };
  } else if (environment.type === "reuse") {
    const existing = await sdk.environments.get({ environmentId: environment.environmentId });
    if (existing.projectId !== request.projectId || !existing.hostId) {
      throw new Error("review input preparation cannot resolve the selected environment's machine");
    }
    machine = { type: "existing", hostId: existing.hostId };
  }
  return {
    type: "provider",
    environmentProviderId: "git-worktree",
    inputs: { branch: { kind: "named", name: pullRequest.headRefOid } },
    ...(machine === undefined ? {} : { machine }),
  };
}
