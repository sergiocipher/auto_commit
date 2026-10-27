import { z } from "zod";
import { PlatformSchema, SettingsSchema, SubmissionEventSchema, VerdictSchema } from "@cst/shared";

/** A verdict seen on the page (any verdict, never carries source code). */
export const VerdictObservedSchema = z.strictObject({
  type: z.literal("verdict/observed"),
  platform: PlatformSchema,
  submissionId: z.string().min(1).max(100),
  verdict: VerdictSchema,
  rawVerdict: z.string().max(100).optional(),
  problemKey: z.string().min(1).max(200).optional(),
  problemTitle: z.string().max(500).optional(),
  at: z.number().int().nonnegative(),
});
export type VerdictObserved = z.infer<typeof VerdictObservedSchema>;

export const SubmissionDetectedSchema = z.strictObject({
  type: z.literal("submission/detected"),
  event: SubmissionEventSchema,
});

export const ContentMessageSchema = z.discriminatedUnion("type", [
  VerdictObservedSchema,
  SubmissionDetectedSchema,
]);
export type ContentMessage = z.infer<typeof ContentMessageSchema>;

export const PageMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("state/get") }),
  z.strictObject({ type: z.literal("settings/update"), settings: SettingsSchema }),
  z.strictObject({ type: z.literal("outbox/retry"), key: z.string().min(1).max(200).optional() }),
  z.strictObject({ type: z.literal("data/clear") }),
]);
export type PageMessage = z.infer<typeof PageMessageSchema>;

export type Reply<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
