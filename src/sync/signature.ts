// Catalog signature verification (format v1, shared with scripts/catalog-signature.mjs and the
// Codex Pass client).
//
// The sync agent signs the canonical catalog text with an Ed25519 key that lives only in GitHub
// (environment `catalog-signing`); the Worker publishes a signed catalog only if the signature
// verifies against one of its trusted public keys, and serves the signature next to the body. So
// write access to KV or the ADMIN_TOKEN alone is not enough to make clients trust a catalog.
//
//   signed bytes  UTF-8 of "codexdata-catalog-v1\n" + canonical text (= the models.json body)
//   algorithm     pure Ed25519 (RFC 8032)
//   public key    raw 32 bytes, base64url without padding (wrangler var CATALOG_SIGNING_PUBLIC_KEYS)
//   kid           first 16 lowercase hex characters of SHA-256(raw public key)
//   header        x-codexdata-signature: v1.<kid>.<64-byte signature, base64url without padding>

export const SIGNATURE_HEADER = "x-codexdata-signature";
const SIGNATURE_CONTEXT = "codexdata-catalog-v1\n";
const KID_RE = /^[0-9a-f]{16}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type SignatureFailure =
  "malformed" | "unknown_kid" | "bad_signature" | "no_trusted_keys" | "bad_public_key";

export type SignatureVerdict = { ok: true; kid: string } | { ok: false; reason: SignatureFailure };

export interface ParsedSignature {
  kid: string;
  signature: Uint8Array;
}

/// Strict parse: exactly three `.`-separated parts, `v1`, a 16-hex kid, and a canonical unpadded
/// base64url signature of exactly 64 bytes. Anything else is null.
export function parseSignatureHeader(value: string): ParsedSignature | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [version, kid, encoded] = parts as [string, string, string];
  if (version !== "v1" || !KID_RE.test(kid)) return null;
  const signature = base64UrlDecode(encoded);
  if (!signature || signature.byteLength !== 64) return null;
  return { kid, signature };
}

/// Verify `headerValue` over the canonical catalog text. `publicKeysVar` is the comma- or
/// whitespace-separated key list; one malformed entry fails every verification (fail closed on a
/// configuration error instead of silently trusting fewer keys than intended).
export async function verifyCatalogSignature(
  canonicalText: string,
  headerValue: string,
  publicKeysVar: string | undefined,
): Promise<SignatureVerdict> {
  const parsed = parseSignatureHeader(headerValue);
  if (!parsed) return { ok: false, reason: "malformed" };

  const entries = (publicKeysVar ?? "").split(/[\s,]+/).filter((entry) => entry.length > 0);
  if (entries.length === 0) return { ok: false, reason: "no_trusted_keys" };
  let match: Uint8Array | null = null;
  for (const entry of entries) {
    const raw = base64UrlDecode(entry);
    if (!raw || raw.byteLength !== 32) return { ok: false, reason: "bad_public_key" };
    if ((await keyId(raw)) === parsed.kid) match = raw;
  }
  if (!match) return { ok: false, reason: "unknown_kid" };

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", match, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { ok: false, reason: "bad_public_key" };
  }
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    parsed.signature,
    new TextEncoder().encode(SIGNATURE_CONTEXT + canonicalText),
  );
  return valid ? { ok: true, kid: parsed.kid } : { ok: false, reason: "bad_signature" };
}

/// First 16 lowercase hex characters of SHA-256(raw public key).
export async function keyId(rawPublicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// Unpadded base64url → bytes; null unless the input is the canonical encoding of its bytes.
function base64UrlDecode(text: string): Uint8Array | null {
  if (!BASE64URL_RE.test(text) || text.length % 4 === 1) return null;
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return base64UrlEncode(bytes) === text ? bytes : null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
