import assert from "node:assert/strict";
import { test } from "node:test";

import { selectTargets } from "./compat-probe.mjs";

/// An npm packument (abbreviated) with these versions and dist-tags.
const packument = (versions, distTags) => ({
  "dist-tags": distTags,
  versions: Object.fromEntries(versions.map((v) => [v, {}])),
});

test("a stable release superseded before the next run is still probed", () => {
  // 0.155.0 and 0.155.1 shipped between two runs; `latest` only ever showed 0.155.1 to the watch.
  const meta = packument(["0.153.4", "0.154.0", "0.155.0", "0.155.1", "0.156.0-alpha.4"], {
    latest: "0.155.1",
    alpha: "0.156.0-alpha.4",
  });
  assert.deepEqual(selectTargets(meta, ["0.153.4", "0.154.0"]), [
    "0.155.0",
    "0.155.1",
    "0.156.0-alpha.4",
  ]);
  // Later runs: the gap stays a target until it has a probe.
  assert.deepEqual(selectTargets(meta, ["0.153.4", "0.154.0", "0.155.1", "0.156.0-alpha.4"]), [
    "0.155.0",
  ]);
  assert.deepEqual(
    selectTargets(meta, ["0.153.4", "0.154.0", "0.155.0", "0.155.1", "0.156.0-alpha.4"]),
    [],
  );
});

test("backfill stays between the oldest probed stable and latest", () => {
  const meta = packument(
    [
      "0.1.2505172116", // the old TypeScript CLI
      "0.152.1",
      "0.153.4",
      "0.155.0",
      "0.155.1",
      "0.156.0", // on npm, but not `latest` yet
      "0.155.0-alpha.16.3",
      "0.163.0-linux-x64", // platform package versions
    ],
    { latest: "0.155.1", alpha: "0.156.0-alpha.17" },
  );
  assert.deepEqual(selectTargets(meta, ["0.153.4", "0.155.1"]), ["0.155.0", "0.156.0-alpha.17"]);
});

test("backfill is oldest first and capped per run", () => {
  const versions = ["0.150.0", "0.150.1", "0.150.2", "0.150.3", "0.150.4", "0.150.5"];
  const meta = packument(versions, { latest: "0.150.5" });
  assert.deepEqual(selectTargets(meta, ["0.150.0", "0.150.5"], 2), ["0.150.1", "0.150.2"]);
  assert.deepEqual(selectTargets(meta, ["0.150.0"], 2), ["0.150.1", "0.150.2", "0.150.5"]);
});

test("without probes only the dist-tags are targets", () => {
  const meta = packument(["0.150.0", "0.151.0", "0.152.0-alpha.1"], {
    latest: "0.151.0",
    alpha: "0.152.0-alpha.1",
  });
  assert.deepEqual(selectTargets(meta, []), ["0.151.0", "0.152.0-alpha.1"]);
  // Alpha probes do not set the floor.
  assert.deepEqual(selectTargets(meta, ["0.152.0-alpha.1"]), ["0.151.0"]);
});
