// HTTP response helpers: cache headers, CORS, ETag/304.

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "If-None-Match, Content-Type",
  "access-control-expose-headers":
    "ETag, X-CodexData-Fetched-At, X-CodexData-Client-Version, X-CodexData-Source-Plan, X-CodexData-Content-Hash, X-CodexData-Signature",
  "access-control-max-age": "86400",
};

export const CACHE_LIVE = "public, max-age=300, stale-while-revalidate=3600, stale-if-error=86400";
export const CACHE_HOURLY =
  "public, max-age=3600, stale-while-revalidate=86400, stale-if-error=86400";
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
export const CACHE_NONE = "no-store";

export function jsonResponse(
  body: unknown,
  init: {
    status?: number;
    cacheControl?: string;
    etag?: string;
    headers?: Record<string, string>;
  } = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": init.cacheControl ?? CACHE_NONE,
    ...CORS_HEADERS,
    ...(init.headers ?? {}),
  });
  if (init.etag) headers.set("etag", init.etag);
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status: init.status ?? 200, headers });
}

export function errorResponse(status: number, message: string, type: string): Response {
  return jsonResponse({ error: { message, type } }, { status, cacheControl: CACHE_NONE });
}

/// `If-None-Match` hit → 304 (keeps the ETag/cache headers, drops the body).
export function notModifiedIfMatches(request: Request, response: Response): Response {
  const etag = response.headers.get("etag");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (!etag || !ifNoneMatch) return response;
  const candidates = ifNoneMatch.split(",").map((v) => v.trim());
  if (candidates.includes("*") || candidates.includes(etag) || candidates.includes(`W/${etag}`)) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return response;
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function headOf(response: Response): Response {
  return new Response(null, { status: response.status, headers: response.headers });
}
