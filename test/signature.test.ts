import { describe, expect, it } from "vitest";
import { canonicalCatalogText, type CatalogModel } from "../src/sync/catalog";
import {
  DATA_CONTEXTS,
  keyId,
  parseSignatureHeader,
  verifyCatalogSignature,
  verifySignature,
} from "../src/sync/signature";
import {
  DATA_SIGNING_VECTOR,
  SIGNING_VECTOR as VECTOR,
  SECOND_TEST_KEY,
  signData,
} from "./fixtures";

describe("format v1 test vector", () => {
  it("verifies the shared vector against the Worker's canonical text", async () => {
    const models = [
      { visibility: "list", slug: "gpt-test", display_name: "Test" },
    ] as CatalogModel[];
    expect(canonicalCatalogText(models)).toBe(VECTOR.body);
    expect(await verifyCatalogSignature(VECTOR.body, VECTOR.header, VECTOR.publicKey)).toEqual({
      ok: true,
      kid: VECTOR.kid,
    });
    const raw = Uint8Array.from(atob(VECTOR.publicKeyBase64), (c) => c.charCodeAt(0));
    expect(await keyId(raw)).toBe(VECTOR.kid);
  });
});

describe("parseSignatureHeader", () => {
  it("accepts only the strict v1 shape", () => {
    expect(parseSignatureHeader(VECTOR.header)?.kid).toBe(VECTOR.kid);
    expect(parseSignatureHeader(VECTOR.header)?.signature.byteLength).toBe(64);
    const [, kid, sig] = VECTOR.header.split(".") as [string, string, string];
    for (const [label, value] of [
      ["empty", ""],
      ["version", `v2.${kid}.${sig}`],
      ["two parts", `v1.${sig}`],
      ["four parts", `v1.${kid}.${sig}.x`],
      ["uppercase kid", `v1.${kid.toUpperCase()}.${sig}`],
      ["short kid", `v1.${kid.slice(1)}.${sig}`],
      ["padding", `v1.${kid}.${sig}==`],
      ["standard alphabet", `v1.${kid}.${sig.replace(/-/g, "+").replace(/_/g, "/")}`],
      ["63 bytes", `v1.${kid}.${sig.slice(0, 84)}`],
      ["non-canonical tail", `v1.${kid}.${sig.slice(0, -1)}R`],
      ["whitespace", ` ${VECTOR.header}`],
    ] as const) {
      expect(parseSignatureHeader(value), label).toBeNull();
    }
  });
});

describe("verifyCatalogSignature", () => {
  it("reports why a signature is refused", async () => {
    const verify = (header: string, keys: string, body: string = VECTOR.body) =>
      verifyCatalogSignature(body, header, keys);
    expect(await verify("v1.nope", VECTOR.publicKey)).toEqual({ ok: false, reason: "malformed" });
    expect(await verify(VECTOR.header, "")).toEqual({ ok: false, reason: "no_trusted_keys" });
    expect(await verify(VECTOR.header, " ,\n ")).toEqual({ ok: false, reason: "no_trusted_keys" });
    expect(await verify(VECTOR.header, SECOND_TEST_KEY.publicKey)).toEqual({
      ok: false,
      reason: "unknown_kid",
    });
    // One malformed entry poisons the whole list (fail closed on a configuration error).
    for (const bad of ["abc", `${VECTOR.publicKey}A`, VECTOR.publicKeyBase64]) {
      expect(await verify(VECTOR.header, `${VECTOR.publicKey},${bad}`), bad).toEqual({
        ok: false,
        reason: "bad_public_key",
      });
    }
    const tampered = VECTOR.body.replace('"Test"', '"Tost"');
    expect(await verify(VECTOR.header, VECTOR.publicKey, tampered)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    // The verifier adds the context prefix itself; an already-prefixed text does not verify.
    expect(
      await verify(VECTOR.header, VECTOR.publicKey, `codexdata-catalog-v1\n${VECTOR.body}`),
    ).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("accepts any listed key, separated by commas and/or whitespace", async () => {
    for (const keys of [
      `${SECOND_TEST_KEY.publicKey},${VECTOR.publicKey}`,
      `${SECOND_TEST_KEY.publicKey} ${VECTOR.publicKey}`,
      ` ${VECTOR.publicKey} ,\n\t${SECOND_TEST_KEY.publicKey}, `,
    ]) {
      expect(await verifyCatalogSignature(VECTOR.body, VECTOR.header, keys)).toEqual({
        ok: true,
        kid: VECTOR.kid,
      });
    }
  });
});

describe("data signatures (docs/DATA-SIGNING.md)", () => {
  it("verifies the shared data vector, one context per dataset", async () => {
    const D = DATA_SIGNING_VECTOR;
    expect(Object.keys(D.headers).sort()).toEqual(Object.keys(DATA_CONTEXTS).sort());
    for (const [dataset, context] of Object.entries(DATA_CONTEXTS)) {
      const header = D.headers[dataset as keyof typeof D.headers];
      expect(await verifySignature(context, D.body, header, D.publicKey), dataset).toEqual({
        ok: true,
        kid: D.kid,
      });
      // Bytes and string give the same verdict; WebCrypto signing matches the shared vector.
      const bytes = new TextEncoder().encode(D.body);
      expect(await verifySignature(context, bytes, header, D.publicKey)).toMatchObject({
        ok: true,
      });
      expect(await signData(D, context, bytes)).toBe(header);
      for (const [other, otherContext] of Object.entries(DATA_CONTEXTS)) {
        if (other === dataset) continue;
        expect(
          await verifySignature(otherContext, D.body, header, D.publicKey),
          `${dataset} as ${other}`,
        ).toEqual({ ok: false, reason: "bad_signature" });
      }
      // A data signature is never a catalog signature, and the catalog key is not the data key.
      expect(await verifyCatalogSignature(D.body, header, D.publicKey)).toEqual({
        ok: false,
        reason: "bad_signature",
      });
      expect(await verifySignature(context, D.body, header, VECTOR.publicKey)).toEqual({
        ok: false,
        reason: "unknown_kid",
      });
    }
    expect(DATA_CONTEXTS).toEqual({
      quotaPolicy: "codexdata-quota-policy-v1\n",
      features: "codexdata-features-v1\n",
      compat: "codexdata-compat-v1\n",
      hooks: "codexdata-hooks-v1\n",
    });
  });

  it("a catalog signature does not verify as any dataset", async () => {
    for (const context of Object.values(DATA_CONTEXTS)) {
      expect(await verifySignature(context, VECTOR.body, VECTOR.header, VECTOR.publicKey)).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });
});
