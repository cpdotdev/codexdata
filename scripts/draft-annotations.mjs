#!/usr/bin/env node
// Draft zh feature-flag annotations with Claude, for the automated tag sync
// (.github/workflows/codex-tags-sync.yml). Two kinds of work:
//   1. flags at the latest tag that have no zh annotation → a new annotations/<key>.json;
//   2. with --since <tag>: flags whose stage changed after that tag and that already have a zh
//      annotation → the model revisits the zh block and keeps it unless it is now wrong (for
//      example a flag that became removed or deprecated). aka and other locales are kept.
// Grounding (CONTRIBUTING.md "Honesty rules"): the prompt carries only the registry's machine facts
// (rustdoc, OpenAI's own menu copy, stage history) plus existing annotations as style examples.
// The model must not add behavior the facts do not state and must mark unexplained terms as
// unconfirmed. Every written file passes annotations.schema.json; a human reviews the drafts in the
// sync pull request before they are published.
//
// Usage: ANTHROPIC_API_KEY=… node scripts/draft-annotations.mjs [--since rust-vX.Y.Z] [--report <file>] [--dry-run]
//   --since    also revisit annotations of flags whose stage changed after this tag
//   --report   write a Markdown list of the drafted files (for the pull request body)
//   --dry-run  print the request instead of calling the API
// Exit codes: 0 = drafted or nothing to do; 1 = failure; 2 = the model declined (refusal).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Validator } from "@cfworker/json-schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const featuresDir = join(root, "data", "codex-features");
const annotationsDir = join(featuresDir, "annotations");

const MODEL = "claude-opus-5-5";
// Style examples: one per kind of entry (product name, acronym left unconfirmed, requirements-only
// gate, removed compatibility flag, deprecated no-op, platform-conditional default).
const EXAMPLE_KEYS = [
  "chronicle",
  "psp",
  "in_app_browser",
  "apply_patch_freeform",
  "transcript_v2",
  "secret_auth_storage",
  "worktrees",
];

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const since = argValue("--since");
const reportPath = argValue("--report");
const dryRun = args.includes("--dry-run");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const tags = readJson(join(featuresDir, "tags.json"));
const registry = readJson(join(featuresDir, tags.registry));
const snapshotOf = (tag) => tags.snapshot_aliases[tag] ?? tag;
const latestFlags = registry.tags[snapshotOf(tags.latest)].flags;

const annotations = new Map(
  readdirSync(annotationsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [name.replace(/\.json$/, ""), readJson(join(annotationsDir, name))]),
);

const facts = (flag) => ({
  key: flag.key,
  stage: flag.stage,
  default_enabled: flag.default_enabled ?? flag.default_expr,
  rustdoc: flag.doc,
  official_menu_copy: flag.experimental
    ? { name: flag.experimental.name, description: flag.experimental.menu_description }
    : null,
  stage_history: registry.history[flag.key]?.stages ?? [],
});

const missing = latestFlags.filter((flag) => !annotations.get(flag.key)?.i18n?.zh);
let revisit = [];
if (since) {
  const order = tags.verified_tags;
  const after = order.indexOf(since);
  if (after < 0) throw new Error(`--since ${since} is not a verified tag`);
  const newer = new Set(order.slice(after + 1));
  // The first history entry is the flag's first appearance, not a stage change.
  revisit = latestFlags.filter(
    (flag) =>
      annotations.get(flag.key)?.i18n?.zh &&
      (registry.history[flag.key]?.stages ?? []).slice(1).some((change) => newer.has(change.at)),
  );
}

if (missing.length + revisit.length === 0) {
  console.log("no annotations to draft");
  if (reportPath) writeFileSync(reportPath, "");
  process.exit(0);
}

const SYSTEM = `You write the Simplified Chinese (zh) annotation layer of CodexData, an open dataset that
explains the [features] flags of the OpenAI Codex client. Codex Pass shows these annotations next to
each flag in its settings page.

Each annotation has:
- title: a short zh name for the flag (at most about 20 characters). Keep English product names and
  code identifiers as they are.
- summary: one zh sentence that states what the flag does, faithful to the rustdoc. Do not restate
  the stage or the default, except that removed and deprecated flags say so (see the examples).
- note: optional extra context in zh, or an empty string. Use it for facts the summary has no room
  for: a requirements-only gate, an acronym the rustdoc does not expand ("源码未展开 X 缩写，具体含义
  未确认。"), or what a removed flag used to do.

Honesty rules (this is the review bar):
- Use only the facts in the request: the rustdoc, OpenAI's own menu copy and the stage history. Do
  not add behavior, motivation or product context that these facts do not state.
- If a term or acronym is not explained by the facts, say in note that its meaning is unconfirmed.
- These annotations are community commentary, not OpenAI documentation. Write plain, neutral
  technical Chinese like the examples.

For a flag in "revisit", an existing zh block is given. Keep it (changed = false) unless it is now
wrong or misleading given the current stage and rustdoc; then return a corrected block
(changed = true). For a flag in "draft", always return a block (changed = true).`;

const examples = EXAMPLE_KEYS.filter((key) => annotations.get(key)?.i18n?.zh).map((key) => {
  const flag = latestFlags.find((f) => f.key === key) ?? null;
  return { facts: flag ? facts(flag) : { key }, zh: annotations.get(key).i18n.zh };
});

const request = {
  examples,
  draft: missing.map(facts),
  revisit: revisit.map((flag) => ({
    ...facts(flag),
    existing_zh: annotations.get(flag.key).i18n.zh,
  })),
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    annotations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          changed: { type: "boolean" },
          title: { type: "string" },
          summary: { type: "string" },
          note: { type: "string" },
        },
        required: ["key", "changed", "title", "summary", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["annotations"],
  additionalProperties: false,
};

const params = {
  model: MODEL,
  max_tokens: 16000,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  system: SYSTEM,
  messages: [
    {
      role: "user",
      content: `Annotate these Codex feature flags. Return one entry per flag in "draft" and "revisit".\n\n${JSON.stringify(request, null, 2)}`,
    },
  ],
};

if (dryRun) {
  console.log(JSON.stringify(params, null, 2));
  process.exit(0);
}

const client = new Anthropic();
let response;
try {
  response = await client.beta.messages.create(params);
} catch (error) {
  if (error instanceof Anthropic.APIError) {
    console.error(`Claude API error ${error.status ?? ""}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
console.log(
  `request ${response._request_id ?? "?"}: served by ${response.model}, stop ${response.stop_reason}`,
);
if (response.stop_reason === "refusal") {
  console.error(`declined: ${response.stop_details?.category ?? "no category"}`);
  process.exit(2);
}
if (response.stop_reason !== "end_turn") {
  console.error(`unexpected stop_reason ${response.stop_reason}`);
  process.exit(1);
}
const text = response.content
  .filter((block) => block.type === "text")
  .map((block) => block.text)
  .join("");
const drafted = JSON.parse(text).annotations;

// ── Write and validate ───────────────────────────────────────────────────────
const requested = new Map([
  ...missing.map((flag) => [flag.key, { flag, kind: "draft" }]),
  ...revisit.map((flag) => [flag.key, { flag, kind: "revisit" }]),
]);
const validator = new Validator(
  readJson(join(featuresDir, "annotations.schema.json")),
  "2020-12",
  false,
);
const written = [];
for (const entry of drafted) {
  const target = requested.get(entry.key);
  if (!target) {
    console.error(`ignoring unrequested key ${entry.key}`);
    continue;
  }
  requested.delete(entry.key);
  if (target.kind === "revisit" && !entry.changed) continue;
  const zh = { title: entry.title.trim(), summary: entry.summary.trim() };
  if (entry.note.trim()) zh.note = entry.note.trim();
  const existing = annotations.get(entry.key);
  const aka = existing?.aka ?? target.flag.experimental?.name;
  const body = {
    key: entry.key,
    ...(aka ? { aka } : {}),
    i18n: { ...existing?.i18n, zh },
  };
  const verdict = validator.validate(body);
  if (!verdict.valid) {
    console.error(
      `${entry.key}: drafted annotation fails the schema: ${verdict.errors.at(-1)?.error}`,
    );
    process.exit(1);
  }
  writeFileSync(join(annotationsDir, `${entry.key}.json`), `${JSON.stringify(body, null, 2)}\n`);
  written.push({ key: entry.key, kind: target.kind, zh });
}
const skipped = [...requested.keys()];
if (skipped.length > 0) console.error(`no draft returned for: ${skipped.join(", ")}`);

const lines = [
  `### Annotations drafted by ${MODEL}: ${written.length}`,
  "",
  "Machine drafts from the rustdoc and menu copy. Check each one against the flag facts above before merging.",
  "",
  ...written.map(
    ({ key, kind, zh }) =>
      `- \`${key}\` (${kind === "draft" ? "new" : "updated for a stage change"}): **${zh.title}**: ${zh.summary}${zh.note ? ` _${zh.note}_` : ""}`,
  ),
  ...(skipped.length > 0
    ? ["", `No draft returned for: ${skipped.map((k) => `\`${k}\``).join(", ")}`]
    : []),
];
const report = `${lines.join("\n")}\n`;
console.log(report);
if (reportPath) writeFileSync(reportPath, report);
