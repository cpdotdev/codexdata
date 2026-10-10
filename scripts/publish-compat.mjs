#!/usr/bin/env node
// POST public/v1/compat/codex/latest.json to the Worker's /admin/compat/publish (KV hot update, no
// redeploy needed). Called by the compat-watch publish job; can also be run manually.
// With DATA_SIGNING_KEY set, the exact file bytes are signed (scripts/data-signature.mjs, dataset
// "compat") and the signature goes in the X-CodexData-Signature request header; the Worker
// verifies it, stores the bytes verbatim and serves the signature with them.
// Environment: CODEXDATA_ORIGIN (default https://data.cp.dev), CODEXDATA_ADMIN_TOKEN (required),
//              DATA_SIGNING_KEY (Ed25519 PKCS#8 PEM; optional, unset = unsigned publish).
// Zero dependencies: the publish job does not run `pnpm install`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSigningKey } from "./catalog-signature.mjs";
import { SIGNATURE_HEADER, signData } from "./data-signature.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.env.CODEXDATA_ORIGIN ?? "https://data.cp.dev";
const token = process.env.CODEXDATA_ADMIN_TOKEN;
const signingKey = process.env.DATA_SIGNING_KEY ?? "";
if (!token) {
  console.error("CODEXDATA_ADMIN_TOKEN is required");
  process.exit(1);
}

const payload = readFileSync(join(root, "public", "v1", "compat", "codex", "latest.json"));
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
if (signingKey) {
  try {
    headers[SIGNATURE_HEADER] = signData("compat", payload, signingKey);
    console.log(`signed, kid ${loadSigningKey(signingKey).kid}`);
  } catch (error) {
    // A key that is set but unusable must not fall back to an unsigned publish.
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
} else {
  console.log("unsigned: DATA_SIGNING_KEY is not set");
}
const response = await fetch(`${origin}/admin/compat/publish`, {
  method: "POST",
  headers,
  body: payload,
});
const body = await response.text();
console.log(`POST /admin/compat/publish -> HTTP ${response.status}`);
console.log(body.slice(0, 500));
if (!response.ok) process.exit(1);
