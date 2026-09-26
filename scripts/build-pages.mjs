#!/usr/bin/env node
// Assembles the GitHub Pages bundle: the docs page, the pregenerated static datasets and a
// static /v1/index.json, with absolute links baked for the Pages origin. The live catalog
// mirror (/v1/codex/*, /healthz) exists only on the Worker; the bundle links to it.
//
// Usage: node scripts/build-pages.mjs --origin https://cpdotdev.github.io/codexdata [--out .artifacts/pages]

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { MANAGED_DIRS, buildStaticFiles, publicOrigin, root } from "./build-static.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const origin = (opt("--origin") ?? "").replace(/\/+$/, "");
if (!/^https?:\/\/\S+$/.test(origin)) {
  console.error("usage: node scripts/build-pages.mjs --origin <https://host[/base]> [--out <dir>]");
  process.exit(2);
}
const out = resolve(root, opt("--out") ?? ".artifacts/pages");
const live = publicOrigin();
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Docs page, theme, logo and the committed compat payload, copied verbatim. `_headers` is a
// Cloudflare-only file; the managed dataset directories are rebuilt below for this origin.
cpSync(join(root, "public"), out, {
  recursive: true,
  filter: (src) => {
    const rel = relative(join(root, "public"), src);
    return (
      rel !== "_headers" && !MANAGED_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
    );
  },
});

for (const [rel, content] of buildStaticFiles(origin)) {
  if (rel === "_headers") continue;
  const path = join(out, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Static discovery document. Same shape as the Worker's /v1/index.json minus the live
// catalog summary, which only the Worker can produce.
writeFileSync(
  join(out, "v1", "index.json"),
  pretty({
    name: "CodexData",
    version: "v1",
    deployment: "github-pages",
    description:
      "Static mirror of the CodexData datasets for the OpenAI Codex client. The live official-catalog mirror and the health endpoint are served by the Worker at live_origin. Not affiliated with OpenAI.",
    live_origin: live,
    endpoints: {
      codex_models: `${live}/v1/codex/models.json`,
      codex_meta: `${live}/v1/codex/meta.json`,
      codex_snapshots: `${live}/v1/codex/snapshots/index.json`,
      codex_changes: `${live}/v1/codex/changes.json`,
      codex_model_info_schema: `${origin}/v1/schema/codex-model-info/latest.json`,
      codex_model_info_schema_index: `${origin}/v1/schema/codex-model-info/index.json`,
      codex_feature_flags: `${origin}/v1/features/codex/latest.json`,
      codex_feature_flags_index: `${origin}/v1/features/codex/index.json`,
      codex_hook_products: `${origin}/v1/hooks/codex/latest.json`,
      codex_hook_products_index: `${origin}/v1/hooks/codex/index.json`,
      codex_compat: `${origin}/v1/compat/codex/latest.json`,
      health: `${live}/healthz`,
    },
    licenses: {
      code: "MIT",
      datasets:
        "CC-BY-4.0 (feature-flag registry + annotations, ModelInfo schema, compat, hook registry); derived from openai/codex sources (Apache-2.0, reproduced with LICENSE + NOTICE in the repository)",
      codex_catalog: "Served as-is from OpenAI; no license granted by CodexData.",
    },
  }),
);
// Pages serves the artifact as-is, but the marker keeps any Jekyll processing off for good.
writeFileSync(join(out, ".nojekyll"), "");

console.log(`pages bundle written to ${relative(root, out)}/ (origin ${origin}, live ${live})`);
