// The official catalog must be fetched with the **latest** client version (the server may gate on
// client_version). The version comes from the npm registry; when unavailable, the caller falls back
// to the last recorded version.

export const CODEX_NPM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";

const SEMVER = /^\d+\.\d+\.\d+$/;

export async function latestCodexClientVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(CODEX_NPM_LATEST_URL, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { version?: unknown };
    const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
    return SEMVER.test(version) ? version : null;
  } catch {
    return null;
  }
}
