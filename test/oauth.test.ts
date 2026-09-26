import { describe, expect, it } from "vitest";
import { jwtExpSeconds, planLabelFromIdToken, refreshAccessToken } from "../src/sync/oauth";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (s: string) => btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify(claims))}.sig`;
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("refreshAccessToken", () => {
  it("returns rotated tokens on success", async () => {
    const outcome = await refreshAccessToken(
      "old",
      fakeFetch(200, { access_token: "new-access", refresh_token: "new-refresh", id_token: "id" }),
    );
    expect(outcome).toEqual({
      ok: true,
      accessToken: "new-access",
      refreshToken: "new-refresh",
      idToken: "id",
    });
  });

  it("classifies permanent failures: 401, invalid_grant, reused/expired/invalidated codes", async () => {
    for (const [status, body] of [
      [401, { error: { code: "token_expired" } }],
      [400, { error: "invalid_grant" }],
      [400, { error: { code: "refresh_token_reused" } }],
      [400, { code: "refresh_token_expired" }],
      [400, { error: { code: "refresh_token_invalidated" } }],
    ] as const) {
      const outcome = await refreshAccessToken("x", fakeFetch(status, body));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.permanent, `${status} ${JSON.stringify(body)}`).toBe(true);
    }
  });

  it("classifies 5xx, network errors and malformed success bodies as transient", async () => {
    const five = await refreshAccessToken("x", fakeFetch(503, "down"));
    expect(five).toMatchObject({ ok: false, permanent: false });
    const network = await refreshAccessToken("x", (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    expect(network).toMatchObject({ ok: false, permanent: false });
    const malformed = await refreshAccessToken("x", fakeFetch(200, { nope: true }));
    expect(malformed).toMatchObject({ ok: false, permanent: false });
  });
});

describe("jwt helpers", () => {
  it("reads exp and the ChatGPT plan label; tolerates garbage", () => {
    const token = jwt({
      exp: 1_800_000_000,
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
    });
    expect(jwtExpSeconds(token)).toBe(1_800_000_000);
    expect(planLabelFromIdToken(token)).toBe("pro");
    expect(jwtExpSeconds("not-a-jwt")).toBeNull();
    expect(planLabelFromIdToken(null)).toBeNull();
    expect(planLabelFromIdToken(jwt({}))).toBeNull();
  });
});
