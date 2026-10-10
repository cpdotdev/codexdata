import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyDataPatch, parseRaw, violations } from "./apply-data-patch.mjs";

const ALLOWED = ["data/codex-compat/probes/", "public/v1/compat/codex/latest.json"];

/// A scratch repository with one commit; returns helpers to make a patch from edits and to apply
/// it to a fresh clone (the trusted job's checkout).
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "apply-data-patch-"));
  const repo = join(root, "repo");
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
  mkdirSync(join(repo, "data/codex-compat/probes"), { recursive: true });
  mkdirSync(join(repo, "public/v1/compat/codex"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "data/codex-compat/probes/0.1.0.json"), "{}\n");
  writeFileSync(join(repo, "public/v1/compat/codex/latest.json"), "{}\n");
  writeFileSync(join(repo, "scripts/data-signature.mjs"), "// trusted\n");
  git(["init", "-q"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  let n = 0;
  return {
    root,
    repo,
    /// Run `edit(repo)` in a copy of the base, stage everything, return the patch path.
    patch(edit) {
      const work = join(root, `work-${++n}`);
      execFileSync("git", ["clone", "-q", repo, work]);
      edit(work);
      execFileSync("git", ["add", "-A"], { cwd: work });
      const file = join(root, `patch-${n}.diff`);
      writeFileSync(file, execFileSync("git", ["diff", "--cached", "--binary"], { cwd: work }));
      return file;
    },
    /// A fresh clone of the base to apply into.
    target() {
      const dir = join(root, `target-${++n}`);
      execFileSync("git", ["clone", "-q", repo, dir]);
      return dir;
    },
    status: (dir) => git(["status", "--porcelain"], dir),
  };
}

test("stages additions, edits and deletions of data files", () => {
  const s = scratch();
  try {
    const file = s.patch((w) => {
      writeFileSync(join(w, "data/codex-compat/probes/0.2.0.json"), '{"v":2}\n');
      writeFileSync(join(w, "public/v1/compat/codex/latest.json"), '{"v":2}\n');
      rmSync(join(w, "data/codex-compat/probes/0.1.0.json"));
    });
    const dir = s.target();
    const entries = applyDataPatch(file, ALLOWED, dir);
    assert.deepEqual(entries.map((e) => `${e.status} ${e.path}`).sort(), [
      "A data/codex-compat/probes/0.2.0.json",
      "D data/codex-compat/probes/0.1.0.json",
      "M public/v1/compat/codex/latest.json",
    ]);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("refuses code, files outside the allowed paths, symlinks and executable bits", () => {
  const s = scratch();
  try {
    const cases = {
      "edits a script": (w) => {
        writeFileSync(join(w, "data/codex-compat/probes/0.2.0.json"), "{}\n");
        writeFileSync(join(w, "scripts/data-signature.mjs"), "// exfiltrate\n");
      },
      "adds a workflow": (w) => {
        mkdirSync(join(w, ".github/workflows"), { recursive: true });
        writeFileSync(join(w, ".github/workflows/x.yml"), "on: push\n");
      },
      "other public file": (w) => writeFileSync(join(w, "public/v1/compat/codex/other.json"), "{}"),
      "prefix lookalike": (w) => {
        mkdirSync(join(w, "data/codex-compat/probes-evil"), { recursive: true });
        writeFileSync(join(w, "data/codex-compat/probes-evil/x.json"), "{}");
      },
      symlink: (w) =>
        symlinkSync(
          "../../../scripts/data-signature.mjs",
          join(w, "data/codex-compat/probes/l.json"),
        ),
      "executable bit": (w) => {
        writeFileSync(join(w, "data/codex-compat/probes/x.json"), "{}");
        chmodSync(join(w, "data/codex-compat/probes/x.json"), 0o755);
      },
    };
    for (const [label, edit] of Object.entries(cases)) {
      const file = s.patch(edit);
      const dir = s.target();
      assert.throws(() => applyDataPatch(file, ALLOWED, dir), /refused patch/, label);
      assert.equal(s.status(dir), "", `${label}: checkout must be reset`);
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("refuses to run in a dirty checkout or without allowed paths", () => {
  const s = scratch();
  try {
    const file = s.patch((w) => writeFileSync(join(w, "data/codex-compat/probes/a.json"), "{}"));
    const dir = s.target();
    assert.throws(() => applyDataPatch(file, [], dir), /no allowed paths/);
    writeFileSync(join(dir, "stray.txt"), "x");
    assert.throws(() => applyDataPatch(file, ALLOWED, dir), /not clean/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("parseRaw and violations cover type changes and odd modes", () => {
  const sha = "0".repeat(40);
  const raw = [
    `:100644 100644 ${sha} ${sha} M`,
    "data/codex-compat/probes/a.json",
    `:100644 120000 ${sha} ${sha} T`,
    "data/codex-compat/probes/b.json",
    `:120000 000000 ${sha} ${sha} D`,
    "data/codex-compat/probes/c.json",
    "",
  ].join("\0");
  const entries = parseRaw(raw);
  assert.equal(entries.length, 3);
  assert.deepEqual(violations(entries, ALLOWED), [
    "data/codex-compat/probes/b.json: status T",
    "data/codex-compat/probes/c.json: mode 120000",
  ]);
  assert.throws(() => parseRaw("garbage\0path\0"), /unexpected diff entry/);
});
