#!/usr/bin/env node
// Signatures for the datasets other than the catalog (Node ≥ 20, zero dependencies: node:crypto
// only, so the signing jobs never run `pnpm install`). Design: docs/DATA-SIGNING.md.
//
// Format: catalog format v1 (scripts/catalog-signature.mjs) with one context string per dataset:
//   - signed bytes: UTF-8 context string + the exact response body (raw file bytes);
//   - pure Ed25519; kid = first 16 lowercase hex characters of SHA-256(raw public key);
//   - header value: v1.<kid>.<base64url signature, no padding>.
// The Worker (src/sync/signature.ts) and the Codex Pass client use the same context strings.
// The private key is a PKCS#8 PEM in the GitHub environment `data-signing` (DATA_SIGNING_KEY,
// docs/RUNBOOK.md#data-signing). Nothing here logs or returns key material.
//
// CLI:
//   node scripts/data-signature.mjs public-key < key.pem     print {public_key, kid}
//   node scripts/data-signature.mjs sign-static              DATA_SIGNING_KEY in the environment;
//                                                            print {path: header} for STATIC_FILES
//   node scripts/data-signature.mjs apply-static '<json>'    verify the map against public/ and
//                                                            DATA_SIGNING_PUBLIC_KEYS, then append
//                                                            the header rules to public/_headers
//   node scripts/data-signature.mjs sign <dataset> <file>    print the header for one file

import { createPublicKey, sign, verify } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { keyId, loadSigningKey } from "./catalog-signature.mjs";

export const SIGNATURE_HEADER = "x-codexdata-signature";

/// Context string per dataset. Never reuse one, and never change one without a new version
/// (the client compares them byte for byte).
export const DATASET_CONTEXTS = Object.freeze({
  "quota-policy": "codexdata-quota-policy-v1\n",
  features: "codexdata-features-v1\n",
  compat: "codexdata-compat-v1\n",
  hooks: "codexdata-hooks-v1\n",
});

/// Static files signed at deploy time (path under public/ → dataset). The compat payload is
/// signed by the compat-watch publish job instead (it is served from KV by the Worker).
export const STATIC_FILES = Object.freeze({
  "v1/quotas/codex/latest.json": "quota-policy",
  "v1/features/codex/latest.json": "features",
  "v1/hooks/codex/latest.json": "hooks",
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KID_RE = /^[0-9a-f]{16}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function context(dataset) {
  const value = DATASET_CONTEXTS[dataset];
  if (!value) throw new Error(`unknown dataset: ${dataset}`);
  return Buffer.from(value, "utf8");
}

/// Sign `body` (Buffer or string) for `dataset`; returns the `x-codexdata-signature` header value.
export function signData(dataset, body, pkcs8Pem) {
  const { privateKey, kid } = loadSigningKey(pkcs8Pem);
  const message = Buffer.concat([context(dataset), Buffer.from(body)]);
  return `v1.${kid}.${sign(null, message, privateKey).toString("base64url")}`;
}

/// Canonical unpadded base64url → Buffer, else null.
function decodeBase64Url(text) {
  if (typeof text !== "string" || !BASE64URL_RE.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

/// Verify `header` over `body` for `dataset` with the comma/whitespace-separated key list. Same
/// strictness and reasons as verifyCatalogSignature() in src/sync/signature.ts; one malformed key
/// fails the whole list.
export function verifyData(dataset, body, header, publicKeys) {
  const parts = typeof header === "string" ? header.split(".") : [];
  const signature = parts.length === 3 ? decodeBase64Url(parts[2]) : null;
  if (parts[0] !== "v1" || !KID_RE.test(parts[1] ?? "") || signature?.length !== 64) {
    return { ok: false, reason: "malformed" };
  }
  const entries = (publicKeys ?? "").split(/[\s,]+/).filter((entry) => entry.length > 0);
  if (entries.length === 0) return { ok: false, reason: "no_trusted_keys" };
  let match = null;
  for (const entry of entries) {
    const raw = decodeBase64Url(entry);
    if (!raw || raw.length !== 32) return { ok: false, reason: "bad_public_key" };
    if (keyId(raw) === parts[1]) match = entry;
  }
  if (!match) return { ok: false, reason: "unknown_kid" };
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: match },
    format: "jwk",
  });
  const message = Buffer.concat([context(dataset), Buffer.from(body)]);
  return verify(null, message, publicKey, signature)
    ? { ok: true, kid: parts[1] }
    : { ok: false, reason: "bad_signature" };
}

/// `_headers` rules (exact paths) attaching each signature to its static file.
export function headerRules(signatures) {
  return Object.entries(signatures)
    .map(([path, header]) => `\n/${path}\n  X-CodexData-Signature: ${header}\n`)
    .join("");
}

/// A string var from wrangler.jsonc, read without a JSONC parser dependency.
export function wranglerVar(name, text = readFileSync(join(root, "wrangler.jsonc"), "utf8")) {
  const m = text.match(new RegExp(`"${name}":\\s*"([^"]*)"`));
  if (!m) throw new Error(`${name} not found in wrangler.jsonc`);
  return m[1];
}

/// Sign every STATIC_FILES entry under `publicDir`.
export function signStatic(pkcs8Pem, publicDir = join(root, "public")) {
  const out = {};
  for (const [path, dataset] of Object.entries(STATIC_FILES)) {
    out[path] = signData(dataset, readFileSync(join(publicDir, path)), pkcs8Pem);
  }
  return out;
}

/// Check a {path: header} map from the sign job against this checkout and return the rules to
/// append. An empty map is allowed only while signatures are not required. Throws on any problem.
export function checkStatic(signatures, publicKeys, required, publicDir = join(root, "public")) {
  if (!signatures || typeof signatures !== "object" || Array.isArray(signatures)) {
    throw new Error("signatures must be a JSON object");
  }
  const paths = Object.keys(signatures);
  if (paths.length === 0) {
    if (required) throw new Error("no signatures, and DATA_SIGNATURE_REQUIRED is true");
    return "";
  }
  const expected = Object.keys(STATIC_FILES);
  if (paths.length !== expected.length || !expected.every((path) => paths.includes(path))) {
    throw new Error(`signatures must cover exactly: ${expected.join(", ")}`);
  }
  for (const path of expected) {
    const verdict = verifyData(
      STATIC_FILES[path],
      readFileSync(join(publicDir, path)),
      signatures[path],
      publicKeys,
    );
    if (!verdict.ok) throw new Error(`${path}: signature ${verdict.reason}`);
  }
  return headerRules(Object.fromEntries(expected.map((path) => [path, signatures[path]])));
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case "public-key": {
        const { publicKey, kid } = loadSigningKey(readFileSync(0, "utf8"));
        console.log(JSON.stringify({ public_key: publicKey, kid }));
        return;
      }
      case "sign-static": {
        const pem = process.env.DATA_SIGNING_KEY ?? "";
        if (!pem) {
          console.error("unsigned: DATA_SIGNING_KEY is not set");
          console.log("{}");
          return;
        }
        const signatures = signStatic(pem);
        console.error(
          `signed ${Object.keys(signatures).length} files, kid ${loadSigningKey(pem).kid}`,
        );
        console.log(JSON.stringify(signatures));
        return;
      }
      case "apply-static": {
        const required = wranglerVar("DATA_SIGNATURE_REQUIRED").trim() === "true";
        const rules = checkStatic(
          JSON.parse(args[0] ?? ""),
          wranglerVar("DATA_SIGNING_PUBLIC_KEYS"),
          required,
        );
        if (!rules) {
          console.error("unsigned deploy: no signatures (DATA_SIGNATURE_REQUIRED is not true)");
          return;
        }
        appendFileSync(join(root, "public", "_headers"), rules);
        console.error(
          `added ${Object.keys(STATIC_FILES).length} signature rules to public/_headers`,
        );
        return;
      }
      case "sign": {
        const [dataset, file] = args;
        const pem = process.env.DATA_SIGNING_KEY ?? "";
        if (!pem) throw new Error("DATA_SIGNING_KEY is not set");
        console.log(signData(dataset, readFileSync(file), pem));
        return;
      }
      default:
        console.error(
          "usage: node scripts/data-signature.mjs public-key < key.pem | sign-static | apply-static '<json>' | sign <dataset> <file>",
        );
        process.exit(2);
    }
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
