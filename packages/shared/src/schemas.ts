import { z } from "zod";

export const PLATFORMS = ["leetcode", "codeforces", "codechef"] as const;
export const PlatformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof PlatformSchema>;

export const VerdictSchema = z.enum(["ACCEPTED", "REJECTED", "PENDING"]);
export type Verdict = z.infer<typeof VerdictSchema>;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase sha-256 hex");

export const ContestSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["contest", "gym", "problemset", "practice"]),
});

export const SubmissionEventSchema = z.strictObject({
  platform: PlatformSchema,
  problemKey: z.string().min(1).max(200),
  problemSlug: z.string().min(1).max(200),
  problemId: z.string().min(1).optional(),
  problemTitle: z.string().max(500),
  problemUrl: z.url(),
  submissionId: z.string().min(1).max(100),
  language: z.string().min(1).max(100),
  languageNormalized: z.string().min(1).optional(),
  // Byte-exact: no trimming or transforms. Non-empty enforced here as well.
  sourceCode: z.string().min(1).max(1_000_000),
  sourceSha256: Sha256Hex,
  verdict: VerdictSchema,
  submittedAt: z.number().int().nonnegative(),
  detectedAt: z.number().int().nonnegative(),
  contest: ContestSchema.optional(),
});
export type SubmissionEvent = z.infer<typeof SubmissionEventSchema>;

export const UPLOAD_STATUSES = [
  "RECEIVED",
  "SKIPPED_DUPLICATE",
  "SKIPPED_NOT_ELIGIBLE",
  "QUEUED",
  "UPLOADING",
  "RETRYING",
  "SUCCESS",
  "FAILED_PERMANENT",
  "NEEDS_AUTH",
] as const;
export const UploadStatusSchema = z.enum(UPLOAD_STATUSES);
export type UploadStatus = z.infer<typeof UploadStatusSchema>;

export const UploadRecordSchema = z.strictObject({
  id: z.string().min(1),
  userId: z.string().min(1),
  platform: PlatformSchema,
  problemKey: z.string().min(1),
  submissionId: z.string().min(1),
  language: z.string().min(1),
  repository: z.string(),
  branch: z.string(),
  filePath: z.string(),
  commitMessage: z.string(),
  commitSha: z.string().optional(),
  status: UploadStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  uploadedAt: z.number().int().nonnegative().optional(),
});
export type UploadRecord = z.infer<typeof UploadRecordSchema>;

export const PeriodPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("calendar_day") }),
  z.strictObject({ kind: z.literal("rolling_24h") }),
  z.strictObject({
    kind: z.literal("calendar_week"),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]),
  }),
  z.strictObject({ kind: z.literal("calendar_month") }),
  z.strictObject({ kind: z.literal("permanent") }),
  z.strictObject({
    kind: z.literal("custom_hours"),
    hours: z
      .number()
      .positive()
      .max(24 * 366),
  }),
]);
export type PeriodPolicy = z.infer<typeof PeriodPolicySchema>;

/** Validates an IANA timezone name using the runtime's Intl database. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// GitHub owner/repo/branch names: conservative character sets, no traversal.
const GitHubName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/)
  .refine((s) => s !== "." && s !== "..");
const BranchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    (s) => !s.includes("..") && !s.startsWith("/") && !s.endsWith("/") && !s.endsWith(".lock"),
  );

export const RepoConfigSchema = z.strictObject({
  owner: z.union([GitHubName, z.literal("")]),
  name: z.union([GitHubName, z.literal("")]),
  branch: BranchName,
});

export const SettingsSchema = z.strictObject({
  autoUpload: z.boolean(),
  period: PeriodPolicySchema,
  timezone: z.string().refine(isValidTimeZone, "unknown IANA timezone"),
  enabledPlatforms: z.strictObject({
    leetcode: z.boolean(),
    codeforces: z.boolean(),
    codechef: z.boolean(),
  }),
  uploadMetadata: z.boolean(),
  repo: RepoConfigSchema,
  // lowercased raw language string -> extension without the dot
  languageExtensionOverrides: z.record(z.string().min(1), z.string().regex(/^[a-z0-9]{1,10}$/)),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  autoUpload: true,
  period: { kind: "calendar_day" },
  timezone: "UTC",
  enabledPlatforms: { leetcode: true, codeforces: true, codechef: true },
  uploadMetadata: true,
  repo: { owner: "", name: "", branch: "main" },
  languageExtensionOverrides: {},
};

export const PLATFORM_DISPLAY: Record<Platform, string> = {
  leetcode: "LeetCode",
  codeforces: "Codeforces",
  codechef: "CodeChef",
};
