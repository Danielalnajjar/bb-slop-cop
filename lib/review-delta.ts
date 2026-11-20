import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const reviewSha = z.string().regex(/^[a-f0-9]{40}$/);
export const reviewDeltaContract = defineRpcContract({
  reviewDelta: {
    input: z.object({
      repo: z.string(),
      sourcePath: z.string(),
      prior: reviewSha,
      priorBase: reviewSha,
      base: reviewSha,
      head: reviewSha,
    }),
    output: z.object({
      tree: reviewSha,
      patchBase64: z.base64(),
      baseMerged: z.boolean(),
    }).nullable(),
  },
});
