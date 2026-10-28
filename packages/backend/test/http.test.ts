import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubClient, UploadError } from "@cst/core";
import { timedFetch } from "../src/http/fetch.js";

describe("timedFetch", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    // Accepts connections, never answers: a hung GitHub.
    server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("gives up on an unresponsive server", async () => {
    const started = Date.now();
    await expect(timedFetch(200)(`${base}/x`)).rejects.toThrow(/timeout|abort/i);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("surfaces as a retryable GitHub error", async () => {
    const client = new GitHubClient(timedFetch(200), "t", Date.now, base);
    const err = await client
      .request("GET", "/user", "reading the account")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).kind).toBe("retryable");
  });
});
