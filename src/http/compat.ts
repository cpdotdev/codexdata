// Read path for /v1/compat/codex/latest.json + publish path /admin/compat/publish.
// Data flow: the compat-watch GitHub Actions workflow probes new Codex versions, and its publish job
// signs the scripts/build-compat.mjs artifact and POSTs it to the publish endpoint → KV. The read
// path prefers KV and falls back to the static asset (the last build committed to git), so urgent
// compatibility intelligence ships without redeploying the Worker.
//
// Signing (docs/DATA-SIGNING.md): the publish request carries X-CodexData-Signature over the exact
// body (context "codexdata-compat-v1\n", key list DATA_SIGNING_PUBLIC_KEYS). The Worker stores those
// bytes verbatim, with the signature in the same KV record's metadata, and serves both together.
// The static fallback has no signature; clients treat it as unavailable.

import { Validator } from "@cfworker/json-schema";
import compatSchema from "../../data/codex-compat/compat.schema.json";
import { DATA_CONTEXTS, SIGNATURE_HEADER, verifySignature } from "../sync/signature";
import { CACHE_LIVE, CACHE_NONE, errorResponse, jsonResponse } from "./headers";

export const KV_COMPAT = "compat:codex:latest";
export const COMPAT_PATH = "/v1/compat/codex/latest.json";
const MAX_COMPAT_BYTES = 512 * 1024;

const validator = new Validator(compatSchema as object, "2020-12", false);

interface CompatKvMetadata {
  etag: string;
  published_at: string;
  /// X-CodexData-Signature over the stored body; absent on unsigned publishes.
  signature?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function serveCompat(env: Env, origin: string): Promise<Response> {
  const entry = await env.CODEXDATA_KV.getWithMetadata<CompatKvMetadata>(KV_COMPAT, {
    cacheTtl: 300,
  });
  if (entry.value) {
    const headers: Record<string, string> = {};
    if (entry.metadata?.published_at) {
      headers["x-codex-compat-published-at"] = entry.metadata.published_at;
    }
    if (entry.metadata?.signature) headers[SIGNATURE_HEADER] = entry.metadata.signature;
    return jsonResponse(entry.value, {
      cacheControl: CACHE_LIVE,
      ...(entry.metadata?.etag ? { etag: entry.metadata.etag } : {}),
      headers,
    });
  }
  // Nothing published to KV yet: fall back to the static artifact bundled at deploy time (matches
  // the git commit). It has no signature, so it must not enter the edge cache: a cached copy would
  // keep clients on an unsigned (refused) payload for an hour after the first signed publish.
  const asset = await env.ASSETS.fetch(new Request(`${origin}${COMPAT_PATH}`));
  const headers = new Headers(asset.headers);
  headers.set("cache-control", CACHE_NONE);
  return new Response(asset.body, { status: asset.status, headers });
}

/// `raw` is the request body as sent; it is stored byte for byte, because the signature covers
/// exactly these bytes.
export async function publishCompat(
  env: Env,
  raw: Uint8Array,
  signature: string | null,
): Promise<Response> {
  if (raw.byteLength > MAX_COMPAT_BYTES) {
    return errorResponse(413, "compat payload too large", "too_large");
  }
  let text: string;
  let body: unknown;
  try {
    // fatal: invalid UTF-8 is refused instead of replaced; ignoreBOM: keep a BOM so `text`
    // encodes back to exactly `raw`.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    body = JSON.parse(text);
  } catch {
    return errorResponse(400, "body must be UTF-8 JSON", "bad_request");
  }
  const result = validator.validate(body);
  if (!result.valid) {
    const first = result.errors[0];
    return errorResponse(
      422,
      `compat payload rejected: ${first ? `${first.instanceLocation} ${first.error}` : "schema"}`,
      "invalid_compat_payload",
    );
  }
  if (signature !== null) {
    const verdict = await verifySignature(
      DATA_CONTEXTS.compat,
      raw,
      signature,
      env.DATA_SIGNING_PUBLIC_KEYS,
    );
    if (!verdict.ok) {
      return errorResponse(422, `signature: ${verdict.reason}`, "invalid_compat_signature");
    }
  } else if (signatureRequired(env.DATA_SIGNATURE_REQUIRED)) {
    return errorResponse(422, "unsigned compat payload refused", "invalid_compat_signature");
  }
  const metadata: CompatKvMetadata = {
    // Covers the signature too: the same body signed again (key rotation) gets a new ETag, so
    // clients holding the old ETag download it instead of keeping the old signature on a 304.
    etag: `"compat-${(await sha256Hex(`${text}\n${signature ?? ""}`)).slice(0, 16)}"`,
    published_at: new Date().toISOString(),
    ...(signature !== null ? { signature } : {}),
  };
  await env.CODEXDATA_KV.put(KV_COMPAT, text, { metadata });
  return jsonResponse({
    ok: true,
    etag: metadata.etag,
    published_at: metadata.published_at,
    signed: signature !== null,
  });
}

function signatureRequired(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() === "true";
}
