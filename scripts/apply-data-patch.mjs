#!/usr/bin/env node
// Applies a patch made by a job that runs third-party code (pnpm install, downloaded Codex
// binaries, upstream sources) inside a job that holds a write token but runs none of that code.
// Only additions, modifications and deletions of regular files under the allowed paths pass, so
// the untrusted job can change data but never the scripts or workflows that later run with a
// signing key (docs/DATA-SIGNING.md). Zero dependencies: node built-ins and git only.
//
// usage: node scripts/apply-data-patch.mjs <patch file> <allowed path>...
//   An allowed path that ends in "/" is a directory prefix; anything else is an exact file path.
// Run it in a clean checkout. On success the changes are staged; on any violation the checkout
// is reset to HEAD and the exit code is 1.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/// Parse `git diff --cached --raw -z --no-renames` output into {oldMode, newMode, status, path}.
export function parseRaw(raw) {
  const fields = raw.split("\0");
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    if (!meta) break;
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(meta);
    if (!m) throw new Error(`unexpected diff entry: ${meta}`);
    entries.push({ oldMode: m[1], newMode: m[2], status: m[3], path: fields[i + 1] });
  }
  return entries;
}

/// Inside the allowed paths, and no `.git*` segment (`.gitattributes` and `.gitmodules` change how
/// git treats files; datasets never need them).
function allowedPath(path, allowed) {
  if (path.split("/").some((segment) => segment.startsWith(".git"))) return false;
  return allowed.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/// Problems with the staged entries (empty = acceptable).
export function violations(entries, allowed) {
  const problems = [];
  for (const { oldMode, newMode, status, path } of entries) {
    if (!allowedPath(path, allowed)) problems.push(`${path}: outside the allowed paths`);
    else if (status === "A" && newMode !== "100644") problems.push(`${path}: mode ${newMode}`);
    else if (status === "M" && (oldMode !== "100644" || newMode !== "100644"))
      problems.push(`${path}: mode ${oldMode} -> ${newMode}`);
    else if (status === "D" && oldMode !== "100644") problems.push(`${path}: mode ${oldMode}`);
    else if (!["A", "M", "D"].includes(status)) problems.push(`${path}: status ${status}`);
  }
  return problems;
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });

/// Apply `patchFile` in `cwd` (staged) if every change is allowed; otherwise reset and throw.
export function applyDataPatch(patchFile, allowed, cwd = process.cwd()) {
  if (allowed.length === 0) throw new Error("no allowed paths given");
  if (git(["status", "--porcelain"], cwd).trim() !== "") throw new Error("checkout is not clean");
  try {
    git(["apply", "--index", "--whitespace=nowarn", patchFile], cwd);
    const entries = parseRaw(git(["diff", "--cached", "--raw", "-z", "--no-renames"], cwd));
    const problems = violations(entries, allowed);
    if (problems.length > 0) throw new Error(`refused patch:\n  ${problems.join("\n  ")}`);
    return entries;
  } catch (error) {
    git(["reset", "-q", "--hard", "HEAD"], cwd);
    git(["clean", "-qfd"], cwd);
    throw error;
  }
}

function main() {
  const [patchFile, ...allowed] = process.argv.slice(2);
  if (!patchFile || allowed.length === 0) {
    console.error("usage: node scripts/apply-data-patch.mjs <patch file> <allowed path>...");
    process.exit(2);
  }
  try {
    const entries = applyDataPatch(patchFile, allowed);
    console.log(`staged ${entries.length} data file change(s)`);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
