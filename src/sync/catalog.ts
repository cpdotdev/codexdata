// The official Codex catalog: fetch, validate, canonicalize, diff.
//
// Codex deserialization facts (openai/codex protocol/src/openai_models.rs, rust-v0.148.0 … 0.153.4):
//   - The top level must have a `models` array; unknown top-level keys are ignored.
//   - Each entry requires: slug, display_name, supported_reasoning_levels, shell_type, visibility,
//     supported_in_api, priority, support_verbosity, truncation_policy,
//     experimental_supported_tools, plus either base_instructions or
//     model_messages.instructions_template; a misspelling in any closed enum (shell_type /
//     visibility / apply_patch_tool_type / web_search_tool_type / truncation.mode /
//     input_modalities / default_reasoning_summary / default_verbosity) rejects the whole document.
//   - **One bad entry rejects the whole catalog**, and the client treats that as a failed fetch.
//     So the mirror never publishes a catalog that fails validation.
//
// These rules are maintained as a JSON Schema in data/codex-schema/codex-model-info.schema.json
// (the same file is published at /v1/schema/codex-model-info/*); this module only adds the mirror's
// own two constraints: non-empty, unique slugs.

import { Validator, type Schema } from "@cfworker/json-schema";
import modelInfoSchema from "../../data/codex-schema/codex-model-info.schema.json";
import { sha256Hex } from "./crypto";

export const OFFICIAL_CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";
/// The official catalog embeds full system prompts, tens of KB per entry; 8 MiB is ample for a
/// legitimate catalog.
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export type CatalogModel = Record<string, unknown> & { slug: string };

export interface FetchedCatalog {
  status: number;
  etag: string | null;
  text: string;
}

export async function fetchOfficialCatalog(
  input: {
    accessToken: string;
    accountId: string | null;
    clientVersion: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedCatalog> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.accessToken}`,
    originator: "codex-tui",
    // Same shape as scripts/sync-agent.mjs: no identifier of our own (leaves OpenAI no product
    // fingerprint).
    "user-agent": `codex-tui/${input.clientVersion} (Linux 6.8.0; x86_64) (codex-tui; ${input.clientVersion})`,
    accept: "application/json",
  };
  if (input.accountId) headers["chatgpt-account-id"] = input.accountId;

  const url = `${OFFICIAL_CATALOG_URL}?client_version=${encodeURIComponent(input.clientVersion)}`;
  const response = await fetchImpl(url, { headers, redirect: "manual" });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    throw new Error(`catalog response too large (content-length ${declared})`);
  }
  const text = await readBounded(response, MAX_CATALOG_BYTES);
  return { status: response.status, etag: response.headers.get("etag"), text };
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`catalog response too large (> ${limit} bytes)`);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/// Same rejection rules as the Codex client (see the file header). `shortCircuit=false` collects
/// every error so the most specific one can be picked.
const modelInfoValidator = new Validator(modelInfoSchema as Schema, "2020-12", false);

export type ValidationResult = { ok: true; models: CatalogModel[] } | { ok: false; error: string };

export function validateCatalog(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON: ${String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "top level is not an object" };
  }
  const models = (parsed as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return { ok: false, error: "missing `models` array" };
  if (models.length === 0) return { ok: false, error: "`models` is empty" };

  const verdict = modelInfoValidator.validate(parsed);
  if (!verdict.valid) {
    return { ok: false, error: `schema: ${describeSchemaErrors(verdict.errors)}` };
  }

  const seen = new Set<string>();
  for (const [index, entry] of models.entries()) {
    const slug = (entry as Record<string, unknown>)["slug"];
    if (typeof slug !== "string" || slug.trim().length === 0) {
      return { ok: false, error: `models[${index}].slug is not a non-empty string` };
    }
    if (seen.has(slug)) return { ok: false, error: `duplicate slug \`${slug}\`` };
    seen.add(slug);
  }
  return { ok: true, models: models as CatalogModel[] };
}

/// The validator output is a top-down chain (parent anyOf/allOf errors included); the deepest
/// instanceLocation is the one a human can read. Take the three deepest, deduplicated.
function describeSchemaErrors(
  errors: readonly { instanceLocation: string; error: string }[],
): string {
  const ranked = [...errors].sort(
    (a, b) => b.instanceLocation.split("/").length - a.instanceLocation.split("/").length,
  );
  const lines: string[] = [];
  for (const item of ranked) {
    const line = `${item.instanceLocation || "#"}: ${item.error}`;
    if (!lines.includes(line)) lines.push(line);
    if (lines.length === 3) break;
  }
  return lines.join("; ");
}

/// Canonicalize: sort object keys (recursively), keep array order. The same catalog hashes
/// identically regardless of upstream key order.
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalCatalogText(models: CatalogModel[]): string {
  return JSON.stringify(canonicalize({ models }));
}

export async function catalogHash(canonicalText: string): Promise<string> {
  return sha256Hex(canonicalText);
}

export interface ChangeEvent {
  seq: number;
  at: string;
  kind: "added" | "removed" | "changed";
  slug: string;
  fields_changed: string[];
  from_hash: string | null;
  to_hash: string;
  client_version: string;
}

/// Diff two catalogs by slug and produce change events (field-level diff looks at top-level keys
/// only).
export function diffCatalogs(
  previous: CatalogModel[] | null,
  next: CatalogModel[],
  meta: {
    at: string;
    fromHash: string | null;
    toHash: string;
    clientVersion: string;
    seqStart: number;
  },
): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  let seq = meta.seqStart;
  const base = {
    at: meta.at,
    from_hash: meta.fromHash,
    to_hash: meta.toHash,
    client_version: meta.clientVersion,
  };
  const prevBySlug = new Map((previous ?? []).map((m) => [m.slug, m]));
  const nextBySlug = new Map(next.map((m) => [m.slug, m]));

  for (const [slug, model] of nextBySlug) {
    const before = prevBySlug.get(slug);
    if (!before) {
      events.push({ seq: seq++, kind: "added", slug, fields_changed: [], ...base });
      continue;
    }
    const changed = topLevelFieldDiff(before, model);
    if (changed.length > 0) {
      events.push({ seq: seq++, kind: "changed", slug, fields_changed: changed, ...base });
    }
  }
  for (const slug of prevBySlug.keys()) {
    if (!nextBySlug.has(slug)) {
      events.push({ seq: seq++, kind: "removed", slug, fields_changed: [], ...base });
    }
  }
  return events;
}

function topLevelFieldDiff(a: CatalogModel, b: CatalogModel): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) {
    if (JSON.stringify(canonicalize(a[key])) !== JSON.stringify(canonicalize(b[key]))) {
      changed.push(key);
    }
  }
  return changed;
}
