import type { Platform } from "@cst/shared";

const HOSTS: Record<Platform, readonly string[]> = {
  leetcode: ["leetcode.com"],
  codeforces: ["codeforces.com"],
  codechef: ["www.codechef.com", "codechef.com"],
};

/** Platform owning an https URL, or null. Only exact hosts listed in the manifest count. */
export function platformForUrl(url: string | undefined): Platform | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  for (const [platform, hosts] of Object.entries(HOSTS) as [Platform, readonly string[]][]) {
    if (hosts.includes(parsed.hostname)) return platform;
  }
  return null;
}

export function submissionKey(platform: Platform, submissionId: string): string {
  return `${platform}:${submissionId}`;
}
