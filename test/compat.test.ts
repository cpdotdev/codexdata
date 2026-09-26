import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import publishedPayload from "../public/v1/compat/codex/latest.json";
import { KV_COMPAT } from "../src/http/compat";

const ADMIN = { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" };

describe("compat publish + read", () => {
  it("rejects a payload that fails the schema", async () => {
    const response = await SELF.fetch("https://data.cp.dev/admin/compat/publish", {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ schemaVersion: 1, dataset: "codex-compat" }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_compat_payload");
  });

  it("rejects publish without the admin token", async () => {
    const response = await SELF.fetch("https://data.cp.dev/admin/compat/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publishedPayload),
    });
    expect(response.status).toBe(401);
  });

  it("accepts the committed build output verbatim and then serves it from KV with an ETag", async () => {
    const publish = await SELF.fetch("https://data.cp.dev/admin/compat/publish", {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify(publishedPayload),
    });
    expect(publish.status).toBe(200);
    const receipt = (await publish.json()) as { ok: boolean; etag: string };
    expect(receipt.ok).toBe(true);
    expect(receipt.etag).toMatch(/^"compat-[0-9a-f]{16}"$/);

    const stored = await env.CODEXDATA_KV.get(KV_COMPAT);
    expect(stored).not.toBeNull();

    const read = await SELF.fetch("https://data.cp.dev/v1/compat/codex/latest.json");
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe(receipt.etag);
    const body = (await read.json()) as typeof publishedPayload;
    expect(body.dataset).toBe("codex-compat");
    expect(body.codex.latestStable).toBe(publishedPayload.codex.latestStable);

    const conditional = await SELF.fetch("https://data.cp.dev/v1/compat/codex/latest.json", {
      headers: { "if-none-match": receipt.etag },
    });
    expect(conditional.status).toBe(304);
  });
});
