// /admin/*: bootstrap, manual sync, and lease/ingest/release for the external agent.
// Bearer ADMIN_TOKEN, compared in constant time.

import { timingSafeEqualString } from "../sync/crypto";
import type { IngestInput, SeedInput } from "../sync/coordinator";
import { publishCompat } from "./compat";
import { errorResponse, jsonResponse } from "./headers";

const MAX_SEED_BODY_BYTES = 64 * 1024;
/// The ingest body is the raw official catalog (system prompts included); the cap is on the same
/// order of magnitude as MAX_CATALOG_BYTES.
const MAX_INGEST_BODY_BYTES = 9 * 1024 * 1024;
/// The compat body is the build-compat.mjs artifact, normally a few tens of KB.
const MAX_COMPAT_BODY_BYTES = 512 * 1024;

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const expected = env.ADMIN_TOKEN ?? "";
  if (!expected || !token) return false;
  return timingSafeEqualString(token, expected);
}

async function readJsonBody<T>(request: Request, limit: number): Promise<T | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return errorResponse(413, "body too large", "too_large");
  const text = await request.text();
  if (text.length > limit) return errorResponse(413, "body too large", "too_large");
  try {
    return JSON.parse(text) as T;
  } catch {
    return errorResponse(400, "body must be JSON", "bad_request");
  }
}

export async function handleAdmin(request: Request, env: Env, path: string): Promise<Response> {
  if (!authorized(request, env)) {
    return errorResponse(401, "admin token required", "unauthorized");
  }
  const stub = env.SYNC.getByName("primary");

  try {
    if (path === "/admin/status" && request.method === "GET") {
      return jsonResponse(await stub.status());
    }
    if (request.method !== "POST") {
      return errorResponse(405, "method not allowed", "method_not_allowed");
    }
    switch (path) {
      case "/admin/sync":
        return jsonResponse(await stub.runSync("manual"));
      case "/admin/seed": {
        const body = await readJsonBody<SeedInput>(request, MAX_SEED_BODY_BYTES);
        if (body instanceof Response) return body;
        return jsonResponse(await stub.seed(body));
      }
      case "/admin/lease": {
        const body = await readJsonBody<{ agent?: string }>(request, MAX_SEED_BODY_BYTES);
        if (body instanceof Response) return body;
        const result = await stub.lease({ agent: body.agent ?? "unknown" });
        return jsonResponse(result, { status: result.ok ? 200 : result.permanent ? 503 : 409 });
      }
      case "/admin/ingest": {
        const body = await readJsonBody<IngestInput>(request, MAX_INGEST_BODY_BYTES);
        if (body instanceof Response) return body;
        const result = await stub.ingest(body);
        return jsonResponse(result, { status: result.status === "error" ? 422 : 200 });
      }
      case "/admin/release": {
        const body = await readJsonBody<{ lease_id: string; error: string }>(
          request,
          MAX_SEED_BODY_BYTES,
        );
        if (body instanceof Response) return body;
        return jsonResponse(await stub.release(body));
      }
      case "/admin/compat/publish": {
        const body = await readJsonBody<unknown>(request, MAX_COMPAT_BODY_BYTES);
        if (body instanceof Response) return body;
        return publishCompat(env, body);
      }
      default:
        return errorResponse(404, "not found", "not_found");
    }
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : String(error),
      "bad_request",
    );
  }
}
