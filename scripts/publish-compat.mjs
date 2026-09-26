#!/usr/bin/env node
// POST public/v1/compat/codex/latest.json to the Worker's /admin/compat/publish (KV hot update, no
// redeploy needed). Called by the compat-watch workflow when the probe output changes; can also be
// run manually.
// Environment: CODEXDATA_ORIGIN (default https://data.cp.dev), CODEXDATA_ADMIN_TOKEN (required).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.env.CODEXDATA_ORIGIN ?? "https://data.cp.dev";
const token = process.env.CODEXDATA_ADMIN_TOKEN;
if (!token) {
  console.error("CODEXDATA_ADMIN_TOKEN is required");
  process.exit(1);
}

const payload = readFileSync(join(root, "public", "v1", "compat", "codex", "latest.json"), "utf8");
const response = await fetch(`${origin}/admin/compat/publish`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: payload,
});
const body = await response.text();
console.log(`POST /admin/compat/publish -> HTTP ${response.status}`);
console.log(body.slice(0, 500));
if (!response.ok) process.exit(1);
