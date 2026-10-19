#!/usr/bin/env node
// Draft zh feature-flag annotations with a local model CLI (kimi or agy) on a maintainer machine.
// CI does not draft: no model key is stored in GitHub. scripts/draft-sync-pr.mjs runs this on the
// tag sync pull request's branch. Two kinds of work:
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
// Usage: node scripts/draft-annotations.mjs [--since rust-vX.Y.Z] [--cli kimi,agy] [--report <file>] [--dry-run]
//   --since    also revisit annotations of flags whose stage changed after this tag
//   --cli      CLIs to try in order until one returns a valid answer (default kimi,agy; also
//              CODEXDATA_DRAFT_CLI). Each runs in an empty temporary directory with no tools needed.
//              Binaries: KIMI_BIN (default kimi on PATH, then ~/.kimi-code/bin/kimi), AGY_BIN
//              (default agy). Models: KIMI_MODEL (default kimi-code/kimi-for-coding), AGY_MODEL
//              (default gemini-4-argon-high).
//   --report   write a Markdown list of the drafted files (for the pull request body)
//   --dry-run  print the prompt instead of calling a CLI
// Exit codes: 0 = drafted or nothing to do; 1 = failure (no CLI gave a valid answer).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const featuresDir = join(root, "data", "codex-features");
const annotationsDir = join(featuresDir, "annotations");

// Fifteen minutes per CLI: a draft of a dozen flags takes one to three.
const CLI_TIMEOUT_MS = 15 * 60 * 1000;
// Style examples: one per kind of entry (product name, acronym left unconfirmed, requirements-only
// gate, removed compatibility flag, deprecated no-op, platform-conditional default) plus two that
// show the zh terms for Code Mode and subagents.
const EXAMPLE_KEYS = [
  "chronicle",
  "psp",
  "in_app_browser",
  "apply_patch_freeform",
  "transcript_v2",
  "secret_auth_storage",
  "worktrees",
  "code_mode",
  "multi_agent_v2_dynamic_tools",
];

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const since = argValue("--since");
const reportPath = argValue("--report");
const dryRun = args.includes("--dry-run");
const cliOrder = (argValue("--cli") ?? process.env.CODEXDATA_DRAFT_CLI ?? "kimi,agy")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

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
- title: a short zh name for the flag, usually 2 to 8 characters, in everyday words. Keep English
  only for product names (Guardian, Daybreak, ChatGPT) and acronyms the rustdoc does not expand.
- summary: one short, plain zh sentence that states what the flag does, faithful to the rustdoc.
  Do not restate the stage or the default, except that removed and deprecated flags say so (see
  the examples).
- Use the same zh terms as the examples: Code Mode = 代码模式, agent = 助手, subagent = 子助手,
  compaction = 压缩, context window = 上下文窗口, network proxy = 网络代理. Write formal, polite
  Chinese.
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
(changed = true). A move to stable alone does not make a block wrong; keep the existing note. For a flag in "draft", always return a block (changed = true).`;

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

const prompt = `${SYSTEM}

Do not use any tools, read files or run commands; everything you need is below. Reply with one JSON
object that matches this JSON Schema, with no prose and no code fence:
${JSON.stringify(OUTPUT_SCHEMA)}

Annotate these Codex feature flags. Return one entry per flag in "draft" and "revisit".

${JSON.stringify(request, null, 2)}`;

if (dryRun) {
  console.log(prompt);
  process.exit(0);
}

const outputValidator = new Validator(OUTPUT_SCHEMA, "2020-12", false);

// The span from the first "{" to the last "}" of a reply: drops prose or a code fence around it.
const parseReply = (text) => {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last < first) throw new Error("no JSON object in the reply");
  return JSON.parse(text.slice(first, last + 1));
};

const onPath = (name) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, name)));

const CLIS = {
  kimi: {
    model: process.env.KIMI_MODEL ?? "kimi-code/kimi-for-coding",
    bin: () =>
      process.env.KIMI_BIN ??
      (onPath("kimi") ? "kimi" : join(homedir(), ".kimi-code", "bin", "kimi")),
    args: (model, text) => ["-p", text, "-m", model, "--output-format", "stream-json"],
    // stream-json: one message per line; the answer is the last assistant message.
    answer: (stdout) => {
      let content;
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        const message = JSON.parse(line);
        if (message.role === "assistant" && message.content) content = message.content;
      }
      if (content === undefined) throw new Error("no assistant message");
      const text = Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : (part.text ?? ""))).join("")
        : String(content);
      return parseReply(text);
    },
  },
  agy: {
    model: process.env.AGY_MODEL ?? "gemini-4-argon-high",
    bin: () => process.env.AGY_BIN ?? "agy",
    args: (model, text) => [
      "--print",
      text,
      "--model",
      model,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(OUTPUT_SCHEMA),
    ],
    // json: one result object; structured_output holds the schema-checked answer.
    answer: (stdout) => {
      const lines = stdout.trim().split("\n");
      const result = JSON.parse(lines[lines.length - 1]);
      if (result.status !== "SUCCESS") throw new Error(`status ${result.status}`);
      return result.structured_output ?? parseReply(result.response ?? "");
    },
  },
};

let drafted;
let draftedBy;
for (const name of cliOrder) {
  const cli = CLIS[name];
  if (!cli) {
    console.error(`unknown CLI ${name} (known: ${Object.keys(CLIS).join(", ")})`);
    process.exit(1);
  }
  // An empty working directory: an agent CLI that ignores "no tools" finds nothing to change.
  const cwd = mkdtempSync(join(tmpdir(), "codexdata-draft-"));
  const started = Date.now();
  console.log(
    `drafting ${missing.length} new + ${revisit.length} revisited with ${name} (${cli.model})`,
  );
  const run = spawnSync(cli.bin(), cli.args(cli.model, prompt), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  rmSync(cwd, { recursive: true, force: true });
  const seconds = Math.round((Date.now() - started) / 1000);
  try {
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`exit ${run.status}`);
    const answer = cli.answer(run.stdout);
    const verdict = outputValidator.validate(answer);
    if (!verdict.valid)
      throw new Error(`reply fails the output schema: ${verdict.errors.at(-1)?.error}`);
    drafted = answer.annotations;
    draftedBy = `${name} (${cli.model})`;
    console.log(`${name}: answered in ${seconds} s`);
    break;
  } catch (error) {
    const tail = (run.stderr ?? "").trim().split("\n").slice(-5).join("\n");
    console.error(
      `${name}: no valid answer after ${seconds} s: ${error.message}${tail ? `\n${tail}` : ""}`,
    );
  }
}
if (!drafted) {
  console.error(`no CLI gave a valid answer (tried ${cliOrder.join(", ")})`);
  process.exit(1);
}

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
  `### Annotations drafted by ${draftedBy}: ${written.length}`,
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
