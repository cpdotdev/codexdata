#!/usr/bin/env node
// Catalog signing for the sync agent (Node ≥ 20, zero dependencies: node:crypto only).
//
// Format v1, shared with the Worker (src/sync/signature.ts) and the Codex Pass client:
//   - signed bytes: UTF-8 of "codexdata-catalog-v1\n" + body, where body is the exact response body
//     of /v1/codex/models.json (the canonical catalog text below);
//   - pure Ed25519 (RFC 8032, deterministic);
//   - kid: first 16 lowercase hex characters of SHA-256(raw 32-byte public key);
//   - header value: v1.<kid>.<base64url signature, no padding>.
// The private key is a PKCS#8 PEM that lives only in the GitHub environment `catalog-signing`
// (docs/RUNBOOK.md#catalog-signing). Nothing here logs or returns key material.
//
// CLI (prints the public key and kid for wrangler.jsonc and the client; reads the PEM from stdin):
//   node scripts/catalog-signature.mjs public-key < catalog-signing.pem

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SIGNATURE_HEADER = "x-codexdata-signature";
const SIGNATURE_CONTEXT = "codexdata-catalog-v1\n";

/// Identical to canonicalize() in src/sync/catalog.ts: sort object keys (recursively), keep array
/// order. The Worker verifies against its own canonical text, so the two must never diverge.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/// Identical to canonicalCatalogText() in src/sync/catalog.ts (the served models.json body).
export function canonicalCatalogText(models) {
  return JSON.stringify(canonicalize({ models }));
}

/// Parse a PKCS#8 PEM Ed25519 private key. Throws without echoing the input.
export function loadSigningKey(pkcs8Pem) {
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: pkcs8Pem, format: "pem" });
  } catch (error) {
    // The OpenSSL message names the decoder step, never the key, but keep only the code anyway.
    throw new Error(`signing key is not a PKCS#8 PEM private key (${error?.code ?? "unparsable"})`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`signing key is ${privateKey.asymmetricKeyType}, expected ed25519`);
  }
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" }).x;
  return { privateKey, publicKey, kid: keyId(Buffer.from(publicKey, "base64url")) };
}

/// First 16 lowercase hex characters of SHA-256(raw 32-byte public key).
export function keyId(rawPublicKey) {
  return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

/// Sign the canonical catalog text; returns the `x-codexdata-signature` header value.
export function signCatalog(canonicalText, pkcs8Pem) {
  const { privateKey, kid } = loadSigningKey(pkcs8Pem);
  const signature = sign(null, Buffer.from(SIGNATURE_CONTEXT + canonicalText, "utf8"), privateKey);
  return `v1.${kid}.${signature.toString("base64url")}`;
}

function main() {
  const [command] = process.argv.slice(2);
  if (command !== "public-key") {
    console.error("usage: node scripts/catalog-signature.mjs public-key < catalog-signing.pem");
    process.exit(2);
  }
  try {
    const { publicKey, kid } = loadSigningKey(readFileSync(0, "utf8"));
    console.log(JSON.stringify({ public_key: publicKey, kid }));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
