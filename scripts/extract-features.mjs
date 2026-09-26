#!/usr/bin/env node
// Extract the feature-flag registry from the client source snapshots under
// data/codex-features/sources/ → registry.json.
// Parse targets (see tags.json.notes): the rustdoc on `pub enum Feature`, the `pub const FEATURES`
// table (key / stage / default_enabled / the official menu copy for Experimental), and the legacy
// key aliases in legacy.rs.
// Parsing is strictly validated block by block: any FeatureSpec block missing a field, or a mismatch
// against the `FeatureSpec {` count, aborts with an error — when upstream changes its layout,
// failing beats emitting wrong data.
//
// Usage: node scripts/extract-features.mjs         regenerate registry.json
//        node scripts/extract-features.mjs --check  verify only (output differs from the committed file → exit 1)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const featuresDir = join(root, "data", "codex-features");
const tags = JSON.parse(readFileSync(join(featuresDir, "tags.json"), "utf8"));

const STAGE_NAMES = {
  UnderDevelopment: "under development",
  Stable: "stable",
  Experimental: "experimental",
  Deprecated: "deprecated",
  Removed: "removed",
};

/** Rust string literal → JS string (handles only the common escapes that actually occur in the
 *  sources). */
function unescapeRust(raw) {
  return raw.replace(/\\(["'\\nrt0])/g, (_, c) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c === "0" ? "\0" : c,
  );
}

/** Read a single string field: `name: "..."` (must be one line; the capture group handles \"
 *  escapes). */
function stringField(block, field, context) {
  const m = block.match(new RegExp(`${field}: "((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) throw new Error(`${context}: missing string field ${field}`);
  return unescapeRust(m[1]);
}

/** Parse `pub enum Feature { ... }`: variant name → rustdoc (multi-line docs joined into one
 *  paragraph). */
function parseEnumDocs(text) {
  const start = text.indexOf("pub enum Feature {");
  if (start < 0) throw new Error("`pub enum Feature {` not found");
  const end = text.indexOf("\n}", start);
  const body = text.slice(start, end);
  const docs = new Map();
  let buf = [];
  for (const line of body.split("\n")) {
    const doc = line.match(/^\s*\/\/\/ ?(.*)$/);
    if (doc) {
      buf.push(doc[1]);
      continue;
    }
    const variant = line.match(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (variant) {
      docs.set(variant[1], buf.length > 0 ? buf.join(" ").replace(/\s+/g, " ").trim() : null);
      buf = [];
    }
    // Plain `//` grouping comments and blank lines: ignored (a rustdoc block and its variant may not
    // be separated by a blank line, so docs cannot attach to the wrong variant).
  }
  if (docs.size === 0) throw new Error("enum Feature yielded no variants");
  return docs;
}

/** Parse the `pub const FEATURES: &[FeatureSpec] = &[ ... ];` table. */
function parseFeaturesTable(text, docs) {
  const start = text.indexOf("pub const FEATURES: &[FeatureSpec] = &[");
  if (start < 0) throw new Error("`pub const FEATURES` not found");
  const end = text.indexOf("\n];", start);
  const body = text.slice(start, end);
  const expected = (body.match(/FeatureSpec \{/g) ?? []).length;

  const flags = [];
  // Entry boundaries: from a 4-space-indented `    FeatureSpec {` to a 4-space-indented `    },`
  // (the nested Stage::Experimental { ... } closes at 8-space indentation, so it cannot cut an
  // entry short).
  const entryRe = /^ {4}FeatureSpec \{\n([\s\S]*?)^ {4}\},$/gm;
  for (const [, block] of body.matchAll(entryRe)) {
    const context = block.trim().split("\n")[0];
    const id = block.match(/id: Feature::([A-Za-z0-9]+),/);
    const key = block.match(/key: "([a-z0-9_]+)",/);
    const def = block.match(/default_enabled: (true|false|[a-z_!()"= ]+),/);
    if (!id || !key || !def) throw new Error(`FeatureSpec block is missing fields: ${context}`);
    if (!docs.has(id[1]))
      throw new Error(`FEATURES references variant ${id[1]}, which does not exist in the enum`);

    let stage;
    let experimental = null;
    let stageCondition = null;
    let stageFallback = null;
    const stageOf = (body, allowExperimental) => {
      const plain = body.match(/Stage::(UnderDevelopment|Stable|Deprecated|Removed)/);
      if (plain) return { stage: STAGE_NAMES[plain[1]], experimental: null };
      if (allowExperimental && body.includes("Stage::Experimental {")) {
        return {
          stage: STAGE_NAMES.Experimental,
          experimental: {
            name: stringField(body, "name", context),
            menu_description: stringField(body, "menu_description", context),
            announcement: stringField(body, "announcement", context) || null,
          },
        };
      }
      throw new Error(`unrecognized stage: ${context}`);
    };
    if (block.includes("stage: if cfg!(")) {
      // Platform-conditional stage (e.g. prevent_idle_sleep): stage comes from the branch where cfg
      // is true (the listed desktop platforms); the condition text and the else branch are kept
      // verbatim in stage_condition / stage_fallback.
      const ifStart = block.indexOf("stage: if ");
      const condEnd = block.indexOf(") {", ifStart) + 1;
      const elseStart = block.indexOf("} else {", condEnd);
      const stageEnd = block.indexOf("\n        },", elseStart);
      if (condEnd === 0 || elseStart < 0 || stageEnd < 0)
        throw new Error(`conditional stage has an unexpected structure: ${context}`);
      stageCondition = block
        .slice(ifStart + "stage: if ".length, condEnd)
        .replace(/\s+/g, " ")
        .trim();
      const ifBranch = stageOf(block.slice(condEnd, elseStart), true);
      stage = ifBranch.stage;
      experimental = ifBranch.experimental;
      stageFallback = stageOf(block.slice(elseStart, stageEnd), false).stage;
    } else {
      const plain = block.match(/stage: Stage::(UnderDevelopment|Stable|Deprecated|Removed),/);
      if (plain) {
        stage = STAGE_NAMES[plain[1]];
      } else if (block.includes("stage: Stage::Experimental {")) {
        const parsed = stageOf(block, true);
        stage = parsed.stage;
        experimental = parsed.experimental;
      } else {
        throw new Error(`unrecognized stage: ${context}`);
      }
    }

    const flag = {
      key: key[1],
      variant: id[1],
      stage,
      default_enabled: def[1] === "true" ? true : def[1] === "false" ? false : null,
      doc: docs.get(id[1]),
      experimental,
    };
    if (flag.default_enabled === null) flag.default_expr = def[1];
    if (stageCondition) {
      flag.stage_condition = stageCondition;
      flag.stage_fallback = stageFallback;
    }
    flags.push(flag);
  }
  if (flags.length !== expected)
    throw new Error(
      `FEATURES table parsed incompletely: expected ${expected} entries, got ${flags.length}`,
    );
  const dup = flags.map((f) => f.key).find((k, i, all) => all.indexOf(k) !== i);
  if (dup) throw new Error(`duplicate flag key: ${dup}`);
  flags.sort((a, b) => (a.key < b.key ? -1 : 1));
  return flags;
}

/** `ALIASES` in legacy.rs: legacy config key → Feature variant name. */
function parseLegacyAliases(text) {
  const aliases = [];
  for (const [, legacyKey, variant] of text.matchAll(
    /legacy_key: "([a-z0-9_]+)",\s*feature: Feature::([A-Za-z0-9]+),/g,
  )) {
    aliases.push({ legacyKey, variant });
  }
  const expected = (text.match(/legacy_key: "/g) ?? []).length;
  if (aliases.length !== expected)
    throw new Error(
      `legacy ALIASES parsed incompletely: expected ${expected}, got ${aliases.length}`,
    );
  return aliases;
}

// ── Extract each snapshot tag ────────────────────────────────────────────────
const legacyAliases = parseLegacyAliases(
  readFileSync(join(featuresDir, "sources", "legacy.rs"), "utf8"),
);
const snapshotTags = tags.verified_tags.filter((tag) => !(tag in tags.snapshot_aliases));
const byTag = {};
for (const tag of snapshotTags) {
  const text = readFileSync(join(featuresDir, "sources", tag, "lib.rs"), "utf8");
  const flags = parseFeaturesTable(text, parseEnumDocs(text));
  const variantToKey = new Map(flags.map((f) => [f.variant, f.key]));
  const legacy = {};
  for (const { legacyKey, variant } of legacyAliases) {
    // This tag has no such variant (the legacy alias points at a flag added later or already
    // deleted) → null; keep the fact.
    legacy[legacyKey] = variantToKey.get(variant) ?? null;
  }
  byTag[tag] = {
    flags,
    legacy_aliases: Object.fromEntries(Object.entries(legacy).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

// ── Cross-tag history (in verified_tags order; alias tags count as their snapshot) ───────────
const orderedTags = tags.verified_tags;
const snapshotOf = (tag) => tags.snapshot_aliases[tag] ?? tag;
const history = {};
for (const tag of orderedTags) {
  for (const flag of byTag[snapshotOf(tag)].flags) {
    const entry = (history[flag.key] ??= {
      first_seen: tag,
      last_seen: tag,
      stages: [{ at: tag, stage: flag.stage }],
    });
    entry.last_seen = tag;
    if (entry.stages.at(-1).stage !== flag.stage) entry.stages.push({ at: tag, stage: flag.stage });
  }
}
for (const [key, entry] of Object.entries(history)) {
  // Vanishing from the table entirely (key deleted, not marked removed) is also a fact: record
  // delisted_after.
  if (entry.last_seen !== orderedTags.at(-1)) entry.delisted_after = entry.last_seen;
  history[key] = entry;
}

const registry = {
  generated_by: "scripts/extract-features.mjs",
  source_files: tags.source_files,
  tags: Object.fromEntries(snapshotTags.map((tag) => [tag, byTag[tag]])),
  history: Object.fromEntries(Object.entries(history).sort(([a], [b]) => (a < b ? -1 : 1))),
};
const output = `${JSON.stringify(registry, null, 2)}\n`;

const registryPath = join(featuresDir, tags.registry);
if (process.argv.includes("--check")) {
  let committed = null;
  try {
    committed = readFileSync(registryPath, "utf8");
  } catch {
    /* a missing file counts as a mismatch */
  }
  if (committed !== output) {
    console.error(
      "✗ registry.json does not match the extraction from the source snapshots; run scripts/extract-features.mjs to regenerate",
    );
    process.exit(1);
  }
  console.log(
    `✓ registry.json matches the extractor output (${snapshotTags.length} snapshot tags)`,
  );
} else {
  writeFileSync(registryPath, output);
  for (const tag of snapshotTags) {
    const { flags } = byTag[tag];
    const stages = flags.reduce((acc, f) => ((acc[f.stage] = (acc[f.stage] ?? 0) + 1), acc), {});
    console.log(`${tag}: ${flags.length} flags ${JSON.stringify(stages)}`);
  }
  console.log(`written: ${registryPath}`);
}
