#!/usr/bin/env node
// CodexData external sync agent (Node ≥ 20, zero dependencies).
//
// Purpose: Cloudflare Workers egress to chatgpt.com is blocked (403 HTML from the edge), so a machine
// that can reach it (GitHub Actions runner / any host) fetches the official catalog on the Worker's
// behalf and pushes it back to the Worker for publishing.
// Credential boundary: the agent only receives an access token valid for 10 minutes (leased by the
// Worker); the refresh token never leaves the Worker. The fetch result is pushed back verbatim;
// validation and publishing happen inside the Worker.
// Signing: with CATALOG_SIGNING_KEY set, the agent also signs the canonical catalog text
// (scripts/catalog-signature.mjs) and the Worker publishes only if the signature verifies against
// its trusted public keys. The key exists only in this job's environment; it is never logged.
//
// Environment variables:
//   CODEXDATA_ORIGIN       Worker origin (default https://data.cp.dev)
//   CODEXDATA_ADMIN_TOKEN  Bearer token for /admin/* (required)
//   CODEXDATA_AGENT        name of this agent (default: hostname or GITHUB_RUN_ID)
//   CATALOG_SIGNING_KEY    Ed25519 private key, PKCS#8 PEM (optional; unset = unsigned ingest)

import { canonicalCatalogText, loadSigningKey, signCatalog } from "./catalog-signature.mjs";

const origin = (process.env.CODEXDATA_ORIGIN ?? "https://data.cp.dev").replace(/\/+$/, "");
const adminToken = process.env.CODEXDATA_ADMIN_TOKEN ?? "";
const agent =
  process.env.CODEXDATA_AGENT ??
  (process.env.GITHUB_RUN_ID
    ? `github-actions#${process.env.GITHUB_RUN_ID}`
    : `host:${process.env.HOSTNAME ?? "unknown"}`);
const signingKey = process.env.CATALOG_SIGNING_KEY ?? "";

const NPM_LATEST = "https://registry.npmjs.org/@openai/codex/latest";
const OFFICIAL_CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";
const MAX_BODY = 8 * 1024 * 1024;

function log(event, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));
}

async function admin(path, body) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

async function withRetry(label, fn, attempts = 4) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      // Skips and permanent failures are not transient errors; retrying only wastes time.
      if (error?.skip || error?.permanent) throw error;
      lastError = error;
      log("retry", { label, attempt: i, error: String(error) });
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastError;
}

async function latestClientVersion(hint) {
  try {
    const res = await fetch(NPM_LATEST, { headers: { accept: "application/json" } });
    if (res.ok) {
      const { version } = await res.json();
      if (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) return version;
    }
  } catch (error) {
    log("npm_failed", { error: String(error) });
  }
  return hint;
}

/// Signature over the canonical text of a 2xx response, or null when there is nothing to sign
/// (unparsable body or no `models` array: the Worker rejects that catalog anyway).
function catalogSignature(status, body) {
  if (!signingKey || status < 200 || status >= 300) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) return null;
  return signCatalog(canonicalCatalogText(parsed.models), signingKey);
}

async function main() {
  if (!adminToken) throw new Error("CODEXDATA_ADMIN_TOKEN is required");
  if (signingKey) {
    // Fail before taking a lease: a configured but broken key must turn the run red, not silently
    // fall back to unsigned ingests.
    let kid;
    try {
      ({ kid } = loadSigningKey(signingKey));
    } catch (error) {
      log("signing_key_invalid", { error: error.message });
      process.exit(1);
    }
    log("signing", { kid });
  } else {
    log("unsigned", { reason: "CATALOG_SIGNING_KEY not set" });
  }

  const lease = await withRetry(
    "lease",
    async () => {
      const { status, json } = await admin("/admin/lease", { agent });
      if (status === 409 && typeof json.reason === "string" && json.reason.includes("not seeded")) {
        // Bootstrap not done yet: not a fault; exit quietly instead of turning the hourly workflow red.
        const err = new Error("not seeded yet — run scripts/seed.mjs (docs/RUNBOOK.md)");
        err.skip = true;
        throw err;
      }
      if (status === 409) throw new Error(`lease busy: ${json.reason}`);
      if (status === 503) {
        // Permanent failure (token invalidated, etc.): do not retry; a manual re-seed is needed.
        const err = new Error(`permanent: ${json.reason}`);
        err.permanent = true;
        throw err;
      }
      if (!json.ok)
        throw new Error(`lease failed (${status}): ${json.reason ?? JSON.stringify(json)}`);
      return json;
    },
    3,
  ).catch((error) => {
    if (error?.skip) {
      log("skipped", { reason: error.message });
      process.exit(0);
    }
    if (error?.permanent) {
      log("permanent_failure", { reason: error.message });
      process.exit(2);
    }
    throw error;
  });
  log("leased", {
    lease_id: lease.lease_id,
    expires_at: lease.expires_at,
    account_id_fp: (lease.account_id ?? "").slice(0, 8),
  });

  let ingestResult;
  try {
    const clientVersion = await latestClientVersion(lease.client_version_hint ?? "0.153.4");
    const headers = {
      authorization: `Bearer ${lease.access_token}`,
      originator: "codex-tui",
      "user-agent": `codex-tui/${clientVersion} (Linux 6.8.0; x86_64) (codex-tui; ${clientVersion})`,
      accept: "application/json",
    };
    if (lease.account_id) headers["chatgpt-account-id"] = lease.account_id;

    const res = await fetch(
      `${OFFICIAL_CATALOG_URL}?client_version=${encodeURIComponent(clientVersion)}`,
      {
        headers,
        redirect: "manual",
      },
    );
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY) throw new Error(`catalog too large: content-length ${declared}`);
    const body = await res.text();
    if (body.length > MAX_BODY) throw new Error(`catalog too large: ${body.length} bytes`);
    log("fetched", {
      status: res.status,
      bytes: body.length,
      etag: res.headers.get("etag"),
      client_version: clientVersion,
    });

    const signature = catalogSignature(res.status, body);
    if (signature) log("signed", { kid: signature.split(".")[1] });

    ingestResult = await withRetry("ingest", async () => {
      const { status, json } = await admin("/admin/ingest", {
        lease_id: lease.lease_id,
        client_version: clientVersion,
        status: res.status,
        etag: res.headers.get("etag"),
        body,
        ...(signature ? { signature } : {}),
      });
      if (status >= 500) throw new Error(`ingest ${status}: ${JSON.stringify(json).slice(0, 200)}`);
      return json;
    });
  } catch (error) {
    await admin("/admin/release", { lease_id: lease.lease_id, error: String(error) }).catch(
      () => {},
    );
    throw error;
  }

  log("ingested", ingestResult);
  if (ingestResult.status === "error") process.exit(1);
}

main().catch((error) => {
  log("failed", { error: String(error) });
  process.exit(1);
});
