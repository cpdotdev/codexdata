// /v1/codex/* read paths: KV only, never outbound.

import {
  KV_CHANGES,
  KV_CURRENT,
  KV_META,
  KV_SNAPSHOTS_INDEX,
  kvSnapshotKey,
  type CodexMeta,
} from "../sync/coordinator";
import { CACHE_IMMUTABLE, CACHE_LIVE, errorResponse, jsonResponse } from "./headers";

const HASH_RE = /^[0-9a-f]{64}$/;

async function readMeta(env: Env): Promise<CodexMeta | null> {
  const text = await env.CODEXDATA_KV.get(KV_META, { cacheTtl: 300 });
  if (!text) return null;
  try {
    return JSON.parse(text) as CodexMeta;
  } catch {
    return null;
  }
}

function metaHeaders(meta: CodexMeta): Record<string, string> {
  const headers: Record<string, string> = {
    "x-codexdata-fetched-at": meta.fetched_at,
    "x-codexdata-client-version": meta.client_version,
    "x-codexdata-content-hash": meta.content_hash,
  };
  if (meta.source.plan_label) headers["x-codexdata-source-plan"] = meta.source.plan_label;
  return headers;
}

function notSynced(): Response {
  return errorResponse(503, "official catalog not synced yet", "catalog_not_synced");
}

export async function serveCodexModels(env: Env): Promise<Response> {
  const [meta, body] = await Promise.all([
    readMeta(env),
    env.CODEXDATA_KV.get(KV_CURRENT, { cacheTtl: 300 }),
  ]);
  if (!meta || !body) return notSynced();
  return jsonResponse(body, {
    cacheControl: CACHE_LIVE,
    etag: meta.etag,
    headers: metaHeaders(meta),
  });
}

export async function serveCodexMeta(env: Env): Promise<Response> {
  const meta = await readMeta(env);
  if (!meta) return notSynced();
  return jsonResponse(meta, {
    cacheControl: CACHE_LIVE,
    etag: `"meta-${meta.content_hash.slice(0, 16)}-${meta.checked_at}"`,
    headers: metaHeaders(meta),
  });
}

export async function serveSnapshotsIndex(env: Env): Promise<Response> {
  const text = await env.CODEXDATA_KV.get(KV_SNAPSHOTS_INDEX, { cacheTtl: 300 });
  return jsonResponse(text ?? "[]", { cacheControl: CACHE_LIVE });
}

export async function serveSnapshot(env: Env, hash: string): Promise<Response> {
  if (!HASH_RE.test(hash)) return errorResponse(404, "unknown snapshot", "not_found");
  const text = await env.CODEXDATA_KV.get(kvSnapshotKey(hash), { cacheTtl: 3600 });
  if (!text) return errorResponse(404, "unknown snapshot", "not_found");
  return jsonResponse(text, {
    cacheControl: CACHE_IMMUTABLE,
    etag: `"sha256-${hash.slice(0, 32)}"`,
  });
}

export async function serveChanges(env: Env): Promise<Response> {
  const text = await env.CODEXDATA_KV.get(KV_CHANGES, { cacheTtl: 300 });
  return jsonResponse(text ?? "[]", { cacheControl: CACHE_LIVE });
}

export async function serveIndex(env: Env, origin: string): Promise<Response> {
  const meta = await readMeta(env);
  return jsonResponse(
    {
      name: "CodexData",
      version: "v1",
      description:
        "Open datasets for the OpenAI Codex client: a live mirror of the official model catalog (snapshots + change feed), the ModelInfo JSON Schema, a per-tag feature-flag registry with community annotations, a hook product registry, and compatibility intelligence for Codex Pass. Not affiliated with OpenAI.",
      endpoints: {
        codex_quota_policy: `${origin}/v1/quotas/codex/latest.json`,
        codex_quota_policy_index: `${origin}/v1/quotas/codex/index.json`,
        codex_models: `${origin}/v1/codex/models.json`,
        codex_meta: `${origin}/v1/codex/meta.json`,
        codex_snapshots: `${origin}/v1/codex/snapshots/index.json`,
        codex_changes: `${origin}/v1/codex/changes.json`,
        codex_model_info_schema: `${origin}/v1/schema/codex-model-info/latest.json`,
        codex_model_info_schema_index: `${origin}/v1/schema/codex-model-info/index.json`,
        codex_hook_products: `${origin}/v1/hooks/codex/latest.json`,
        codex_hook_products_index: `${origin}/v1/hooks/codex/index.json`,
        codex_compat: `${origin}/v1/compat/codex/latest.json`,
        codex_feature_flags: `${origin}/v1/features/codex/latest.json`,
        codex_feature_flags_index: `${origin}/v1/features/codex/index.json`,
        health: `${origin}/healthz`,
      },
      codex: meta
        ? {
            fetched_at: meta.fetched_at,
            checked_at: meta.checked_at,
            client_version: meta.client_version,
            model_count: meta.model_count,
            content_hash: meta.content_hash,
          }
        : null,
      licenses: {
        codex_quota_policy: "CC-BY-4.0",
        code: "MIT",
        codex_hook_products: "CC-BY-4.0 (registry text); product marks retain their owners' rights",
        codex_compat: "CC-BY-4.0",
        codex_model_info_schema:
          "CC-BY-4.0; derived from openai/codex protocol sources (Apache-2.0, reproduced with LICENSE + NOTICE in the repository)",
        codex_feature_flags:
          "CC-BY-4.0 (registry + annotations); derived from openai/codex features sources (Apache-2.0, reproduced with LICENSE + NOTICE in the repository)",
        codex_catalog: "Served as-is from OpenAI; no license granted by CodexData.",
      },
    },
    { cacheControl: CACHE_LIVE },
  );
}

/// Health: a catalog exists and a run succeeded within the last 24h → 200; otherwise 503 (for
/// uptime monitoring + monitor.yml).
export async function serveHealth(env: Env, permanentFailure: boolean): Promise<Response> {
  const meta = await readMeta(env);
  const ageMs = meta ? Date.now() - Date.parse(meta.checked_at) : Number.POSITIVE_INFINITY;
  const healthy = !permanentFailure && meta !== null && ageMs < 24 * 60 * 60 * 1000;
  return jsonResponse(
    {
      ok: healthy,
      permanent_failure: permanentFailure,
      checked_at: meta?.checked_at ?? null,
      fetched_at: meta?.fetched_at ?? null,
      content_hash: meta?.content_hash ?? null,
      last_run: meta?.last_run ?? null,
    },
    { status: healthy ? 200 : 503 },
  );
}
