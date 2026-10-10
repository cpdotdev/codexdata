import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadSigningKey, signCatalog } from "./catalog-signature.mjs";
import {
  DATASET_CONTEXTS,
  STATIC_FILES,
  checkStatic,
  headerRules,
  signData,
  signStatic,
  verifyData,
  wranglerVar,
} from "./data-signature.mjs";

// Shared data-signature test vector (TEST-ONLY key, seed = sha256("codexdata data signature test
// key v1")). The Worker tests (test/fixtures.ts) and the Codex Pass client
// (src-tauri/src/codexdata_signature.rs) assert the same values. Never trust this key in production.
export const DATA_VECTOR = {
  pem: [
    "-----BEGIN PRIVATE KEY-----",
    "MC4CAQAwBQYDK2VwBCIEIGp6v4X1J4lTIJg4sE/LPSk9XJipvbgoO2y4WOjWAMdF",
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n"),
  publicKey: "zxe3l2ZwZCtAnr2Q6TD29dlJK3kpeUzDWxwQuMfW6S8",
  kid: "c9797177296589d3",
  body: '{"dataset":"codexdata-signature-test","revision":1}',
  headers: {
    "quota-policy":
      "v1.c9797177296589d3.xmFvtLTeZckEmEuVW8mdyUvVkPvupb2gdvbFjlOrr54Naa18SCWpidqGsMqBTuqgwBx_J7qBZ8xVXI1lVPcGAg",
    features:
      "v1.c9797177296589d3.KmInGH3cAghCszmgDAXDW-SV3pSZRbS4Eud74dWNkSbJUvTuraXGp-BqV3ERrifmz1N7h5I-OXqJGCLvBYU2DQ",
    compat:
      "v1.c9797177296589d3.Yj6C2RaocwqUM-sHJ5hrL_AMSE2P0LaDuxBh6jZCi7LaFu3vDtJ0l7tr8qfWmqN0UKblz16xmoEO_NFHuJv2DQ",
    hooks:
      "v1.c9797177296589d3.mLssCZxFSsHeZMoTK5gCKihWj_OraMuEj-HNEPF0toD4e-RbB8SMNBnnromSbWu5mZIEed3_8iPQlfmrBMoMCg",
  },
};

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

test("signs the shared data vector exactly, one context string per dataset", () => {
  const key = loadSigningKey(DATA_VECTOR.pem);
  assert.equal(key.publicKey, DATA_VECTOR.publicKey);
  assert.equal(key.kid, DATA_VECTOR.kid);
  assert.deepEqual(Object.keys(DATA_VECTOR.headers).sort(), Object.keys(DATASET_CONTEXTS).sort());
  for (const [dataset, header] of Object.entries(DATA_VECTOR.headers)) {
    assert.equal(signData(dataset, DATA_VECTOR.body, DATA_VECTOR.pem), header, dataset);
    assert.equal(signData(dataset, Buffer.from(DATA_VECTOR.body), DATA_VECTOR.pem), header);
    assert.deepEqual(verifyData(dataset, DATA_VECTOR.body, header, DATA_VECTOR.publicKey), {
      ok: true,
      kid: DATA_VECTOR.kid,
    });
  }
  assert.deepEqual(DATASET_CONTEXTS, {
    "quota-policy": "codexdata-quota-policy-v1\n",
    features: "codexdata-features-v1\n",
    compat: "codexdata-compat-v1\n",
    hooks: "codexdata-hooks-v1\n",
  });
});

test("a signature never verifies for another dataset or as a catalog", () => {
  for (const [signedAs, header] of Object.entries(DATA_VECTOR.headers)) {
    for (const dataset of Object.keys(DATASET_CONTEXTS)) {
      if (dataset === signedAs) continue;
      assert.deepEqual(
        verifyData(dataset, DATA_VECTOR.body, header, DATA_VECTOR.publicKey),
        { ok: false, reason: "bad_signature" },
        `${signedAs} as ${dataset}`,
      );
    }
  }
  // The same key signing the same bytes as a catalog gives a different signature.
  const asCatalog = signCatalog(DATA_VECTOR.body, DATA_VECTOR.pem);
  for (const dataset of Object.keys(DATASET_CONTEXTS)) {
    assert.deepEqual(verifyData(dataset, DATA_VECTOR.body, asCatalog, DATA_VECTOR.publicKey), {
      ok: false,
      reason: "bad_signature",
    });
  }
  // No context string is a prefix of another (or of the catalog's).
  const contexts = [...Object.values(DATASET_CONTEXTS), "codexdata-catalog-v1\n"];
  for (const a of contexts) {
    for (const b of contexts) if (a !== b) assert(!b.startsWith(a), `${a} prefixes ${b}`);
  }
});

test("verifyData reports why a signature is refused", () => {
  const header = DATA_VECTOR.headers.compat;
  const check = (h, keys = DATA_VECTOR.publicKey, body = DATA_VECTOR.body) =>
    verifyData("compat", body, h, keys);
  const [, kid, sig] = header.split(".");
  for (const bad of [
    undefined,
    "",
    `v2.${kid}.${sig}`,
    `v1.${kid.toUpperCase()}.${sig}`,
    `v1.${kid}.${sig}==`,
    `v1.${kid}.${sig.replace(/-/g, "+").replace(/_/g, "/")}`,
    `v1.${kid}.${sig.slice(0, -1)}h`,
    `v1.${kid}.${sig.slice(0, 84)}`,
    ` ${header}`,
    `${header}.x`,
  ]) {
    assert.deepEqual(check(bad), { ok: false, reason: "malformed" }, String(bad));
  }
  assert.deepEqual(check(header, " , "), { ok: false, reason: "no_trusted_keys" });
  assert.deepEqual(check(header, `${DATA_VECTOR.publicKey},abc`), {
    ok: false,
    reason: "bad_public_key",
  });
  // The catalog test key is not the data test key.
  assert.deepEqual(check(header, "SuxU8H8gxEBdAdAX9_-DtBtEaVSNvwtwkak1JGCnl5s"), {
    ok: false,
    reason: "unknown_kid",
  });
  assert.deepEqual(check(header, undefined, DATA_VECTOR.body.replace("1", "2")), {
    ok: false,
    reason: "bad_signature",
  });
  assert.deepEqual(check(header, undefined, `${DATA_VECTOR.body}\n`), {
    ok: false,
    reason: "bad_signature",
  });
  assert.throws(() => signData("catalog", DATA_VECTOR.body, DATA_VECTOR.pem), /unknown dataset/);
});

test("static signatures round-trip through checkStatic and become exact-path _headers rules", () => {
  const signatures = signStatic(DATA_VECTOR.pem);
  assert.deepEqual(Object.keys(signatures).sort(), Object.keys(STATIC_FILES).sort());
  for (const [path, dataset] of Object.entries(STATIC_FILES)) {
    assert.equal(
      signatures[path],
      signData(dataset, readFileSync(join(publicDir, path)), DATA_VECTOR.pem),
    );
  }
  const rules = checkStatic(signatures, DATA_VECTOR.publicKey, true);
  assert.equal(rules, headerRules(signatures));
  for (const [path, header] of Object.entries(signatures)) {
    assert(rules.includes(`\n/${path}\n  X-CodexData-Signature: ${header}\n`), path);
  }
  // Cloudflare limits: 100 rules, 2,000 characters per line.
  const combined = readFileSync(join(publicDir, "_headers"), "utf8") + rules;
  assert(combined.split("\n").every((line) => line.length <= 2000));
  assert((combined.match(/^\//gm) ?? []).length <= 100);
});

test("checkStatic refuses tampered files, partial maps and required-but-unsigned deploys", () => {
  const dir = mkdtempSync(join(tmpdir(), "data-signature-"));
  try {
    cpSync(publicDir, dir, { recursive: true });
    const signatures = signStatic(DATA_VECTOR.pem, dir);
    assert.doesNotThrow(() => checkStatic(signatures, DATA_VECTOR.publicKey, true, dir));

    const quota = join(dir, "v1/quotas/codex/latest.json");
    writeFileSync(quota, readFileSync(quota, "utf8").replace('"revision"', '"revision" '));
    assert.throws(
      () => checkStatic(signatures, DATA_VECTOR.publicKey, true, dir),
      /quotas\/codex\/latest.json: signature bad_signature/,
    );

    const [first, ...rest] = Object.keys(STATIC_FILES);
    const partial = Object.fromEntries(rest.map((path) => [path, signatures[path]]));
    assert.throws(() => checkStatic(partial, DATA_VECTOR.publicKey, false), /cover exactly/);
    assert.throws(
      () =>
        checkStatic(
          { ...signatures, "v1/other.json": signatures[first] },
          DATA_VECTOR.publicKey,
          false,
        ),
      /cover exactly/,
    );
    // A signature for one static file does not pass for another one.
    const swapped = { ...signatures, [first]: signatures[rest[0]] };
    assert.throws(() => checkStatic(swapped, DATA_VECTOR.publicKey, false), /bad_signature/);
    assert.throws(() => checkStatic(signatures, "", false), /no_trusted_keys/);
    assert.throws(() => checkStatic([], DATA_VECTOR.publicKey, false), /JSON object/);

    assert.equal(checkStatic({}, DATA_VECTOR.publicKey, false), "");
    assert.throws(() => checkStatic({}, DATA_VECTOR.publicKey, true), /DATA_SIGNATURE_REQUIRED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrangler.jsonc: data keys are well-formed, never a test key, never a catalog key", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const parse = (name) =>
    wranglerVar(name, config)
      .split(/[\s,]+/)
      .filter(Boolean);
  const data = parse("DATA_SIGNING_PUBLIC_KEYS");
  const catalog = parse("CATALOG_SIGNING_PUBLIC_KEYS");
  const testKeys = [DATA_VECTOR.publicKey, "SuxU8H8gxEBdAdAX9_-DtBtEaVSNvwtwkak1JGCnl5s"];
  for (const key of data) {
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, `malformed public key ${key}`);
    assert.equal(Buffer.from(key, "base64url").toString("base64url"), key);
    assert(!testKeys.includes(key), `${key} is a test key`);
    assert(!catalog.includes(key), `${key} is also a catalog key; the datasets use their own key`);
  }
  const required = wranglerVar("DATA_SIGNATURE_REQUIRED", config);
  assert.match(required, /^(true|false)$/);
  if (data.length === 0) assert.equal(required, "false", "required without a trusted key");
});
