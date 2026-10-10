import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import publishedPayload from "../public/v1/compat/codex/latest.json";
import compatText from "../public/v1/compat/codex/latest.json?raw";
import { KV_COMPAT, publishCompat } from "../src/http/compat";
import { DATA_CONTEXTS, verifySignature } from "../src/sync/signature";
import { DATA_SIGNING_VECTOR, SIGNING_VECTOR, signData } from "./fixtures";

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

describe("compat signatures (docs/DATA-SIGNING.md)", () => {
  const URL_LATEST = "https://data.cp.dev/v1/compat/codex/latest.json";
  const bytes = new TextEncoder().encode(compatText);

  async function publish(body: BodyInit, signature?: string): Promise<Response> {
    return SELF.fetch("https://data.cp.dev/admin/compat/publish", {
      method: "POST",
      headers: { ...ADMIN, ...(signature ? { "x-codexdata-signature": signature } : {}) },
      body,
    });
  }

  it("stores the signed bytes verbatim and serves them with the signature", async () => {
    const signature = await signData(DATA_SIGNING_VECTOR, DATA_CONTEXTS.compat, bytes);
    const response = await publish(compatText, signature);
    expect(response.status).toBe(200);
    const receipt = (await response.json()) as { etag: string; signed: boolean };
    expect(receipt.signed).toBe(true);
    expect(await env.CODEXDATA_KV.get(KV_COMPAT)).toBe(compatText);

    const read = await SELF.fetch(URL_LATEST);
    expect(read.status).toBe(200);
    expect(read.headers.get("x-codexdata-signature")).toBe(signature);
    expect(read.headers.get("etag")).toBe(receipt.etag);
    const served = await read.text();
    expect(served).toBe(compatText);
    expect(
      await verifySignature(
        DATA_CONTEXTS.compat,
        served,
        read.headers.get("x-codexdata-signature")!,
        DATA_SIGNING_VECTOR.publicKey,
      ),
    ).toMatchObject({ ok: true });

    const conditional = await SELF.fetch(URL_LATEST, {
      headers: { "if-none-match": receipt.etag },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("x-codexdata-signature")).toBe(signature);

    // The same body published unsigned gets another ETag, so a client holding the signed ETag
    // revalidates into the new (unsigned, refused) response instead of keeping a stale signature.
    const unsigned = (await (await publish(compatText)).json()) as { etag: string };
    expect(unsigned.etag).not.toBe(receipt.etag);
    expect((await SELF.fetch(URL_LATEST)).headers.get("x-codexdata-signature")).toBeNull();
  });

  it("refuses a bad signature and leaves the published record alone", async () => {
    const good = await signData(DATA_SIGNING_VECTOR, DATA_CONTEXTS.compat, bytes);
    expect((await publish(compatText, good)).status).toBe(200);
    const before = await env.CODEXDATA_KV.getWithMetadata(KV_COMPAT);

    const tampered = compatText.replace('"codex-compat"', '"codex-compat" ');
    const cases: [string, string, string][] = [
      ["tampered body", tampered, good],
      [
        "other dataset",
        compatText,
        await signData(DATA_SIGNING_VECTOR, DATA_CONTEXTS.quotaPolicy, bytes),
      ],
      ["catalog key", compatText, await signData(SIGNING_VECTOR, DATA_CONTEXTS.compat, bytes)],
      ["malformed", compatText, "v1.nope"],
      ["repeated", compatText, `${good}, ${good}`],
    ];
    for (const [label, body, signature] of cases) {
      const response = await publish(body, signature);
      expect(response.status, label).toBe(422);
      expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
        "invalid_compat_signature",
      );
    }
    const after = await env.CODEXDATA_KV.getWithMetadata(KV_COMPAT);
    expect(after.value).toBe(before.value);
    expect(after.metadata).toEqual(before.metadata);
  });

  it("refuses unsigned publishes once DATA_SIGNATURE_REQUIRED is true", async () => {
    const strict = { ...env, DATA_SIGNATURE_REQUIRED: "true" } as unknown as Env;
    const refused = await publishCompat(strict, bytes, null);
    expect(refused.status).toBe(422);
    const signature = await signData(DATA_SIGNING_VECTOR, DATA_CONTEXTS.compat, bytes);
    expect((await publishCompat(strict, bytes, signature)).status).toBe(200);
  });

  it("refuses a body that is not UTF-8", async () => {
    const response = await publish(new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(response.status).toBe(400);
  });
});
