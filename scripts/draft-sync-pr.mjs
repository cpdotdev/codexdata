#!/usr/bin/env node
// Draft the zh annotations of the open Codex tag sync pull request on this machine, check them and
// push them to its branch. The Codex tag sync workflow does not draft (no model key is stored in
// GitHub); a maintainer runs this after it opens or updates the pull request:
//   1. find the open pull request from bot/codex-tags-sync (or take --ref, for a local test);
//   2. check its head out in a temporary worktree and install dependencies;
//   3. run scripts/draft-annotations.mjs --since <main's latest tag> (local kimi or agy);
//   4. format, regenerate public/v1 and run `pnpm check`;
//   5. commit, push to the branch (a plain push: it fails if the branch moved meanwhile) and
//      comment the draft list on the pull request.
// The push makes the branch hand-edited, so later sync runs do not overwrite it. A human still
// reviews every draft against its rustdoc before merging (CONTRIBUTING.md, honesty rules).
//
// Usage: node scripts/draft-sync-pr.mjs [--cli kimi,agy] [--ref <git ref>] [--no-push] [--keep]
//   --cli      passed to draft-annotations.mjs
//   --ref      draft on this ref instead of the pull request head (implies --no-push)
//   --no-push  stop after the local commit; the worktree is kept for inspection
//   --keep     keep the worktree after a successful push
// Needs git, gh (signed in, for the pull request) and pnpm. Commits use your git identity.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "cpdotdev/codexdata";
const BRANCH = "bot/codex-tags-sync";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cli = argValue("--cli");
const ref = argValue("--ref");
const push = !ref && !args.includes("--no-push");
const keep = args.includes("--keep");

const capture = (cmd, cmdArgs, cwd = root) =>
  execFileSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
const run = (cmd, cmdArgs, cwd) => {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs[0]} failed (exit ${result.status})`);
};

let pr;
let head;
if (ref) {
  head = capture("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
} else {
  const open = JSON.parse(
    capture("gh", [
      "pr",
      "list",
      "--repo",
      REPO,
      "--head",
      BRANCH,
      "--state",
      "open",
      "--json",
      "number,headRefOid",
    ]),
  );
  if (open.length === 0) {
    console.log(`no open pull request from ${BRANCH}; nothing to draft`);
    process.exit(0);
  }
  ({ number: pr, headRefOid: head } = open[0]);
  capture("git", ["fetch", "-q", "origin", "main", BRANCH]);
  if (capture("git", ["rev-parse", `origin/${BRANCH}`]) !== head) {
    throw new Error(`origin/${BRANCH} does not match the head of #${pr}; fetch and run again`);
  }
}
capture("git", ["fetch", "-q", "origin", "main"]);
const since = JSON.parse(
  capture("git", ["show", "origin/main:data/codex-features/tags.json"]),
).latest;

const worktree = mkdtempSync(join(tmpdir(), "codexdata-drafts-"));
// Outside the worktree: `pnpm check` runs prettier over every Markdown file in it.
const reportDir = mkdtempSync(join(tmpdir(), "codexdata-drafts-report-"));
const report = join(reportDir, "drafts.md");
let ok = false;
try {
  run("git", ["worktree", "add", "--detach", worktree, head], root);
  run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], worktree);
  run(
    "node",
    [
      "scripts/draft-annotations.mjs",
      "--since",
      since,
      "--report",
      report,
      ...(cli ? ["--cli", cli] : []),
    ],
    worktree,
  );
  const changed = capture(
    "git",
    ["status", "--porcelain", "data/codex-features/annotations"],
    worktree,
  );
  if (!changed) {
    console.log("no annotation changed; nothing to commit");
    ok = true;
  } else {
    run("pnpm", ["exec", "prettier", "--write", "data/codex-features/annotations"], worktree);
    run("pnpm", ["build:static"], worktree);
    run("pnpm", ["check"], worktree);
    const latest = JSON.parse(
      readFileSync(join(worktree, "data/codex-features/tags.json"), "utf8"),
    ).latest;
    run("git", ["add", "-A", "data", "public"], worktree);
    run("git", ["commit", "-q", "-m", `data: draft zh annotations for ${latest}`], worktree);
    const commit = capture("git", ["rev-parse", "--short", "HEAD"], worktree);
    if (!push) {
      console.log(`committed ${commit} in ${worktree} (not pushed)`);
    } else {
      run("git", ["push", "origin", `HEAD:refs/heads/${BRANCH}`], worktree);
      const body = `${readFileSync(report, "utf8")}\nPushed ${commit} from a local run of \`scripts/draft-sync-pr.mjs\`. Check each draft against its rustdoc before merging.\n`;
      run("gh", ["pr", "comment", String(pr), "--repo", REPO, "--body", body], worktree);
      console.log(`pushed ${commit} to ${BRANCH} (#${pr})`);
    }
    ok = true;
  }
} finally {
  rmSync(reportDir, { recursive: true, force: true });
  if (ok && push && !keep) {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "inherit" });
    rmSync(worktree, { recursive: true, force: true });
  } else {
    console.log(
      `worktree kept at ${worktree} (remove it with: git worktree remove --force ${worktree})`,
    );
  }
}
