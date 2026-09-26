#!/usr/bin/env node
// Pregenerates the static datasets into public/ so the Workers asset layer serves them
// directly (asset hits never invoke the Worker); Worker code only handles the live endpoints.
//   public/v1/features/codex/{latest,<tag>,index}.json            feature-flag registry (facts + annotations)
//   public/v1/schema/codex-model-info/{latest,<tag>,index}.json   ModelInfo JSON Schema
//   public/v1/hooks/codex/{latest,index}.json                     hook product registry
//   public/_headers                                               CORS + cache headers for /v1/* assets
// The output is deterministic and committed; validate.mjs runs `--check` to byte-compare it.
// Absolute links inside the index.json files are baked from CODEXDATA_PUBLIC_ORIGIN in
// wrangler.jsonc; `--origin` overrides it.
//
// Usage: node scripts/build-static.mjs                       regenerate public/
//        node scripts/build-static.mjs --check               verify only (exit 1 on drift)
//        node scripts/build-static.mjs --origin <url> --out <dir>

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildHooks } from "./hooks.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_URL = "https://github.com/cpdotdev/codexdata";
/** Directories fully owned by this script; any extra file in them counts as drift. */
export const MANAGED_DIRS = ["v1/hooks/codex", "v1/features/codex", "v1/schema/codex-model-info"];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** wrangler.jsonc is JSONC; pull out the one variable without adding a parser dependency. */
export function publicOrigin() {
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const m = text.match(/"CODEXDATA_PUBLIC_ORIGIN":\s*"(https:\/\/[^"]+)"/);
  if (!m) throw new Error("CODEXDATA_PUBLIC_ORIGIN not found in wrangler.jsonc");
  return m[1];
}

/** Builds every managed file for `origin`. Returns Map<path relative to public/, content>. */
export function buildStaticFiles(origin) {
  const files = new Map();

  // ── Feature-flag registry ──────────────────────────────────────────────────────
  {
    const dir = "v1/features/codex";
    const featuresDir = join(root, "data", "codex-features");
    const tags = readJson(join(featuresDir, "tags.json"));
    const registry = readJson(join(featuresDir, tags.registry));
    // Human-curated layer: one file per flag (annotations/<key>.json, community-translatable),
    // merged at build time.
    const annotations = {};
    const annDir = join(featuresDir, tags.annotations);
    for (const name of readdirSync(annDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const entry = readJson(join(annDir, name));
      if (`${entry.key}.json` !== name)
        throw new Error(`annotations/${name}: key \`${entry.key}\` does not match the filename`);
      annotations[entry.key] = {
        ...(entry.aka ? { aka: entry.aka } : {}),
        i18n: Object.fromEntries(Object.entries(entry.i18n).sort(([a], [b]) => (a < b ? -1 : 1))),
      };
    }
    const snapshotOf = (tag) => tags.snapshot_aliases[tag] ?? tag;

    const payloadBySnapshot = new Map();
    for (const snapshotTag of Object.keys(registry.tags)) {
      const data = registry.tags[snapshotTag];
      const aliasesByCanonical = new Map();
      for (const [legacy, canonical] of Object.entries(data.legacy_aliases)) {
        if (!canonical) continue;
        aliasesByCanonical.set(canonical, [...(aliasesByCanonical.get(canonical) ?? []), legacy]);
      }
      const flags = data.flags.map((flag) => ({
        ...flag,
        legacy_aliases: aliasesByCanonical.get(flag.key) ?? [],
        history: registry.history[flag.key] ?? null,
        annotation: annotations[flag.key] ?? null,
      }));
      const localeCounts = {};
      for (const flag of flags) {
        for (const locale of Object.keys(flag.annotation?.i18n ?? {})) {
          localeCounts[locale] = (localeCounts[locale] ?? 0) + 1;
        }
      }
      payloadBySnapshot.set(
        snapshotTag,
        pretty({
          dataset: "codex-feature-flags",
          snapshot_tag: snapshotTag,
          applies_to: tags.verified_tags.filter((tag) => snapshotOf(tag) === snapshotTag),
          counts: {
            total: flags.length,
            annotated: flags.filter((flag) => flag.annotation !== null).length,
            locales: Object.fromEntries(
              Object.entries(localeCounts).sort(([a], [b]) => (a < b ? -1 : 1)),
            ),
          },
          flags,
          source: {
            files: registry.source_files,
            license: "CC-BY-4.0 (registry + annotations); derived from openai/codex (Apache-2.0)",
            not_affiliated_with_openai: true,
          },
        }),
      );
    }
    for (const tag of tags.verified_tags)
      files.set(`${dir}/${tag}.json`, payloadBySnapshot.get(snapshotOf(tag)));
    files.set(`${dir}/latest.json`, payloadBySnapshot.get(snapshotOf(tags.latest)));

    const url = (tag) => `${origin}/${dir}/${tag}.json`;
    files.set(
      `${dir}/index.json`,
      pretty({
        dataset: "codex-feature-flags",
        latest: { tag: tags.latest, url: url("latest") },
        verified_tags: tags.verified_tags.map((tag) => ({
          tag,
          snapshot_tag: snapshotOf(tag),
          url: url(tag),
        })),
        source_files: tags.source_files,
        notes: tags.notes,
        license: {
          registry_and_annotations: "CC-BY-4.0",
          derived_from:
            "openai/codex (Apache-2.0); source snapshots in the repository under data/codex-features/sources/",
        },
      }),
    );
  }

  // ── ModelInfo JSON Schema (one schema; every verified tag serves the same bytes) ──
  {
    const dir = "v1/schema/codex-model-info";
    const schemaDir = join(root, "data", "codex-schema");
    const tags = readJson(join(schemaDir, "tags.json"));
    const schemaText = pretty(readJson(join(schemaDir, tags.schema)));
    for (const tag of tags.verified_tags) files.set(`${dir}/${tag}.json`, schemaText);
    files.set(`${dir}/latest.json`, schemaText);

    const url = (tag) => `${origin}/${dir}/${tag}.json`;
    files.set(
      `${dir}/index.json`,
      pretty({
        schema: "codex-model-info",
        latest: { tag: tags.latest, url: url("latest") },
        verified_tags: tags.verified_tags.map((tag) => ({ tag, url: url(tag) })),
        source_files: tags.source_files,
        notes: tags.notes,
        license: {
          schema: "CC-BY-4.0",
          derived_from:
            "openai/codex (Apache-2.0); source snapshots in the repository under data/codex-schema/sources/",
        },
      }),
    );
  }

  // ── Hook product registry ──────────────────────────────────────────────────────
  {
    const hooks = buildHooks();
    files.set("v1/hooks/codex/latest.json", pretty(hooks));
    files.set(
      "v1/hooks/codex/index.json",
      pretty({
        dataset: hooks.dataset,
        schema_version: hooks.schema_version,
        latest: `${origin}/v1/hooks/codex/latest.json`,
        contribute: `${REPO_URL}/blob/main/docs/HOOKS.md`,
        license: "CC-BY-4.0",
        icon_rights: "Product marks retain their owners' rights; see each product's icon.rights.",
      }),
    );
  }

  // ── Response headers for /v1/* assets (asset layer only; Worker routes set their own) ──
  files.set(
    "_headers",
    `/v1/*
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  Access-Control-Allow-Headers: If-None-Match, Content-Type
  Access-Control-Expose-Headers: ETag
  Cache-Control: public, max-age=3600, stale-while-revalidate=86400, stale-if-error=86400
`,
  );

  return files;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const origin = (opt("--origin") ?? publicOrigin()).replace(/\/+$/, "");
  const outDir = join(root, opt("--out") ?? "public");
  const files = buildStaticFiles(origin);

  // Verify: every managed file matches, and managed directories contain nothing else
  // (so files from removed tags cannot linger).
  const problems = [];
  for (const [rel, content] of files) {
    let existing = null;
    try {
      existing = readFileSync(join(outDir, rel), "utf8");
    } catch {
      /* missing counts as drift */
    }
    if (existing !== content) problems.push(`stale or missing: ${rel}`);
  }
  for (const dir of MANAGED_DIRS) {
    let names = [];
    try {
      names = readdirSync(join(outDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const rel = `${dir}/${name}`;
      if (!files.has(rel)) problems.push(`unmanaged extra file: ${rel}`);
    }
  }

  const label = relative(root, outDir) || ".";
  if (args.includes("--check")) {
    if (problems.length > 0) {
      console.error(
        `✗ ${label}/ static artifacts are out of date; run scripts/build-static.mjs\n  ${problems.join("\n  ")}`,
      );
      process.exit(1);
    }
    console.log(`✓ ${label}/ static artifacts match the data sources (${files.size} files)`);
  } else {
    for (const [rel, content] of files) {
      const path = join(outDir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    console.log(`written: ${files.size} files under ${label}/`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
