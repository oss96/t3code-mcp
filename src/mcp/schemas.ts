import * as z from "zod/v4";

import { INTERACTION_MODES, RUNTIME_MODES } from "../t3/contracts/orchestration.ts";

export const runtimeModeSchema = z.enum(RUNTIME_MODES);
export const interactionModeSchema = z.enum(INTERACTION_MODES);
export const contextSchema = z
  .array(z.object({ label: z.string().optional(), text: z.string() }))
  .optional()
  .describe("Extra context blocks appended below the prompt");

export type MessageContext = z.output<typeof contextSchema>;

export const waitFields = {
  wait: z
    .boolean()
    .optional()
    .describe("Wait for the turn to finish and return the reply (default false)"),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .optional()
    .describe("Max wait when wait=true (default 300)"),
};

const WAIT_DEFAULT_SECONDS = 300;

export const waitTimeoutMs = (timeoutSeconds: number | undefined): number =>
  (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000;
