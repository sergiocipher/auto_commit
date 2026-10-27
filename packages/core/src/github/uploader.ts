import {
  buildMetadataPath,
  buildSolutionPath,
  problemFolder,
  type LanguageInfo,
  type SubmissionEvent,
} from "@cst/shared";
import { decodeBase64Utf8, gitBlobSha } from "../encoding.js";
import { UploadError } from "../errors.js";
import { encodePath, type GitHubClient, type RepoRef } from "./client.js";
import {
  mergeMetadata,
  MetadataConflictError,
  ProblemMetadataFileSchema,
  serializeMetadata,
  type ProblemMetadataFile,
} from "./metadata.js";

export const MAX_REF_CONFLICT_RETRIES = 3;

export interface UploadInput {
  repo: RepoRef;
  event: SubmissionEvent;
  language: LanguageInfo;
  commitMessage: string;
  uploadMetadata: boolean;
  now: number;
}

export type UploadOutcome =
  | { kind: "committed"; commitSha: string; filePath: string; warning?: string }
  | { kind: "identical"; filePath: string; commitSha?: string };

interface DirEntry {
  name: string;
  path: string;
  sha: string;
  type: string;
}

function repoPath(repo: RepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

type Target = { kind: "write"; path: string } | { kind: "identical"; path: string };

/**
 * Picks where the solution goes without ever overwriting an unrelated file:
 * default path if free; identical content anywhere counts as already done;
 * otherwise solution-<submissionId>.<ext>.
 */
function chooseTarget(
  input: UploadInput,
  files: Map<string, DirEntry>,
  sourceBlobSha: string,
): Target {
  const base = {
    platform: input.event.platform,
    problemSlug: input.event.problemSlug,
    extension: input.language.extension,
  };
  const primary = buildSolutionPath(base);
  const alternate = buildSolutionPath({ ...base, submissionId: input.event.submissionId });
  const existingPrimary = files.get(fileName(primary));
  if (!existingPrimary) return { kind: "write", path: primary };
  if (existingPrimary.sha === sourceBlobSha) return { kind: "identical", path: primary };
  const existingAlt = files.get(fileName(alternate));
  if (!existingAlt) return { kind: "write", path: alternate };
  if (existingAlt.sha === sourceBlobSha) return { kind: "identical", path: alternate };
  throw new UploadError(
    "permanent",
    `${alternate} already exists with different content; refusing to overwrite it`,
  );
}

async function readMetadata(
  client: GitHubClient,
  input: UploadInput,
  entry: DirEntry | undefined,
): Promise<{ existing: ProblemMetadataFile | null; unreadable: boolean }> {
  if (!entry) return { existing: null, unreadable: false };
  const blob = await client.request<{ content: string; encoding: string }>(
    "GET",
    repoPath(input.repo, `/git/blobs/${entry.sha}`),
    "reading metadata.json",
  );
  try {
    const text = blob.encoding === "base64" ? decodeBase64Utf8(blob.content) : blob.content;
    const parsed = ProblemMetadataFileSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? { existing: parsed.data, unreadable: false }
      : { existing: null, unreadable: true };
  } catch {
    return { existing: null, unreadable: true };
  }
}

async function lastCommitTouching(
  client: GitHubClient,
  repo: RepoRef,
  path: string,
): Promise<string | undefined> {
  try {
    const commits = await client.request<{ sha: string }[]>(
      "GET",
      repoPath(
        repo,
        `/commits?sha=${encodeURIComponent(repo.branch)}&path=${encodeURIComponent(path)}&per_page=1`,
      ),
      "looking up the existing commit",
    );
    return commits[0]?.sha;
  } catch {
    return undefined; // informational only
  }
}

/**
 * Writes the solution (and merged metadata.json) in one atomic commit via
 * the Git Data API: blobs -> tree -> commit -> non-forced ref update.
 * Idempotent: identical content already on the branch makes no commit.
 * A ref conflict (branch moved) rebuilds from the new head, bounded.
 */
export async function uploadSolution(
  client: GitHubClient,
  input: UploadInput,
): Promise<UploadOutcome> {
  const { repo, event } = input;
  const folder = problemFolder(event.platform, event.problemSlug);
  const sourceBlobSha = await gitBlobSha(event.sourceCode);
  const refPath = repoPath(repo, `/git/ref/heads/${encodePath(repo.branch)}`);

  for (let attempt = 0; attempt <= MAX_REF_CONFLICT_RETRIES; attempt++) {
    const ref = await client.request<{ object: { sha: string } }>(
      "GET",
      refPath,
      "reading the branch head",
    );
    const head = ref.object.sha;
    const headCommit = await client.request<{ tree: { sha: string } }>(
      "GET",
      repoPath(repo, `/git/commits/${head}`),
      "reading the head commit",
    );

    const listing = await client.requestOptional<DirEntry[] | DirEntry>(
      "GET",
      repoPath(repo, `/contents/${encodePath(folder)}?ref=${head}`),
      "listing the problem folder",
    );
    if (listing && !Array.isArray(listing)) {
      throw new UploadError("permanent", `${folder} exists in the repository but is not a folder`);
    }
    const files = new Map((listing ?? []).filter((e) => e.type === "file").map((e) => [e.name, e]));

    const target = chooseTarget(input, files, sourceBlobSha);
    if (target.kind === "identical") {
      return {
        kind: "identical",
        filePath: target.path,
        commitSha: await lastCommitTouching(client, repo, target.path),
      };
    }

    const treeEntries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
    const blob = await client.request<{ sha: string }>(
      "POST",
      repoPath(repo, "/git/blobs"),
      "uploading the solution",
      {
        content: event.sourceCode,
        encoding: "utf-8",
      },
    );
    if (blob.sha !== sourceBlobSha) {
      throw new UploadError(
        "permanent",
        "GitHub stored different bytes than the submitted source; aborting",
      );
    }
    treeEntries.push({ path: target.path, mode: "100644", type: "blob", sha: blob.sha });

    let warning: string | undefined;
    if (input.uploadMetadata) {
      const { existing, unreadable } = await readMetadata(
        client,
        input,
        files.get("metadata.json"),
      );
      if (unreadable) {
        warning = "Existing metadata.json is not valid; left unchanged.";
      } else {
        let merged: ProblemMetadataFile;
        try {
          merged = mergeMetadata(existing, event, input.language, fileName(target.path), input.now);
        } catch (err) {
          if (err instanceof MetadataConflictError) throw new UploadError("permanent", err.message);
          throw err;
        }
        const metaBlob = await client.request<{ sha: string }>(
          "POST",
          repoPath(repo, "/git/blobs"),
          "uploading metadata.json",
          { content: serializeMetadata(merged), encoding: "utf-8" },
        );
        treeEntries.push({
          path: buildMetadataPath(event.platform, event.problemSlug),
          mode: "100644",
          type: "blob",
          sha: metaBlob.sha,
        });
      }
    }

    const tree = await client.request<{ sha: string }>(
      "POST",
      repoPath(repo, "/git/trees"),
      "creating the tree",
      {
        base_tree: headCommit.tree.sha,
        tree: treeEntries,
      },
    );
    const commit = await client.request<{ sha: string }>(
      "POST",
      repoPath(repo, "/git/commits"),
      "creating the commit",
      {
        message: input.commitMessage,
        tree: tree.sha,
        parents: [head],
      },
    );
    try {
      await client.request(
        "PATCH",
        repoPath(repo, `/git/refs/heads/${encodePath(repo.branch)}`),
        "updating the branch",
        { sha: commit.sha, force: false },
      );
    } catch (err) {
      if (err instanceof UploadError && (err.status === 422 || err.status === 409)) continue; // branch moved
      throw err;
    }
    return {
      kind: "committed",
      commitSha: commit.sha,
      filePath: target.path,
      ...(warning ? { warning } : {}),
    };
  }
  throw new UploadError("conflict", "The branch kept changing during upload; will retry");
}
