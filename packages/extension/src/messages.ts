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
  z.strictObject({ type: z.literal("github/device/start") }),
  z.strictObject({ type: z.literal("github/device/poll") }),
  z.strictObject({ type: z.literal("github/disconnect") }),
  z.strictObject({ type: z.literal("github/repos") }),
  z.strictObject({
    type: z.literal("github/branches"),
    owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  }),
  z.strictObject({
    type: z.literal("upload/retry"),
    platform: PlatformSchema,
    submissionId: z.string().min(1).max(100),
  }),
  z.strictObject({
    type: z.literal("upload/force"),
    platform: PlatformSchema,
    submissionId: z.string().min(1).max(100),
  }),
  z.strictObject({ type: z.literal("upload/retry-failed") }),
  z.strictObject({
    type: z.literal("backend/pair"),
    url: z.string().min(1).max(100),
    code: z.string().min(8).max(64),
  }),
  z.strictObject({ type: z.literal("backend/unpair") }),
]);
export type PageMessage = z.infer<typeof PageMessageSchema>;

export type Reply<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
