#!/usr/bin/env node
// One-off bootstrap: hand the dedicated account's `codex login` result (auth.json) to the Worker's
// SyncCoordinator, which stores it encrypted. The token travels in the TLS request body, never in
// argv or logs.
//
//   CODEXDATA_ADMIN_TOKEN=… node scripts/seed.mjs --auth /tmp/codexdata-bootstrap/auth.json [--origin https://data.cp.dev] [--shred]
//
// --shred: after a successful seed, zero-fill and delete auth.json (so this refresh token exists only
// in the Worker).

import { readFile, writeFile, unlink, stat } from "node:fs/promises";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const authPath = opt("--auth", null);
const origin = opt("--origin", process.env.CODEXDATA_ORIGIN ?? "https://data.cp.dev").replace(
  /\/+$/,
  "",
);
const shred = args.includes("--shred");
const adminToken = process.env.CODEXDATA_ADMIN_TOKEN ?? "";

if (!authPath) {
  console.error(
    "usage: CODEXDATA_ADMIN_TOKEN=… node scripts/seed.mjs --auth <auth.json> [--origin <url>] [--shred]",
  );
  process.exit(2);
}
if (!adminToken) {
  console.error("CODEXDATA_ADMIN_TOKEN is required (env)");
  process.exit(2);
}

const raw = JSON.parse(await readFile(authPath, "utf8"));
const tokens = raw.tokens ?? {};
if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
  console.error(
    "auth.json has no tokens.refresh_token — log in with `codex login` (ChatGPT mode) first",
  );
  process.exit(2);
}

const res = await fetch(`${origin}/admin/seed`, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify({
    refresh_token: tokens.refresh_token,
    access_token: typeof tokens.access_token === "string" ? tokens.access_token : undefined,
    id_token: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
    account_id: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
  }),
});
const body = await res.text();
if (!res.ok) {
  console.error(`seed failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  process.exit(1);
}
console.log(`seeded: ${body}`);

if (shred) {
  const { size } = await stat(authPath);
  await writeFile(authPath, Buffer.alloc(size, 0));
  await unlink(authPath);
  console.log(`shredded ${authPath}`);
} else {
  console.log(
    `NOTE: ${authPath} still contains the refresh token; delete it (or rerun with --shred).`,
  );
}
