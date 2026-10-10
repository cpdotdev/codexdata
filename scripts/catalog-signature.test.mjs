import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  canonicalCatalogText,
  canonicalize,
  keyId,
  loadSigningKey,
  signCatalog,
} from "./catalog-signature.mjs";

// Shared format v1 test vector (TEST-ONLY key; the Worker tests and the Codex Pass client assert
// the same values). Never trust this key in production.
const VECTOR = {
  pem: [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEIKx18jWk+Beab5WVVUZkGRVr2ZyBHW76VEwg4OcGpOJp",
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n"),
  publicKey: "SuxU8H8gxEBdAdAX9_-DtBtEaVSNvwtwkak1JGCnl5s",
  kid: "e54ddc2b3b75b4a0",
  body: '{"models":[{"display_name":"Test","slug":"gpt-test","visibility":"list"}]}',
  header:
    "v1.e54ddc2b3b75b4a0.S1r4BO3ECX1-xSFTehh4l-y1PZuWH1ksKiBwR4pKUq0Y58zgUnxrGvJn0fxY_QPfyQtFnsCyxZkJ2EkCKPgHBQ",
};

test("signs the shared test vector exactly", () => {
  const body = canonicalCatalogText([
    { visibility: "list", slug: "gpt-test", display_name: "Test" },
  ]);
  assert.equal(body, VECTOR.body);
  assert.equal(signCatalog(body, VECTOR.pem), VECTOR.header);

  const key = loadSigningKey(VECTOR.pem);
  assert.equal(key.publicKey, VECTOR.publicKey);
  assert.equal(key.kid, VECTOR.kid);
  assert.equal(keyId(Buffer.from(VECTOR.publicKey, "base64url")), VECTOR.kid);

  // Independent check: the signature covers the context prefix plus the body, nothing else.
  const signature = Buffer.from(VECTOR.header.split(".")[2], "base64url");
  assert.equal(signature.length, 64);
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: VECTOR.publicKey },
    format: "jwk",
  });
  assert(verify(null, Buffer.from(`codexdata-catalog-v1\n${body}`), publicKey, signature));
  assert(!verify(null, Buffer.from(body), publicKey, signature));
});

test("canonical text ignores key order at every depth and keeps array order", () => {
  const a = {
    slug: "gpt-x",
    truncation_policy: { mode: "tokens", limit: 10 },
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "high", description: "Deep" },
    ],
  };
  const b = {
    supported_reasoning_levels: [
      { description: "Fast", effort: "low" },
      { description: "Deep", effort: "high" },
    ],
    truncation_policy: { limit: 10, mode: "tokens" },
    slug: "gpt-x",
  };
  assert.equal(canonicalCatalogText([a]), canonicalCatalogText([b]));
  assert.equal(
    signCatalog(canonicalCatalogText([a]), VECTOR.pem),
    signCatalog(canonicalCatalogText([b]), VECTOR.pem),
  );
  assert.equal(
    JSON.stringify(canonicalize({ z: [3, 1, 2], a: { d: null, c: true } })),
    '{"a":{"c":true,"d":null},"z":[3,1,2]}',
  );
  const swapped = { ...a, supported_reasoning_levels: [...a.supported_reasoning_levels].reverse() };
  assert.notEqual(canonicalCatalogText([a]), canonicalCatalogText([swapped]));
});

test("matches the Worker's canonical text on the client's bundled catalog", () => {
  // test/catalog.test.ts pins the same hash for src/sync/catalog.ts, so the two implementations
  // cannot drift apart without one of the suites failing.
  const bundled = JSON.parse(
    readFileSync(
      new URL("../data/codex-schema/sources/rust-v0.153.4/models.json", import.meta.url),
      "utf8",
    ),
  );
  const hash = createHash("sha256").update(canonicalCatalogText(bundled.models)).digest("hex");
  assert.equal(hash, "b35e6649dc23939f5f39fdd3341fb9bb362b3f0eec5f1115cce1d22521c580e3");
});

test("rejects unusable keys without echoing them", () => {
  const garbage =
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-key-material\n-----END PRIVATE KEY-----\n";
  assert.throws(
    () => signCatalog(VECTOR.body, garbage),
    (error) => !String(error.message).includes("not-a-real-key-material"),
  );
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  assert.throws(() => signCatalog(VECTOR.body, ec), /expected ed25519/);
});

test("wrangler.jsonc trusts only well-formed keys, never the test key", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const match = /"CATALOG_SIGNING_PUBLIC_KEYS":\s*"([^"]*)"/.exec(config);
  assert(match, "CATALOG_SIGNING_PUBLIC_KEYS is missing from wrangler.jsonc");
  for (const key of match[1].split(/[\s,]+/).filter(Boolean)) {
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, `malformed public key ${key}`);
    assert.equal(Buffer.from(key, "base64url").toString("base64url"), key);
    assert.notEqual(key, VECTOR.publicKey, "the test-vector key must never be trusted");
  }
  assert.match(config, /"CATALOG_SIGNATURE_REQUIRED":\s*"(true|false)"/);
});
