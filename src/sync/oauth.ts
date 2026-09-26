// ChatGPT OAuth (the same flow as the Codex client): exchange a refresh_token for a new access_token.
// Source of truth: openai/codex rust-v0.153.1 codex-rs/login/src/auth/manager.rs
//   - REFRESH_TOKEN_URL = https://auth.openai.com/oauth/token
//   - CLIENT_ID = app_EMoamEEZ73f0CkXaXp7hrann
//   - Request JSON {client_id, grant_type:"refresh_token", refresh_token}
//   - Response {id_token?, access_token?, refresh_token?} — the refresh_token **rotates**, and the
//     server detects reuse (refresh_token_reused → permanently invalid). The caller must persist
//     the new refresh_token before doing anything else.
//   - Permanent errors: HTTP 401; 400 + invalid_grant; error code ∈
//     {refresh_token_expired, refresh_token_reused, refresh_token_invalidated}.

export const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type RefreshOutcome =
  | { ok: true; accessToken: string; refreshToken: string | null; idToken: string | null }
  | { ok: false; permanent: boolean; reason: string };

const PERMANENT_CODES = new Set([
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      redirect: "manual",
    });
  } catch (error) {
    return { ok: false, permanent: false, reason: `network: ${String(error)}` };
  }

  const text = await response.text();
  if (response.ok) {
    let parsed: { id_token?: unknown; access_token?: unknown; refresh_token?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return { ok: false, permanent: false, reason: "refresh response is not JSON" };
    }
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      return { ok: false, permanent: false, reason: "refresh response lacks access_token" };
    }
    return {
      ok: true,
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : null,
      idToken: typeof parsed.id_token === "string" ? parsed.id_token : null,
    };
  }

  const code = extractErrorCode(text);
  const permanent =
    response.status === 401 ||
    (code !== null && PERMANENT_CODES.has(code)) ||
    (response.status === 400 && code === "invalid_grant");
  return {
    ok: false,
    permanent,
    reason: `HTTP ${response.status}${code ? ` ${code}` : ""}`,
  };
}

/// Mirrors codex's extract_refresh_token_error_code: error.code / error (string) / top-level code.
function extractErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed["error"];
    if (error && typeof error === "object") {
      const code = (error as Record<string, unknown>)["code"];
      if (typeof code === "string") return code;
    }
    if (typeof error === "string") return error;
    const top = parsed["code"];
    if (typeof top === "string") return top;
  } catch {
    // non-JSON error body
  }
  return null;
}

export function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/// JWT `exp` (seconds); null when it cannot be parsed.
export function jwtExpSeconds(token: string): number | null {
  const claims = jwtClaims(token);
  const exp = claims?.["exp"];
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

/// Plan label: `chatgpt_plan_type` inside the id_token's `https://api.openai.com/auth` claim
/// (field names per codex login/src/token_data.rs; null when absent, never guessed).
export function planLabelFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  const claims = jwtClaims(idToken);
  const auth = claims?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const plan = (auth as Record<string, unknown>)["chatgpt_plan_type"];
    if (typeof plan === "string" && plan.length > 0) return plan;
  }
  return null;
}
