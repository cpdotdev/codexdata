import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import policy from "../data/codex-quota/policy.json";

const BASE = "https://codexdata.test/v1/quotas/codex";
const PUBLIC = `${env.CODEXDATA_PUBLIC_ORIGIN}/v1/quotas/codex`;

describe("quota policy static endpoint", () => {
  it("serves reviewed policy with CORS, cache headers and conditional revalidation", async () => {
    const response = await SELF.fetch(`${BASE}/latest.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toContain("max-age=3600");
    expect(await response.json()).toEqual(policy);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    const unchanged = await SELF.fetch(`${BASE}/latest.json`, {
      headers: { "if-none-match": etag! },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  });

  it("is discoverable and gives JSON errors for unsupported paths", async () => {
    const index = (await (await SELF.fetch("https://codexdata.test/v1/index.json")).json()) as {
      endpoints: Record<string, string>;
      licenses: Record<string, string>;
    };
    expect(index.endpoints.codex_quota_policy).toBe(`${PUBLIC}/latest.json`);
    expect(index.licenses.codex_quota_policy).toBe("CC-BY-4.0");
    const datasetIndex = await SELF.fetch(`${BASE}/index.json`);
    expect(datasetIndex.status).toBe(200);
    expect(await datasetIndex.json()).toMatchObject({ latest: `${PUBLIC}/latest.json` });
    for (const path of ["missing.json", "latest", "2026100501.json"]) {
      const response = await SELF.fetch(`${BASE}/${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { type: "unknown_dataset_path" } });
    }
  });
});
