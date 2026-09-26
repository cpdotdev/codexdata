#!/usr/bin/env node
// Validate data/codex-schema: the schema itself compiles; every tag in tags.json has a source
// snapshot; the bundled models.json in each snapshot (the catalog built into the Codex binary) must
// pass the schema.
// Also validate data/codex-features: source snapshots are complete; registry.json matches the
// extractor output (determinism); annotations/ pass the schema file by file, filename matches key,
// key exists in the registry.
// Node ≥ 22, same validator as the Worker (@cfworker/json-schema) so both sides agree on what
// "valid" means.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(root, "data", "codex-schema");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`✗ ${message}`);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

const tags = readJson(join(schemaDir, "tags.json"));
const schemaPath = join(schemaDir, tags.schema);
const schema = readJson(schemaPath);
const validator = new Validator(schema, "2020-12", false);
ok(`schema compiled: ${tags.schema}`);

if (!tags.verified_tags.includes(tags.latest))
  fail(`latest tag ${tags.latest} not in verified_tags`);

for (const tag of tags.verified_tags) {
  const dir = join(schemaDir, "sources", tag);
  // The 0.153.1 and 0.153.4 sources are byte-identical; only the 0.153.4 snapshot is kept.
  if (tag === "rust-v0.153.1") continue;
  for (const file of tags.source_files) {
    const name = file.split("/").pop();
    if (!existsSync(join(dir, name))) fail(`${tag}: missing source snapshot ${name}`);
  }
  const bundled = join(dir, "models.json");
  if (existsSync(bundled)) {
    const result = validator.validate(readJson(bundled));
    if (result.valid)
      ok(`${tag}/models.json validates (${readJson(bundled).models.length} models)`);
    else {
      const first = result.errors
        .slice()
        .sort((a, b) => b.instanceLocation.length - a.instanceLocation.length)[0];
      fail(`${tag}/models.json rejected: ${first.instanceLocation} ${first.error}`);
    }
  }
}

// Negative cases: a misspelling in any closed enum must be rejected (otherwise the schema degrades
// into an existence check).
const sample = readJson(join(schemaDir, "sources", tags.latest, "models.json")).models[0];
const negatives = {
  "shell_type typo": { ...sample, shell_type: "shell" },
  "empty effort": { ...sample, supported_reasoning_levels: [{ effort: "", description: "x" }] },
  "no prompt": { ...sample, base_instructions: undefined, model_messages: null },
};
for (const [label, model] of Object.entries(negatives)) {
  const result = validator.validate({ models: [JSON.parse(JSON.stringify(model))] });
  if (result.valid) fail(`negative case accepted: ${label}`);
  else ok(`negative case rejected: ${label}`);
}

// ── data/codex-features ──────────────────────────────────────────────────────
const featuresDir = join(root, "data", "codex-features");
const ftags = readJson(join(featuresDir, "tags.json"));

if (!ftags.verified_tags.includes(ftags.latest))
  fail(`features: latest tag ${ftags.latest} not in verified_tags`);
for (const [alias, target] of Object.entries(ftags.snapshot_aliases)) {
  if (!ftags.verified_tags.includes(alias) || !ftags.verified_tags.includes(target))
    fail(`features: snapshot alias ${alias} -> ${target} references unverified tag`);
}
if (!existsSync(join(featuresDir, "sources", "legacy.rs")))
  fail("features: missing source snapshot sources/legacy.rs");
for (const tag of ftags.verified_tags) {
  if (tag in ftags.snapshot_aliases) continue; // byte-identical to its snapshot tag, not stored separately
  if (!existsSync(join(featuresDir, "sources", tag, "lib.rs")))
    fail(`features: missing source snapshot sources/${tag}/lib.rs`);
}

// registry.json must match the extractor's output for the source snapshots byte for byte (guards
// against hand edits and drift).
const extract = spawnSync(
  process.execPath,
  [join(root, "scripts", "extract-features.mjs"), "--check"],
  { encoding: "utf8" },
);
if (extract.status === 0) ok("features: registry.json matches extractor output");
else fail(`features: registry.json out of date\n${extract.stderr || extract.stdout}`.trim());

// The static dataset artifacts under public/ (features / schema / _headers) must likewise match the
// data sources.
const staticBuild = spawnSync(
  process.execPath,
  [join(root, "scripts", "build-static.mjs"), "--check"],
  { encoding: "utf8" },
);
if (staticBuild.status === 0) ok("static: public/ dataset artifacts match build output");
else
  fail(`static: public/ artifacts out of date\n${staticBuild.stderr || staticBuild.stdout}`.trim());

const registry = readJson(join(featuresDir, ftags.registry));
// Human annotations: one file per flag (annotations/<key>.json). Validate file by file: valid JSON,
// passes the schema, key matches the filename, key exists in the registry (guards against typos).
const annotationsSchema = readJson(join(featuresDir, "annotations.schema.json"));
const annValidator = new Validator(annotationsSchema, "2020-12", false);
const knownKeys = new Set(Object.keys(registry.history));
const annDir = join(featuresDir, ftags.annotations);
const annotations = {};
let annBad = 0;
for (const name of readdirSync(annDir).sort()) {
  const reject = (message) => {
    fail(`features: annotations/${name}: ${message}`);
    annBad += 1;
  };
  if (!name.endsWith(".json")) {
    reject("not a .json file");
    continue;
  }
  let entry;
  try {
    entry = readJson(join(annDir, name));
  } catch (error) {
    reject(`not valid JSON: ${error.message}`);
    continue;
  }
  const result = annValidator.validate(entry);
  if (!result.valid) {
    const first = result.errors
      .slice()
      .sort((a, b) => b.instanceLocation.length - a.instanceLocation.length)[0];
    reject(`schema rejected: ${first.instanceLocation} ${first.error}`);
    continue;
  }
  if (`${entry.key}.json` !== name) {
    reject(`key \`${entry.key}\` does not match the filename`);
    continue;
  }
  if (!knownKeys.has(entry.key)) {
    reject(`flag \`${entry.key}\` does not exist in the registry (typo?)`);
    continue;
  }
  annotations[entry.key] = entry;
}
if (annBad === 0)
  ok(
    `features: ${Object.keys(annotations).length} annotation files validate (schema + filename + registry key)`,
  );

const latestSnapshot = ftags.snapshot_aliases[ftags.latest] ?? ftags.latest;
const latestFlags = registry.tags[latestSnapshot].flags;
const missingZh = latestFlags.filter((flag) => !annotations[flag.key]?.i18n?.zh).map((f) => f.key);
// A new tag may introduce flags whose annotations are still missing: warn but do not fail (gaps are
// normal; the UI degrades them to "not annotated").
if (missingZh.length > 0)
  console.log(
    `⚠ features: ${missingZh.length} flag(s) at ${ftags.latest} lack a zh annotation: ${missingZh.join(", ")}`,
  );
else
  ok(`features: every flag at ${ftags.latest} has a zh annotation (${latestFlags.length} flags)`);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
