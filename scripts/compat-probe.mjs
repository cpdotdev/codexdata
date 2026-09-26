#!/usr/bin/env node
// Codex compatibility probe: for one Codex CLI version, download the official npm platform package
// and extract hard facts:
//   1. Whether each probe=binary-string key in tracked.json still exists in the binary (serde
//      field-name strings); present → absent means the key was most likely removed upstream
//      (disable_response_storage proved this inference).
//   2. User-facing deprecation/migration messages in the binary ("no longer supported" /
//      "is deprecated").
//   3. Config loadability: assemble a config.toml with every shape Codex Pass manages and run
//      `codex features list` — the 0.148/0.149 style "whole file rejected" failure shows up here.
//   4. GitHub release notes (rust-v<version> tag).
// Results go to data/codex-compat/probes/<version>.json (once per version, idempotent).
//
// Usage: node scripts/compat-probe.mjs                 probe the not-yet-probed versions among the npm dist-tags latest and alpha
//        node scripts/compat-probe.mjs --version 0.155.1 [--force]
// Exit codes: 0 = nothing new or probe passed; 20 = regression found (key missing / config rejected),
// for the workflow to open an issue; 1 = script failure.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compatDir = join(root, "data", "codex-compat");
const probesDir = join(compatDir, "probes");
const tracked = JSON.parse(readFileSync(join(compatDir, "tracked.json"), "utf8"));

const NPM_PACKAGE = "@openai/codex";
const REGISTRY = "https://registry.npmjs.org";
// User-facing deprecation messages; exclude Rust ecosystem noise (Error::description, dependency
// source paths, etc.).
const DEPRECATION_RE = /no longer supported|is deprecated/;
const DEPRECATION_NOISE =
  /description\(\) is deprecated|cargo\/registry|serde_yaml|deprecated_time_unit|\\b\(\{\{attributes\}\}/;

function platformSuffix() {
  const os = { darwin: "darwin", linux: "linux", win32: "win32" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!os || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return `${os}-${arch}`;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** Version triple (prerelease ignored, matching the client's codex_client_gate convention). */
function versionCore(version) {
  const core = version.split(/[-+]/)[0];
  const parts = core.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts;
}

function compareCore(a, b) {
  const ca = versionCore(a);
  const cb = versionCore(b);
  for (let i = 0; i < 3; i += 1) if (ca[i] !== cb[i]) return ca[i] - cb[i];
  return 0;
}

function isStable(version) {
  return !version.includes("-");
}

/** Download the platform package and locate the codex binary; returns { binary, cleanup }. */
function downloadBinary(version, suffix) {
  const workDir = mkdtempSync(join(tmpdir(), "codex-compat-"));
  const tarball = `${REGISTRY}/${NPM_PACKAGE}/-/codex-${version}-${suffix}.tgz`;
  const tgzPath = join(workDir, "pkg.tgz");
  execFileSync("curl", ["-fsSL", "--max-time", "300", "-o", tgzPath, tarball], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  execFileSync("tar", ["-xzf", tgzPath, "-C", workDir], { stdio: "inherit" });
  const vendor = join(workDir, "package", "vendor");
  const target = readdirSync(vendor).find((name) => existsSync(join(vendor, name, "bin", "codex")));
  if (!target) throw new Error(`no codex binary found under ${vendor}`);
  return {
    binary: join(vendor, target, "bin", "codex"),
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  };
}

/** Recover a deprecation message from the big symbol-table string as a stable, readable sentence:
 *  scan backwards allowing only message characters (lowercase / digits / snake_case / quotes, etc.),
 *  stopping at an uppercase letter or a backtick (a backtick almost always delimits the token that
 *  opens the message); scan forwards to a period or a "lowercase+Uppercase+lowercase"
 *  string-concatenation boundary. The same message normalizes to the same text even when the
 *  symbol table is reordered across versions. */
function normalizeDeprecation(text, at) {
  const headChars = /[a-z0-9_ ."'=,;:()[\]-]/;
  let start = at;
  while (start > 0 && at - start < 120) {
    const ch = text[start - 1];
    if (ch === "`") {
      start -= 1;
      break;
    }
    if (!headChars.test(ch)) break;
    start -= 1;
  }
  let end = at;
  const max = Math.min(text.length, at + 160);
  while (end < max) {
    const ch = text[end];
    if (ch === ".") {
      end += 1;
      break;
    }
    if (
      /[A-Z]/.test(ch) &&
      end > start &&
      /[a-z]/.test(text[end - 1]) &&
      end + 1 < text.length &&
      /[a-z]/.test(text[end + 1]) &&
      end - at > 40
    )
      break;
    if (!/[a-zA-Z0-9_ ."'`=,;:()[\]-]/.test(ch)) break;
    end += 1;
  }
  return text.slice(start, end).trim();
}

/** Extract ASCII strings (≥ minLen) from the binary; after normalization keep only the messages
 *  matching pattern. */
function scanStrings(buffer, minLen, pattern, noise) {
  const found = new Set();
  let start = -1;
  for (let i = 0; i <= buffer.length; i += 1) {
    const byte = i < buffer.length ? buffer[i] : 0;
    const printable = byte >= 0x20 && byte < 0x7f;
    if (printable && start < 0) start = i;
    if (!printable && start >= 0) {
      if (i - start >= minLen) {
        const text = buffer.toString("latin1", start, i);
        if (!noise.test(text)) {
          const globalPattern = new RegExp(pattern.source, "g");
          for (const match of text.matchAll(globalPattern)) {
            found.add(normalizeDeprecation(text, match.index));
          }
        }
      }
      start = -1;
    }
  }
  return [...found].sort().slice(0, 60);
}

/** Assemble a config.toml from the managed shapes and run `codex features list` to verify the
 *  whole config still loads. */
function probeConfigLoad(binary) {
  const home = mkdtempSync(join(tmpdir(), "codex-compat-home-"));
  const config = `
model_provider = "codex-pass"
chatgpt_base_url = "https://chatgpt.com/backend-api/"
web_search = "cached"
check_for_update_on_startup = false
approval_policy = "on-request"
sandbox_mode = "workspace-write"
hide_agent_reasoning = false
project_doc_max_bytes = 32768

[model_providers.codex-pass]
name = "Codex Pass"
base_url = "http://127.0.0.1:11433/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "probe-token"

[model_providers.codex-pass.http_headers]
x-codex-pass = "probe"

[features]

[analytics]
enabled = false

[desktop]
composerEnterBehavior = "send"
`;
  writeFileSync(join(home, "config.toml"), config);
  try {
    const result = spawnSync(binary, ["features", "list"], {
      env: { ...process.env, CODEX_HOME: home, RUST_LOG: "error" },
      timeout: 30_000,
      encoding: "utf8",
    });
    return {
      configLoad: result.status === 0 ? "ok" : "fail",
      exitCode: result.status,
      stderrExcerpt: (result.stderr ?? "").trim().slice(0, 800) || null,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function releaseNotes(version) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "codexdata-compat-probe" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const release = await fetchJson(
      `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`,
      headers,
    );
    return { url: release.html_url ?? null, publishedAt: release.published_at ?? null };
  } catch {
    return { url: null, publishedAt: null };
  }
}

/** The largest probed stable version below `version` (baseline for regression comparison). */
function previousStableProbe(version) {
  if (!existsSync(probesDir)) return null;
  const candidates = readdirSync(probesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .filter((v) => isStable(v) && compareCore(v, version) < 0)
    .sort(compareCore);
  const prev = candidates.at(-1);
  return prev ? JSON.parse(readFileSync(join(probesDir, `${prev}.json`), "utf8")) : null;
}

async function probeVersion(version) {
  const suffix = platformSuffix();
  console.log(`probing ${NPM_PACKAGE}@${version} (${suffix})`);
  const { binary, cleanup } = downloadBinary(version, suffix);
  try {
    const versionOut = spawnSync(binary, ["--version"], { timeout: 15_000, encoding: "utf8" });
    if (versionOut.status !== 0) throw new Error(`codex --version failed: ${versionOut.stderr}`);
    const buffer = readFileSync(binary);
    const keyPresence = {};
    for (const entry of tracked.keys) {
      if (entry.probe === "none") continue;
      const needle = entry.needle ?? entry.key;
      keyPresence[entry.key] = buffer.includes(Buffer.from(needle, "latin1"));
    }
    const deprecations = scanStrings(buffer, 12, DEPRECATION_RE, DEPRECATION_NOISE);
    const load = probeConfigLoad(binary);
    const notes = await releaseNotes(version);

    const regressions = [];
    if (load.configLoad !== "ok")
      regressions.push(`config-load: ${load.configLoad} (exit ${load.exitCode})`);
    const baseline = previousStableProbe(version);
    let deprecationDiff = [];
    if (baseline) {
      for (const [key, present] of Object.entries(keyPresence)) {
        if (!present && baseline.keyPresence?.[key] === true)
          regressions.push(`key-missing: ${key}`);
      }
      // The deprecation diff is intelligence only, not a regression. Token boundaries are lost in
      // the symbol table, so the displayed text drifts at both ends with neighbouring strings;
      // compare on a core window around the deprecation phrase (24 chars before, 40 after), which
      // is stable across versions.
      const coreOf = (line) => {
        const at = line.search(DEPRECATION_RE);
        return at < 0 ? line : line.slice(Math.max(0, at - 24), at + 40);
      };
      const known = new Set((baseline.deprecations ?? []).map(coreOf));
      deprecationDiff = deprecations.filter((line) => !known.has(coreOf(line)));
    }

    return {
      version,
      channel: isStable(version) ? "stable" : "alpha",
      platform: suffix,
      probedAt: new Date().toISOString(),
      publishedAt: notes.publishedAt,
      releaseNotesUrl: notes.url,
      reportedVersion: versionOut.stdout.trim(),
      keyPresence,
      deprecations,
      deprecationDiff,
      configLoad: load.configLoad,
      configLoadExit: load.exitCode,
      configLoadStderr: load.stderrExcerpt,
      regressions,
    };
  } finally {
    cleanup();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const versionArg = args.includes("--version") ? args[args.indexOf("--version") + 1] : null;
  const force = args.includes("--force");

  let targets = [];
  if (versionArg) {
    targets = [versionArg];
  } else {
    const meta = await fetchJson(`${REGISTRY}/${NPM_PACKAGE}`, {
      accept: "application/vnd.npm.install-v1+json",
    });
    targets = [meta["dist-tags"].latest, meta["dist-tags"].alpha].filter(Boolean);
  }

  mkdirSync(probesDir, { recursive: true });
  let sawRegression = false;
  let probedAny = false;
  for (const version of targets) {
    if (!versionCore(version)) {
      console.warn(`skip ${version}: unparsable version`);
      continue;
    }
    const outPath = join(probesDir, `${version}.json`);
    if (existsSync(outPath) && !force) {
      console.log(`skip ${version}: already probed`);
      continue;
    }
    const probe = await probeVersion(version);
    writeFileSync(outPath, `${JSON.stringify(probe, null, 2)}\n`);
    probedAny = true;
    console.log(
      `wrote probes/${version}.json (configLoad=${probe.configLoad}, regressions=${probe.regressions.length})`,
    );
    for (const regression of probe.regressions) console.warn(`  !! ${regression}`);
    if (probe.channel === "stable" && probe.regressions.length > 0) sawRegression = true;
  }
  if (!probedAny) console.log("nothing new to probe");
  process.exit(sawRegression ? 20 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
