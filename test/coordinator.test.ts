// Integration tests: a real Worker + Durable Object + KV running in Miniflare; outbound fetches are
// intercepted by test/outbound-mock.ts (Miniflare outboundService) and scripted via https://mock.local.
import {
  createExecutionContext,
  createScheduledController,
  env,
  reset,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { canonicalCatalogText, catalogHash } from "../src/sync/catalog";
import {
  KV_CHANGES,
  KV_CURRENT,
  KV_META,
  kvSnapshotKey,
  type CatalogKvMetadata,
  type CodexMeta,
} from "../src/sync/coordinator";
import { keyId, verifyCatalogSignature } from "../src/sync/signature";
import {
  officialModel,
  SECOND_TEST_KEY,
  signCatalogText,
  signWithCryptoKey,
  SIGNING_VECTOR,
  type TestSigningKey,
} from "./fixtures";

const mock = {
  reset: () => fetch("https://mock.local/reset", { method: "POST" }),
  oauth: (status: number, body: unknown) =>
    fetch("https://mock.local/oauth", {
      method: "POST",
      body: JSON.stringify({ status, body: JSON.stringify(body) }),
    }),
  log: async () =>
    (await (await fetch("https://mock.local/log")).json()) as Array<{
      url: string;
      method: string;
      body: string;
    }>,
  oauthRefreshTokensSeen: async () =>
    (await mock.log())
      .filter((e) => e.url.startsWith("https://auth.openai.com/oauth/token"))
      .map((e) => (JSON.parse(e.body) as { refresh_token: string }).refresh_token),
};

const ADMIN = { authorization: "Bearer test-admin-token", "content-type": "application/json" };

function jwt(claims: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify(claims))}.sig`;
}

const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;
const expired = () => Math.floor(Date.now() / 1000) - 60;

async function admin(path: string, body?: unknown, method = "POST"): Promise<Response> {
  return SELF.fetch(`https://codexdata.test${path}`, {
    method,
    headers: ADMIN,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function seed(overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await admin("/admin/seed", {
    refresh_token: "refresh-v1",
    access_token: jwt({ exp: inOneHour() }),
    id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
    account_id: "acct-12345678-rest",
    ...overrides,
  });
  expect(res.status, await res.text()).toBe(200);
}

function catalogBody(models = [officialModel()]): string {
  return JSON.stringify({ models });
}

async function leaseAndIngest(
  body: string,
  etag = 'W/"v1"',
  status = 200,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const lease = (await (await admin("/admin/lease", { agent: "test" })).json()) as {
    ok: boolean;
    lease_id: string;
  };
  expect(lease.ok).toBe(true);
  return admin("/admin/ingest", {
    lease_id: lease.lease_id,
    client_version: "0.153.4",
    status,
    etag,
    body,
    ...extra,
  });
}

beforeEach(async () => {
  // 0.22 no longer isolates storage per test automatically: clear KV / DO storage and the outbound
  // script by hand.
  await reset();
  await mock.reset();
});

describe("admin auth", () => {
  it("rejects missing or wrong tokens without touching the coordinator", async () => {
    const none = await SELF.fetch("https://codexdata.test/admin/status");
    expect(none.status).toBe(401);
    const wrong = await SELF.fetch("https://codexdata.test/admin/status", {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const ok = await admin("/admin/status", undefined, "GET");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ seeded: false, sync_mode: "external" });
  });
});

describe("before any sync", () => {
  it("serves 503 not-synced and an unhealthy /healthz, never an empty list", async () => {
    const models = await SELF.fetch("https://codexdata.test/v1/codex/models.json");
    expect(models.status).toBe(503);
    expect(((await models.json()) as { error: { type: string } }).error.type).toBe(
      "catalog_not_synced",
    );
    const health = await SELF.fetch("https://codexdata.test/healthz");
    expect(health.status).toBe(503);
    const index = await SELF.fetch("https://codexdata.test/v1/index.json");
    expect(index.status).toBe(200);
    expect(((await index.json()) as { codex: unknown }).codex).toBeNull();
  });
});

describe("lease / ingest / serve", () => {
  it("publishes a valid catalog and serves it verbatim with ETag, cache headers and 304", async () => {
    await seed();
    const ingest = await leaseAndIngest(catalogBody());
    expect(ingest.status, await ingest.clone().text()).toBe(200);
    expect(await ingest.json()).toMatchObject({ status: "ok", model_count: 1, changes: 1 });

    const res = await SELF.fetch("https://codexdata.test/v1/codex/models.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('W/"v1"');
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-codexdata-client-version")).toBe("0.153.4");
    expect(res.headers.get("x-codexdata-source-plan")).toBe("pro");
    const body = (await res.json()) as { models: Array<Record<string, unknown>> };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]?.["slug"]).toBe("gpt-5.6-sol");
    expect(body.models[0]?.["base_instructions"]).toBe("You are Codex.");

    const conditional = await SELF.fetch("https://codexdata.test/v1/codex/models.json", {
      headers: { "if-none-match": 'W/"v1"' },
    });
    expect(conditional.status).toBe(304);

    const meta = (await (
      await SELF.fetch("https://codexdata.test/v1/codex/meta.json")
    ).json()) as CodexMeta;
    expect(meta.model_count).toBe(1);
    expect(meta.listed_slugs).toEqual(["gpt-5.6-sol"]);
    expect(meta.source).toMatchObject({ plan_label: "pro", account_fp: "acct-123", agent: "test" });
    expect(meta.last_run?.status).toBe("ok");

    const health = await SELF.fetch("https://codexdata.test/healthz");
    expect(health.status).toBe(200);
  });

  it("never publishes a malformed catalog and keeps the last good one", async () => {
    await seed();
    expect((await leaseAndIngest(catalogBody())).status).toBe(200);
    const before = await env.CODEXDATA_KV.get(KV_CURRENT);

    const broken = officialModel({ slug: "gpt-broken" });
    delete (broken as Record<string, unknown>)["shell_type"];
    const bad = await leaseAndIngest(catalogBody([officialModel(), broken]));
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ status: "error" });
    expect(await env.CODEXDATA_KV.get(KV_CURRENT)).toBe(before);

    const html = await leaseAndIngest("<html>login</html>", null as unknown as string, 403);
    expect(html.status).toBe(422);
    expect(await env.CODEXDATA_KV.get(KV_CURRENT)).toBe(before);
  });

  it("reports unchanged content, appends change events, and keeps snapshots", async () => {
    await seed();
    expect(await (await leaseAndIngest(catalogBody())).json()).toMatchObject({ status: "ok" });
    const again = await leaseAndIngest(
      JSON.stringify({ models: [officialModel()], reordered: true }),
    );
    expect(await again.json()).toMatchObject({ status: "unchanged" });

    const next = await leaseAndIngest(
      catalogBody([
        officialModel({ priority: 5 }),
        officialModel({ slug: "gpt-6-astra", priority: 1 }),
      ]),
      'W/"v2"',
    );
    expect(await next.json()).toMatchObject({ status: "ok", changes: 2 });

    const changes = (await (
      await SELF.fetch("https://codexdata.test/v1/codex/changes.json")
    ).json()) as Array<{
      kind: string;
      slug: string;
    }>;
    expect(changes.map((c) => `${c.kind}:${c.slug}`)).toEqual([
      "added:gpt-6-astra",
      "changed:gpt-5.6-sol",
      "added:gpt-5.6-sol",
    ]);
    const raw = await env.CODEXDATA_KV.get(KV_CHANGES);
    expect(raw).not.toBeNull();

    const index = (await (
      await SELF.fetch("https://codexdata.test/v1/codex/snapshots/index.json")
    ).json()) as Array<{
      hash: string;
    }>;
    expect(index).toHaveLength(2);
    const snapshot = await SELF.fetch(
      `https://codexdata.test/v1/codex/snapshots/${index[1]!.hash}.json`,
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("cache-control")).toContain("immutable");
    expect(((await snapshot.json()) as { models: unknown[] }).models).toHaveLength(1);
  });

  it("refuses a second lease while one is held and rejects ingest with a stale lease id", async () => {
    await seed();
    const first = await admin("/admin/lease", { agent: "a" });
    expect(first.status).toBe(200);
    const second = await admin("/admin/lease", { agent: "b" });
    expect(second.status).toBe(409);
    const bogus = await admin("/admin/ingest", {
      lease_id: "not-a-lease",
      client_version: "0.153.4",
      status: 200,
      etag: null,
      body: catalogBody(),
    });
    expect(bogus.status).toBe(422);
    const { lease_id } = (await first.json()) as { lease_id: string };
    expect(await (await admin("/admin/release", { lease_id, error: "boom" })).json()).toEqual({
      ok: true,
    });
    const third = await admin("/admin/lease", { agent: "c" });
    expect(third.status).toBe(200);
  });
});

describe("token refresh inside the coordinator", () => {
  it("refreshes only when the access token is expiring, persists the rotated refresh token before continuing", async () => {
    await seed({ access_token: jwt({ exp: expired() }) });
    // First lease: access token expired → refresh; the server returns the rotated refresh-v2 (and,
    // deliberately, an access token that is also expired).
    await mock.oauth(200, { access_token: jwt({ exp: expired() }), refresh_token: "refresh-v2" });
    const first = await admin("/admin/lease", { agent: "t1" });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await mock.oauthRefreshTokensSeen()).toEqual(["refresh-v1"]);
    const { lease_id } = (await first.json()) as { lease_id: string };
    await admin("/admin/release", { lease_id, error: "test" });

    // Second: access token still expired → refresh again, which must use refresh-v2 (proves the
    // rotation was persisted).
    await mock.oauth(200, { access_token: jwt({ exp: inOneHour() }) });
    const second = await admin("/admin/lease", { agent: "t2" });
    expect(second.status).toBe(200);
    expect(await mock.oauthRefreshTokensSeen()).toEqual(["refresh-v1", "refresh-v2"]);
    const lease2 = (await second.json()) as { lease_id: string };
    await admin("/admin/release", { lease_id: lease2.lease_id, error: "test" });

    // Third: access token has an hour left → no refresh (the scripted queue is empty, so any
    // outbound call would get 599).
    const third = await admin("/admin/lease", { agent: "t3" });
    expect(third.status).toBe(200);
    expect(await mock.oauthRefreshTokensSeen()).toHaveLength(2);
  });

  it("freezes on a permanent refresh failure and stays frozen without further network calls", async () => {
    await seed({ access_token: jwt({ exp: expired() }) });
    await mock.oauth(400, { error: { code: "refresh_token_reused" } });
    const res = await admin("/admin/lease", { agent: "t" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, permanent: true });

    const status = (await (await admin("/admin/status", undefined, "GET")).json()) as {
      permanent_failure: { reason: string } | null;
    };
    expect(status.permanent_failure?.reason).toContain("refresh_token_reused");

    // While frozen: no outbound calls, reject immediately.
    const again = await admin("/admin/lease", { agent: "t" });
    expect(again.status).toBe(503);
    expect((await mock.log()).filter((e) => e.url.includes("auth.openai.com"))).toHaveLength(1);
    expect((await SELF.fetch("https://codexdata.test/healthz")).status).toBe(503);

    // Re-seeding lifts the freeze.
    await seed();
    const after = await admin("/admin/lease", { agent: "t" });
    expect(after.status).toBe(200);
  });

  it("treats transient refresh errors as retryable (no freeze)", async () => {
    await seed({ access_token: jwt({ exp: expired() }) });
    await mock.oauth(503, { error: "temporarily unavailable" });
    const res = await admin("/admin/lease", { agent: "t" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, permanent: false });
    await mock.oauth(200, { access_token: jwt({ exp: inOneHour() }) });
    expect((await admin("/admin/lease", { agent: "t" })).status).toBe(200);
  });
});

describe("modes", () => {
  it("runSync is a no-op in external mode (cron does not fetch from the Worker)", async () => {
    await seed();
    const res = await admin("/admin/sync", {});
    expect(await res.json()).toMatchObject({ status: "skipped" });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "7 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.CODEXDATA_KV.get(KV_META)).toBeNull();
  });
});

describe("catalog signatures", () => {
  const VECTOR_KEY: TestSigningKey = SIGNING_VECTOR;
  const models = [officialModel()];
  const signed = (key: TestSigningKey = VECTOR_KEY) =>
    signCatalogText(key, canonicalCatalogText(models));
  const ingestSigned = (signature: string) =>
    leaseAndIngest(catalogBody(models), 'W/"v1"', 200, { signature });
  const served = () => SELF.fetch("https://codexdata.test/v1/codex/models.json");
  const current = () => env.CODEXDATA_KV.getWithMetadata<CatalogKvMetadata>(KV_CURRENT);
  const readMeta = async () =>
    JSON.parse((await env.CODEXDATA_KV.get(KV_META)) ?? "null") as CodexMeta | null;
  const hashOf = async () => (await readMeta())?.content_hash ?? "";

  /// Run `fn` with CATALOG_SIGNATURE_REQUIRED="true" in the coordinator, then restore its env.
  async function withSignatureRequired(fn: () => Promise<void>): Promise<void> {
    const stub = env.SYNC.getByName("primary");
    const original = await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as { env: Env };
      const before = target.env;
      target.env = { ...before, CATALOG_SIGNATURE_REQUIRED: "true" } as unknown as Env;
      return before;
    });
    try {
      await fn();
    } finally {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { env: Env }).env = original;
      });
    }
  }

  it("publishes a verified catalog and serves the signature with models.json, 304s and snapshots", async () => {
    await seed();
    const signature = await signed();
    const ingest = await ingestSigned(signature);
    expect(ingest.status, await ingest.clone().text()).toBe(200);
    expect(await ingest.json()).toMatchObject({ status: "ok" });

    const res = await served();
    expect(res.headers.get("x-codexdata-signature")).toBe(signature);
    expect(res.headers.get("access-control-expose-headers")).toContain("X-CodexData-Signature");
    // The header covers the exact served bytes.
    expect(
      await verifyCatalogSignature(await res.text(), signature, SIGNING_VECTOR.publicKey),
    ).toEqual({ ok: true, kid: SIGNING_VECTOR.kid });

    const conditional = await SELF.fetch("https://codexdata.test/v1/codex/models.json", {
      headers: { "if-none-match": 'W/"v1"' },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("x-codexdata-signature")).toBe(signature);
    const head = await SELF.fetch("https://codexdata.test/v1/codex/models.json", {
      method: "HEAD",
    });
    expect(head.headers.get("x-codexdata-signature")).toBe(signature);

    const meta = await readMeta();
    expect(meta?.signature_kid).toBe(SIGNING_VECTOR.kid);
    const status = (await (await admin("/admin/status", undefined, "GET")).json()) as {
      signature_kid: string | null;
    };
    expect(status.signature_kid).toBe(SIGNING_VECTOR.kid);

    const snapshot = await SELF.fetch(
      `https://codexdata.test/v1/codex/snapshots/${meta?.content_hash}.json`,
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("x-codexdata-signature")).toBe(signature);
    expect(snapshot.headers.get("cache-control")).toContain("immutable");
  });

  it("refuses a bad or malformed signature and leaves KV untouched", async () => {
    await seed();
    const signature = await signed();
    expect((await ingestSigned(signature)).status).toBe(200);
    const before = await current();
    const hash = await hashOf();

    const changed = [officialModel({ priority: 9 })];
    for (const [label, bad, reason] of [
      // A genuine signature, but over the previously published catalog.
      ["other catalog", signature, "signature: bad_signature"],
      ["malformed", "v1.not-a-signature", "signature: malformed"],
      ["non-string", 42, "signature: malformed"],
      ["empty", "", "signature: malformed"],
    ] as const) {
      const res = await leaseAndIngest(catalogBody(changed), 'W/"v2"', 200, { signature: bad });
      expect(res.status, label).toBe(422);
      expect(await res.json(), label).toMatchObject({ status: "error", reason });
      expect(await current(), label).toEqual(before);
      expect(await hashOf(), label).toBe(hash);
    }
    const refusedHash = await catalogHash(canonicalCatalogText(changed));
    expect(await env.CODEXDATA_KV.get(kvSnapshotKey(refusedHash))).toBeNull();
    const status = (await (await admin("/admin/status", undefined, "GET")).json()) as {
      recent_runs: Array<{ status: string; error: string | null }>;
    };
    expect(status.recent_runs[0]).toMatchObject({ status: "error", error: "signature: malformed" });
  });

  it("refuses a signature from a key that is not trusted", async () => {
    await seed();
    const untrusted = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", untrusted.publicKey)) as ArrayBuffer,
    );
    const res = await ingestSigned(
      await signWithCryptoKey(untrusted.privateKey, await keyId(raw), canonicalCatalogText(models)),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ status: "error", reason: "signature: unknown_kid" });
    expect((await current()).value).toBeNull();
    expect(await readMeta()).toBeNull();
  });

  it("publishes unsigned catalogs while signatures are not required, without a stale header", async () => {
    await seed();
    expect((await ingestSigned(await signed())).status).toBe(200);
    const next = [officialModel({ priority: 9 })];
    const res = await leaseAndIngest(catalogBody(next), 'W/"v2"');
    expect(await res.json()).toMatchObject({ status: "ok" });
    // A signature never outlives the body it covers.
    expect((await served()).headers.get("x-codexdata-signature")).toBeNull();
    expect((await current()).metadata).toBeNull();
    expect((await readMeta())?.signature_kid).toBeNull();
  });

  it("refuses unsigned catalogs once signatures are required", async () => {
    await seed();
    await withSignatureRequired(async () => {
      const unsigned = await leaseAndIngest(catalogBody());
      expect(unsigned.status).toBe(422);
      expect(await unsigned.json()).toMatchObject({
        status: "error",
        reason: "unsigned catalog refused",
      });
      expect((await current()).value).toBeNull();

      const signature = await signed();
      expect(await (await ingestSigned(signature)).json()).toMatchObject({ status: "ok" });
      expect((await served()).headers.get("x-codexdata-signature")).toBe(signature);
    });
  });

  it("attaches a signature to unchanged content and replaces it after key rotation", async () => {
    await seed();
    expect(await (await leaseAndIngest(catalogBody())).json()).toMatchObject({ status: "ok" });
    expect((await served()).headers.get("x-codexdata-signature")).toBeNull();
    const hash = await hashOf();

    const first = await signed();
    expect(await (await ingestSigned(first)).json()).toMatchObject({ status: "unchanged" });
    expect((await served()).headers.get("x-codexdata-signature")).toBe(first);
    expect((await readMeta())?.signature_kid).toBe(SIGNING_VECTOR.kid);
    const snapshot = await SELF.fetch(`https://codexdata.test/v1/codex/snapshots/${hash}.json`);
    expect(snapshot.headers.get("x-codexdata-signature")).toBe(first);

    const rotated = await signed(SECOND_TEST_KEY);
    expect(await (await ingestSigned(rotated)).json()).toMatchObject({ status: "unchanged" });
    expect((await served()).headers.get("x-codexdata-signature")).toBe(rotated);
    expect((await readMeta())?.signature_kid).toBe(SECOND_TEST_KEY.kid);
    expect((await readMeta())?.content_hash).toBe(hash);
  });

  it("keeps the stored signature when the same content arrives unsigned", async () => {
    await seed();
    const signature = await signed();
    expect((await ingestSigned(signature)).status).toBe(200);
    const unsigned = await leaseAndIngest(catalogBody(), 'W/"v1b"');
    expect(await unsigned.json()).toMatchObject({ status: "unchanged" });
    const res = await served();
    expect(res.headers.get("x-codexdata-signature")).toBe(signature);
    expect(res.headers.get("etag")).toBe('W/"v1b"');
    expect((await readMeta())?.signature_kid).toBe(SIGNING_VECTOR.kid);
  });
});
