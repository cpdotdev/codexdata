#!/usr/bin/env node
// Sync new upstream openai/codex `rust-vX.Y.Z` release tags into the two tag-driven datasets
// (docs/RUNBOOK.md "Adding a new Codex tag", steps 1, 2 and the vendoring half of step 4):
//
//   1. Feature flags: vendor codex-rs/features/src/lib.rs at each new tag into
//      data/codex-features/sources/<tag>/, or record the tag in snapshot_aliases when the file is
//      byte-identical to the previous snapshot. legacy.rs must stay byte-identical (the extractor
//      keeps it once); a change aborts the sync so a human extends the extractor.
//   2. ModelInfo schema: vendor codex-rs/protocol/src/{openai_models,config_types}.rs plus the
//      openai_models/*.rs submodules they declare into data/codex-schema/sources/<tag>/ (alias
//      when all are byte-identical). Each stored snapshot also keeps the client's own bundled
//      catalog codex-rs/models-manager/models.json at that tag, so validate.mjs checks the schema
//      against every one of them. The schema itself is never edited here: when the sources
//      change, the summary says so and a human reviews the struct diff.
//   3. Update both tags.json files, rerun extract-features.mjs and build-static.mjs, and write a
//      Markdown summary (new tags, flag changes, flags without a zh annotation, schema changes).
//
// Only stable tags (no -alpha/-beta suffix) are synced, in version order, starting after each
// dataset's current `latest`.
//
// Usage: node scripts/sync-codex-tags.mjs [--through rust-vX.Y.Z] [--summary <file>] [--check]
//   --through  stop after this tag
//   --summary  also write the Markdown summary to this file
//   --check    only report which tags are missing; exit 10 if any
// Exit codes: 0 = synced or nothing new; 10 = (--check) new tags exist; 1 = failure.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const featuresDir = join(root, "data", "codex-features");
const schemaDir = join(root, "data", "codex-schema");
const annotationsDir = join(featuresDir, "annotations");

const UPSTREAM_GIT = "https://github.com/openai/codex.git";
const RAW = "https://raw.githubusercontent.com/openai/codex";
const FEATURES_LIB = "codex-rs/features/src/lib.rs";
const FEATURES_LEGACY = "codex-rs/features/src/legacy.rs";
const SCHEMA_ROOTS = [
  "codex-rs/protocol/src/openai_models.rs",
  "codex-rs/protocol/src/config_types.rs",
];
const BUNDLED_MODELS = "codex-rs/models-manager/models.json";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const through = argValue("--through");
const summaryPath = argValue("--summary");
const checkOnly = args.includes("--check");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** [major, minor, patch] of a stable rust-v tag, or null for anything else. */
function stableVersion(tag) {
  const m = tag.match(/^rust-v(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}

function compareTags(a, b) {
  const va = stableVersion(a);
  const vb = stableVersion(b);
  for (let i = 0; i < 3; i += 1) if (va[i] !== vb[i]) return va[i] - vb[i];
  return 0;
}

function upstreamStableTags() {
  const out = execFileSync("git", ["ls-remote", "--tags", "--refs", UPSTREAM_GIT, "rust-v*"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.split("\trefs/tags/")[1])
    .filter((tag) => tag && stableVersion(tag))
    .sort(compareTags);
}

async function fetchText(tag, path) {
  const url = `${RAW}/${tag}/${path}`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response.text();
    if (response.status === 404 || attempt === 3)
      throw new Error(`${url}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

/**
 * Out-of-line `mod name;` declarations in a non-mod.rs file `<dir>/<stem>.rs`, resolved the way
 * rustc does: a `#[path = "..."]` attribute is relative to `<dir>`, otherwise `<dir>/<stem>/<name>.rs`.
 * Test-only modules (`#[cfg(test)]` or a `_tests`/`tests` name) are skipped.
 */
function declaredModules(text, filePath) {
  const dir = dirname(filePath);
  const stem = filePath.slice(dir.length + 1).replace(/\.rs$/, "");
  const modules = [];
  let attrs = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#[")) {
      attrs.push(trimmed);
      continue;
    }
    const mod = trimmed.match(/^(?:pub(?:\([a-z]+\))? )?mod ([a-z0-9_]+);$/);
    if (mod) {
      const pathAttr = attrs.map((a) => a.match(/^#\[path = "([^"]+)"\]$/)).find(Boolean);
      const testOnly = attrs.some((a) => a.includes("cfg(test)")) || /(^|_)tests$/.test(mod[1]);
      if (!testOnly)
        modules.push(pathAttr ? `${dir}/${pathAttr[1]}` : `${dir}/${stem}/${mod[1]}.rs`);
    }
    if (trimmed !== "") attrs = [];
  }
  return modules;
}

/** Published path → contents for the schema sources at a tag (roots plus declared submodules). */
async function fetchSchemaSources(tag) {
  const files = new Map();
  for (const path of SCHEMA_ROOTS) {
    const text = await fetchText(tag, path);
    files.set(path, text);
    for (const sub of declaredModules(text, path)) files.set(sub, await fetchText(tag, sub));
  }
  return files;
}

/** Local file name inside sources/<tag>/: the path below codex-rs/protocol/src/. */
const schemaLocalName = (path) => path.replace(/^codex-rs\/protocol\/src\//, "");

function readSchemaSnapshot(tag, paths) {
  const dir = join(schemaDir, "sources", tag);
  const files = new Map();
  for (const path of paths) {
    const local = join(dir, schemaLocalName(path));
    if (!existsSync(local)) return null;
    files.set(path, readFileSync(local, "utf8"));
  }
  // A snapshot with extra files (a submodule since removed) is not identical either.
  const stored = listFiles(dir).filter((name) => name !== "models.json");
  return stored.length === paths.length ? files : null;
}

function listFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

const sameFiles = (a, b) =>
  a !== null && a.size === b.size && [...a].every(([path, text]) => b.get(path) === text);

// ── Plan ─────────────────────────────────────────────────────────────────────
const ftags = readJson(join(featuresDir, "tags.json"));
const stags = readJson(join(schemaDir, "tags.json"));
stags.snapshot_aliases ??= {};

const upstream = upstreamStableTags();
const pending = (latest) =>
  upstream.filter(
    (tag) => compareTags(tag, latest) > 0 && (!through || compareTags(tag, through) <= 0),
  );
const featureTags = pending(ftags.latest);
const schemaTags = pending(stags.latest);

if (checkOnly) {
  console.log(`features: latest ${ftags.latest}; missing ${featureTags.join(", ") || "none"}`);
  console.log(`schema: latest ${stags.latest}; missing ${schemaTags.join(", ") || "none"}`);
  process.exit(featureTags.length + schemaTags.length > 0 ? 10 : 0);
}
if (featureTags.length + schemaTags.length === 0) {
  console.log(`nothing to sync (features ${ftags.latest}, schema ${stags.latest})`);
  process.exit(0);
}

// ── Features ─────────────────────────────────────────────────────────────────
const fSnapshotOf = (tag) => ftags.snapshot_aliases[tag] ?? tag;
const previousFeatureLatest = ftags.latest;
const legacyLocal = readFileSync(join(featuresDir, "sources", "legacy.rs"), "utf8");
for (const tag of featureTags) {
  const legacy = await fetchText(tag, FEATURES_LEGACY);
  if (legacy !== legacyLocal)
    throw new Error(
      `${tag}: legacy.rs differs from sources/legacy.rs; extend extract-features.mjs to keep per-tag legacy aliases`,
    );
  const lib = await fetchText(tag, FEATURES_LIB);
  const prevSnapshot = fSnapshotOf(ftags.latest);
  const prevLib = readFileSync(join(featuresDir, "sources", prevSnapshot, "lib.rs"), "utf8");
  if (lib === prevLib) {
    ftags.snapshot_aliases[tag] = prevSnapshot;
    console.log(`features ${tag}: lib.rs identical to ${prevSnapshot} (alias)`);
  } else {
    mkdirSync(join(featuresDir, "sources", tag), { recursive: true });
    writeFileSync(join(featuresDir, "sources", tag, "lib.rs"), lib);
    console.log(`features ${tag}: vendored lib.rs`);
  }
  ftags.verified_tags.push(tag);
  ftags.latest = tag;
}
writeJson(join(featuresDir, "tags.json"), ftags);

// ── Schema sources ───────────────────────────────────────────────────────────
const sSnapshotOf = (tag) => stags.snapshot_aliases[tag] ?? tag;
const schemaChanges = [];
let latestSchemaFiles = null;
for (const tag of schemaTags) {
  const files = await fetchSchemaSources(tag);
  latestSchemaFiles = files;
  const prevSnapshot = sSnapshotOf(stags.latest);
  const previous = readSchemaSnapshot(prevSnapshot, [...files.keys()]);
  if (sameFiles(previous, files)) {
    stags.snapshot_aliases[tag] = prevSnapshot;
    console.log(`schema ${tag}: sources identical to ${prevSnapshot} (alias)`);
  } else {
    const dir = join(schemaDir, "sources", tag);
    for (const [path, text] of files) {
      const local = join(dir, schemaLocalName(path));
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, text);
    }
    writeFileSync(join(dir, "models.json"), await fetchText(tag, BUNDLED_MODELS));
    // Compare file by file against the previous snapshot's directory (it may lack a submodule).
    const prevDir = join(schemaDir, "sources", prevSnapshot);
    const changed = [...files.keys()].map(schemaLocalName).filter((name) => {
      const local = join(prevDir, name);
      return (
        !existsSync(local) ||
        readFileSync(local, "utf8") !== files.get(`codex-rs/protocol/src/${name}`)
      );
    });
    schemaChanges.push({ tag, previous: prevSnapshot, changed });
    console.log(
      `schema ${tag}: vendored ${files.size} files (new or changed: ${changed.join(", ")})`,
    );
  }
  stags.verified_tags.push(tag);
  stags.latest = tag;
}
if (latestSchemaFiles) {
  stags.source_files = [...latestSchemaFiles.keys()];
  writeJson(join(schemaDir, "tags.json"), stags);
}

// ── Regenerate ───────────────────────────────────────────────────────────────
execFileSync(process.execPath, [join(root, "scripts", "extract-features.mjs")], {
  stdio: "inherit",
});
execFileSync(process.execPath, [join(root, "scripts", "build-static.mjs")], { stdio: "inherit" });

// ── Summary ──────────────────────────────────────────────────────────────────
const registry = readJson(join(featuresDir, ftags.registry));
const flagsAt = (tag) => new Map(registry.tags[fSnapshotOf(tag)].flags.map((f) => [f.key, f]));
const lines = [];
lines.push(`## Codex tag sync: ${featureTags.at(-1) ?? schemaTags.at(-1)}`, "");
if (featureTags.length > 0) {
  lines.push(`### Feature flags (${previousFeatureLatest} → ${ftags.latest})`, "");
  let prev = previousFeatureLatest;
  for (const tag of featureTags) {
    const before = flagsAt(prev);
    const after = flagsAt(tag);
    const rows = [];
    for (const [key, flag] of after) {
      const old = before.get(key);
      if (!old)
        rows.push(
          `- added \`${key}\` (${flag.stage}, default ${flag.default_enabled ?? flag.default_expr})`,
        );
      else if (old.stage !== flag.stage) rows.push(`- \`${key}\`: ${old.stage} → ${flag.stage}`);
      else if (old.default_enabled !== flag.default_enabled)
        rows.push(`- \`${key}\`: default ${old.default_enabled} → ${flag.default_enabled}`);
    }
    for (const key of before.keys()) if (!after.has(key)) rows.push(`- delisted \`${key}\``);
    const how =
      tag in ftags.snapshot_aliases ? ` (lib.rs identical to ${ftags.snapshot_aliases[tag]})` : "";
    lines.push(`**${tag}**${how}${rows.length === 0 ? ": no flag changes" : ""}`, ...rows, "");
    prev = tag;
  }
  const annotated = new Set(
    readdirSync(annotationsDir)
      .filter((name) => name.endsWith(".json"))
      .filter((name) => readJson(join(annotationsDir, name)).i18n?.zh)
      .map((name) => name.replace(/\.json$/, "")),
  );
  const missing = [...flagsAt(ftags.latest).values()].filter((f) => !annotated.has(f.key));
  lines.push(`### Flags at ${ftags.latest} without a zh annotation: ${missing.length}`, "");
  for (const flag of missing)
    lines.push(`- \`${flag.key}\` (${flag.stage}): ${flag.doc ?? "no rustdoc"}`);
  lines.push("");
}
if (schemaTags.length > 0) {
  lines.push(`### ModelInfo schema sources (→ ${stags.latest})`, "");
  if (schemaChanges.length === 0) lines.push("No source changes; every new tag is an alias.", "");
  for (const change of schemaChanges)
    lines.push(
      `- **${change.tag}** vs ${change.previous}: ${change.changed.join(", ")} new or changed. Review the struct diff and update codex-model-info.schema.json and the tags.json notes.`,
    );
  lines.push("");
}
const summary = `${lines.join("\n").trim()}\n`;
console.log(`\n${summary}`);
if (summaryPath) writeFileSync(summaryPath, summary);
