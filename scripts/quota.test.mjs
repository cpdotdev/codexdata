import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Validator } from "@cfworker/json-schema";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const policy = read("../data/codex-quota/policy.json");
const validator = new Validator(read("../data/codex-quota/policy.schema.json"), "2020-12", false);

test("reviewed policy validates without guessing unconfirmed plan windows", () => {
  assert.equal(validator.validate(policy).valid, true);
  assert.deepEqual(policy.plans.pro.windows, ["weekly"]);
  assert.deepEqual(policy.plans.free.windows, []);
});

test("confirmed empty windows can represent a future policy without fixed windows", () => {
  const future = structuredClone(policy);
  future.plans.pro.windows = [];
  assert.equal(validator.validate(future).valid, true);
});

const mutations = {
  "unknown schema": (p) => (p.schemaVersion = 2),
  "wrong dataset": (p) => (p.dataset = "other"),
  "zero revision": (p) => (p.revision = 0),
  "fractional revision": (p) => (p.revision = 1.5),
  "unsafe revision": (p) => (p.revision = 9007199254740992),
  "invalid date": (p) => (p.verifiedAt = "2026-02-30"),
  "timestamp instead of date": (p) => (p.verifiedAt = "2026-10-05T00:00:00Z"),
  "unofficial source": (p) => (p.sources = ["https://example.com/docs"]),
  "spoofed official source": (p) => (p.sources = ["https://openai.com.evil.test/docs"]),
  "insecure source": (p) => (p.sources = ["http://openai.com/docs"]),
  "empty sources": (p) => (p.sources = []),
  "source credentials": (p) => (p.sources = ["https://user:password@openai.com/docs"]),
  "too many sources": (p) =>
    (p.sources = Array.from({ length: 21 }, (_, i) => `https://openai.com/${i}`)),
  "duplicate windows": (p) => (p.plans.pro.windows = ["weekly", "weekly"]),
  "unknown window": (p) => (p.plans.pro.windows = ["daily"]),
  "invented unconfirmed window": (p) => (p.plans.free.windows = ["monthly"]),
  "missing uncertainty note": (p) => delete p.plans.free.note,
  "blank note": (p) => (p.plans.free.note = " "),
  "oversized note": (p) => (p.plans.free.note = "a".repeat(6001)),
  "invalid plan key": (p) => (p.plans.Pro = p.plans.pro),
  "oversized plan key": (p) => (p.plans["a".repeat(65)] = p.plans.pro),
  "too many plans": (p) =>
    (p.plans = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, p.plans.pro]))),
  "unexpected reserve": (p) => (p.plans.pro.reservePercent = 10),
  "unexpected root field": (p) => (p.remainingPercent = 100),
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name}`, () => {
    const invalid = structuredClone(policy);
    mutate(invalid);
    assert.equal(validator.validate(invalid).valid, false);
  });
}
