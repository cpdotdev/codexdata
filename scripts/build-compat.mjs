#!/usr/bin/env node
// Combine the three kinds of facts under data/codex-compat/ into the public compatibility JSON:
//   tracked.json (managed key list + human rulings) + probes/<version>.json (probe hard facts)
//   + advisories/*.json (human advisories) → public/v1/compat/codex/latest.json
// Key status derivation: statusOverride wins; otherwise probe=none → unprobed; present in the latest
// stable probe → active; present in an earlier version but gone in the latest → missing (with
// firstMissingIn, pending human confirmation as removed); never seen → missing.
// The artifact is deterministic (no timestamps); --check compares byte for byte to catch drift; the
// publish time is recorded by the KV publish endpoint.
//
// Usage: node scripts/build-compat.mjs          regenerate
//        node scripts/build-compat.mjs --check  verify only (differs from the committed file → exit 1)

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compatDir = join(root, "data", "codex-compat");
const outPath = join(root, "public", "v1", "compat", "codex", "latest.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function versionCore(version) {
  const parts = version
    .split(/[-+]/)[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10));
  return parts.length === 3 && parts.every((p) => Number.isFinite(p) && p >= 0) ? parts : null;
}
const compareCore = (a, b) => {
  const ca = versionCore(a);
  const cb = versionCore(b);
  for (let i = 0; i < 3; i += 1) if (ca[i] !== cb[i]) return ca[i] - cb[i];
  return 0;
};

const tracked = readJson(join(compatDir, "tracked.json"));
const probes = readdirSync(join(compatDir, "probes"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => readJson(join(compatDir, "probes", name)))
  .sort((a, b) => compareCore(a.version, b.version) || a.version.localeCompare(b.version));
const advisories = readdirSync(join(compatDir, "advisories"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => {
    const advisory = readJson(join(compatDir, "advisories", name));
    if (`${advisory.id}.json` !== name)
      throw new Error(`advisories/${name}: id \`${advisory.id}\` does not match the filename`);
    return advisory;
  });

const stable = probes.filter((p) => p.channel === "stable");
if (stable.length === 0) throw new Error("no stable-channel probe data");
const latestStable = stable.at(-1);
const alphas = probes.filter((p) => p.channel === "alpha");
const latestAlpha = alphas.at(-1) ?? null;

const keys = tracked.keys.map((entry) => {
  const out = { key: entry.key, table: entry.table };
  if (entry.risk) out.risk = entry.risk;
  if (entry.note) out.note = entry.note;
  if (entry.statusOverride) {
    out.status = entry.statusOverride;
    out.removedIn = entry.removedIn ?? null;
  } else if (entry.probe === "none") {
    out.status = "unprobed";
  } else if (latestStable.keyPresence[entry.key] === true) {
    out.status = "active";
  } else {
    out.status = "missing";
    const lastPresent = stable.filter((p) => p.keyPresence[entry.key] === true).at(-1);
    const firstMissing = stable.find(
      (p) =>
        p.keyPresence[entry.key] === false &&
        (!lastPresent || compareCore(p.version, lastPresent.version) > 0),
    );
    out.firstMissingIn = firstMissing?.version ?? null;
  }
  if (entry.action) out.action = entry.action;
  return out;
});

const payload = {
  schemaVersion: 1,
  dataset: "codex-compat",
  codex: {
    latestStable: latestStable.version,
    latestAlpha: latestAlpha?.version ?? null,
    maxProbedStable: latestStable.version,
  },
  keys,
  advisories: advisories.map((a) => ({
    id: a.id,
    severity: a.severity,
    kind: a.kind,
    status: a.status,
    clientAction: a.clientAction,
    affects: a.affects,
    ...(a.keys?.length ? { keys: a.keys } : {}),
    ...(a.codexPassFixedIn ? { codexPassFixedIn: a.codexPassFixedIn } : {}),
    ...(a.links?.length ? { links: a.links } : {}),
    i18n: Object.fromEntries(Object.entries(a.i18n).sort(([x], [y]) => (x < y ? -1 : 1))),
  })),
  versions: probes.map((p) => ({
    version: p.version,
    channel: p.channel,
    publishedAt: p.publishedAt ?? null,
    probedAt: p.probedAt,
    platform: p.platform,
    configLoad: p.configLoad,
    regressions: p.regressions,
    deprecations: p.deprecationDiff ?? [],
    releaseNotesUrl: p.releaseNotesUrl ?? null,
  })),
};

const schema = readJson(join(compatDir, "compat.schema.json"));
const result = new Validator(schema, "2020-12", false).validate(payload);
if (!result.valid) {
  console.error(JSON.stringify(result.errors, null, 2));
  throw new Error("generated compat payload fails its own schema");
}

const text = `${JSON.stringify(payload, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = null;
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    /* missing = drift */
  }
  if (current !== text) {
    console.error(
      `✗ ${outPath} does not match the data sources; rerun node scripts/build-compat.mjs`,
    );
    process.exit(1);
  }
  console.log("✓ compat artifact matches the data sources");
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  console.log(`wrote ${outPath}`);
}
