import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateProduct, buildHooks } from "./hooks.mjs";
const example = () =>
  JSON.parse(readFileSync(new URL("../data/codex-hooks/products/herdr.json", import.meta.url)));
test("registry includes three independently documented products", () => {
  const registry = buildHooks();
  assert.equal(registry.schema_version, 1);
  for (const id of ["herdr", "orca", "xirp"]) assert(registry.products.some((p) => p.id === id));
});
test("rejects dangerous links, generic paths, personal paths and executable matching", () => {
  for (const mutate of [
    (p) => (p.references[0].url = "javascript:alert(1)"),
    (p) => (p.path_suffixes = ["/hook.sh"]),
    (p) => (p.examples.match = ["/Users/lucheng/hook.sh"]),
    (p) => (p.regex = ".*"),
    (p) => delete p.i18n.en,
    (p) => (p.id = "other"),
    (p) => (p.icon.file = "../herdr.png"),
    (p) => (p.icon.file = "orca.png"),
    (p) => (p.icon.source_url = "javascript:alert(1)"),
    (p) => (p.icon.source_url = "https://user:secret@example.com/icon.png"),
    (p) => delete p.icon.rights,
  ]) {
    const product = example();
    mutate(product);
    assert.throws(() => validateProduct(product, "herdr.json"));
  }
});
test("build embeds bounded PNGs with provenance; icons remain optional", () => {
  const withoutIcon = example();
  delete withoutIcon.icon;
  assert.doesNotThrow(() => validateProduct(withoutIcon, "herdr.json"));
  const registry = buildHooks();
  assert(Buffer.byteLength(JSON.stringify(registry, null, 2) + "\n") <= 1024 * 1024);
  for (const product of registry.products) {
    if (!product.icon) continue;
    assert.equal(product.icon.file, undefined);
    assert(product.icon.source_url.startsWith("https://"));
    const bytes = Buffer.from(product.icon.data_url.split(",")[1], "base64");
    assert(bytes.length <= 16 * 1024);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert(bytes.readUInt32BE(16) >= 16 && bytes.readUInt32BE(16) <= 128);
    assert(bytes.readUInt32BE(20) >= 16 && bytes.readUInt32BE(20) <= 128);
  }
});
test("rejects conflicting suffixes across products", () => {
  const product = example();
  assert.throws(() => validateProduct(product, "herdr.json", new Set(product.path_suffixes)));
});
