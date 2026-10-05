import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";

/** Reject malformed policy before publishing any static artifacts. */
export function buildQuotaPolicy() {
  const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const policy = read("../data/codex-quota/policy.json");
  const validator = new Validator(read("../data/codex-quota/policy.schema.json"), "2020-12", false);
  const result = validator.validate(policy);
  if (!result.valid) throw new Error(`Invalid quota policy: ${JSON.stringify(result.errors)}`);
  return policy;
}
