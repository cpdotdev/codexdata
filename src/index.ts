// CodexData Worker entry: read paths (KV → edge cache), admin paths, scheduled sync.
// Purely static datasets (/v1/features/*, /v1/schema/*) are not served here: scripts/build-static.mjs
// pre-generates them into public/ and the Workers static-assets layer serves them directly (asset
// requests do not count as Worker invocations, so they cost nothing per request); only asset misses
// (unknown tag / mistyped path) reach this Worker, which answers with a JSON 404 pointer.

import { handleAdmin } from "./http/admin";
import {
  serveChanges,
  serveCodexMeta,
  serveCodexModels,
  serveHealth,
  serveIndex,
  serveSnapshot,
  serveSnapshotsIndex,
} from "./http/codex";
import { COMPAT_PATH, serveCompat } from "./http/compat";
import { errorResponse, headOf, notModifiedIfMatches, preflight } from "./http/headers";

export { SyncCoordinator } from "./sync/coordinator";

const SNAPSHOT_RE = /^\/v1\/codex\/snapshots\/([0-9a-f]{64})\.json$/;
// Static dataset prefixes (the assets layer already serves valid requests; reaching the Worker = miss).
const STATIC_DATASET_PREFIXES = [
  "/v1/hooks/codex/",
  "/v1/features/codex/",
  "/v1/schema/codex-model-info/",
];

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return preflight();

    if (path.startsWith("/admin/")) {
      return handleAdmin(request, env, path);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "method not allowed", "method_not_allowed");
    }

    if (path === "/healthz") {
      const status = await env.SYNC.getByName("primary").status();
      return serveHealth(env, status.permanent_failure !== null);
    }

    const api = await routeApi(env, path, url.origin);
    if (api) {
      // Worker responses do not enter the CDN cache automatically; go through the Cache API
      // explicitly and store according to Cache-Control.
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const cache = caches.default;
      let response = await cache.match(cacheKey);
      if (!response) {
        const fresh = await api();
        if (fresh.ok && fresh.headers.get("cache-control")?.startsWith("public")) {
          ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
        }
        response = fresh;
      }
      const conditional = notModifiedIfMatches(request, response);
      return request.method === "HEAD" ? headOf(conditional) : conditional;
    }

    // Everything else goes to static assets (docs page, pre-generated datasets). In production an
    // asset hit never reaches the Worker (the assets layer sits in front, at zero cost); reaching this
    // point = asset miss or the local dev simulator, so ask the binding once and answer misses under a
    // dataset prefix with a JSON 404 pointer.
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status === 404) {
      const dataset = STATIC_DATASET_PREFIXES.find((prefix) => path.startsWith(prefix));
      if (dataset) {
        return errorResponse(
          404,
          `unknown or unverified path under ${dataset}; see ${publicOrigin(env, url.origin)}${dataset}index.json`,
          "unknown_dataset_path",
        );
      }
    }
    return assetResponse;
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      env.SYNC.getByName("primary")
        .runSync("cron")
        .then((result) => console.log(JSON.stringify({ event: "sync", result })))
        .catch((error: unknown) =>
          console.error(JSON.stringify({ event: "sync_failed", error: String(error) })),
        ),
    );
  },
} satisfies ExportedHandler<Env>;

function routeApi(env: Env, path: string, origin: string): (() => Promise<Response>) | null {
  switch (path) {
    case "/v1/index.json":
      return () => serveIndex(env, publicOrigin(env, origin));
    case "/v1/codex/models.json":
      return () => serveCodexModels(env);
    case "/v1/codex/meta.json":
      return () => serveCodexMeta(env);
    case "/v1/codex/snapshots/index.json":
      return () => serveSnapshotsIndex(env);
    case "/v1/codex/changes.json":
      return () => serveChanges(env);
    case COMPAT_PATH:
      return () => serveCompat(env, origin);
    default: {
      const snapshot = SNAPSHOT_RE.exec(path);
      if (snapshot) {
        const hash = snapshot[1]!;
        return () => serveSnapshot(env, hash);
      }
      return null;
    }
  }
}

function publicOrigin(env: Env, fallback: string): string {
  const configured = env.CODEXDATA_PUBLIC_ORIGIN;
  return typeof configured === "string" && configured.startsWith("https://")
    ? configured
    : fallback;
}
