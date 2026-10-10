import type { CatalogModel } from "../src/sync/catalog";

/// One official catalog entry satisfying every field Codex 0.153.x requires (any field can be
/// overridden).
export function officialModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    default_reasoning_level: "low",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "high", description: "Deep" },
    ],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 6,
    support_verbosity: true,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    base_instructions: "You are Codex.",
    use_responses_lite: true,
    ...overrides,
  };
}

export interface TestSigningKey {
  pem: string;
  publicKey: string;
  kid: string;
}

/// Shared signature format v1 test vector (TEST-ONLY key; scripts/catalog-signature.test.mjs and
/// the Codex Pass client assert the same values). Trusted only through vitest.config.ts.
export const SIGNING_VECTOR = {
  pem: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKx18jWk+Beab5WVVUZkGRVr2ZyBHW76VEwg4OcGpOJp\n-----END PRIVATE KEY-----\n",
  publicKey: "SuxU8H8gxEBdAdAX9_-DtBtEaVSNvwtwkak1JGCnl5s",
  publicKeyBase64: "SuxU8H8gxEBdAdAX9/+DtBtEaVSNvwtwkak1JGCnl5s=",
  kid: "e54ddc2b3b75b4a0",
  body: '{"models":[{"display_name":"Test","slug":"gpt-test","visibility":"list"}]}',
  header:
    "v1.e54ddc2b3b75b4a0.S1r4BO3ECX1-xSFTehh4l-y1PZuWH1ksKiBwR4pKUq0Y58zgUnxrGvJn0fxY_QPfyQtFnsCyxZkJ2EkCKPgHBQ",
} as const;

/// Second TEST-ONLY key, also trusted in vitest.config.ts (key rotation).
export const SECOND_TEST_KEY: TestSigningKey = {
  pem: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMgkpqmcLIU9B273gYmdY/6vDn8gdp9x7+4Oj1OKJv+o\n-----END PRIVATE KEY-----\n",
  publicKey: "CAtY-p-zYUSkwpCfopdnaBgUkg702k7l4A9FCUKyIZE",
  kid: "dedfbfba0d17de08",
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// Sign like scripts/catalog-signature.mjs, with WebCrypto (the tests run inside workerd).
export async function signCatalogText(key: TestSigningKey, canonicalText: string): Promise<string> {
  const der = Uint8Array.from(
    atob(key.pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, [
    "sign",
  ]);
  return signWithCryptoKey(privateKey, key.kid, canonicalText);
}

export async function signWithCryptoKey(
  privateKey: CryptoKey,
  kid: string,
  canonicalText: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(`codexdata-catalog-v1\n${canonicalText}`),
  );
  return `v1.${kid}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/// Shared data-signature test vector (TEST-ONLY key, seed = sha256("codexdata data signature test
/// key v1"); scripts/data-signature.test.mjs and the Codex Pass client assert the same values).
/// Trusted only through vitest.config.ts DATA_SIGNING_PUBLIC_KEYS.
export const DATA_SIGNING_VECTOR = {
  pem: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIGp6v4X1J4lTIJg4sE/LPSk9XJipvbgoO2y4WOjWAMdF\n-----END PRIVATE KEY-----\n",
  publicKey: "zxe3l2ZwZCtAnr2Q6TD29dlJK3kpeUzDWxwQuMfW6S8",
  kid: "c9797177296589d3",
  body: '{"dataset":"codexdata-signature-test","revision":1}',
  headers: {
    quotaPolicy:
      "v1.c9797177296589d3.xmFvtLTeZckEmEuVW8mdyUvVkPvupb2gdvbFjlOrr54Naa18SCWpidqGsMqBTuqgwBx_J7qBZ8xVXI1lVPcGAg",
    features:
      "v1.c9797177296589d3.KmInGH3cAghCszmgDAXDW-SV3pSZRbS4Eud74dWNkSbJUvTuraXGp-BqV3ERrifmz1N7h5I-OXqJGCLvBYU2DQ",
    compat:
      "v1.c9797177296589d3.Yj6C2RaocwqUM-sHJ5hrL_AMSE2P0LaDuxBh6jZCi7LaFu3vDtJ0l7tr8qfWmqN0UKblz16xmoEO_NFHuJv2DQ",
    hooks:
      "v1.c9797177296589d3.mLssCZxFSsHeZMoTK5gCKihWj_OraMuEj-HNEPF0toD4e-RbB8SMNBnnromSbWu5mZIEed3_8iPQlfmrBMoMCg",
  },
} as const;

/// Sign `body` like scripts/data-signature.mjs (`context` from DATA_CONTEXTS), with WebCrypto.
export async function signData(
  key: Pick<TestSigningKey, "pem" | "kid">,
  context: string,
  body: Uint8Array,
): Promise<string> {
  const der = Uint8Array.from(
    atob(key.pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, [
    "sign",
  ]);
  const prefix = new TextEncoder().encode(context);
  const message = new Uint8Array(prefix.byteLength + body.byteLength);
  message.set(prefix, 0);
  message.set(body, prefix.byteLength);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message);
  return `v1.${key.kid}.${base64UrlEncode(new Uint8Array(signature))}`;
}
