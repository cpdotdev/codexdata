import { describe, expect, it } from "vitest";
import bundledCatalog from "../data/codex-schema/sources/rust-v0.153.4/models.json";
import {
  canonicalCatalogText,
  catalogHash,
  diffCatalogs,
  validateCatalog,
  type CatalogModel,
} from "../src/sync/catalog";
import { officialModel } from "./fixtures";

describe("validateCatalog", () => {
  it("accepts a catalog whose entries carry every Codex-required field", () => {
    const text = JSON.stringify({ models: [officialModel()], extra: "ignored" });
    const result = validateCatalog(text);
    expect(result.ok).toBe(true);
  });

  it("accepts the client's own bundled models.json (rust-v0.153.4) verbatim", () => {
    // 11 official entries, legacy base_instructions promoted, plus keys the struct does not
    // have (supports_parallel_tool_calls, prefer_websockets, …) which the client ignores.
    const result = validateCatalog(JSON.stringify(bundledCatalog));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.models.length).toBe(11);
  });

  it("rejects the whole catalog when one entry lacks a required field", () => {
    const broken = officialModel({ slug: "gpt-x" });
    delete (broken as Record<string, unknown>)["truncation_policy"];
    const result = validateCatalog(JSON.stringify({ models: [officialModel(), broken] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("schema:");
      expect(result.error).toContain("/models/1");
      expect(result.error).toContain("truncation_policy");
    }
  });

  it("rejects closed-enum typos, empty efforts and levels without a description", () => {
    for (const [label, overrides] of [
      ["shell_type", { shell_type: "shell" }],
      ["visibility", { visibility: "listed" }],
      ["truncation mode", { truncation_policy: { mode: "chars", limit: 10 } }],
      ["input modality", { input_modalities: ["text", "video"] }],
      ["apply_patch_tool_type", { apply_patch_tool_type: "function" }],
      ["default_verbosity", { default_verbosity: "max" }],
      ["empty effort", { supported_reasoning_levels: [{ effort: "", description: "x" }] }],
      ["level without description", { supported_reasoning_levels: [{ effort: "high" }] }],
      ["priority as string", { priority: "6" }],
      ["tool_mode as number", { tool_mode: 1 }],
    ] as const) {
      const result = validateCatalog(
        JSON.stringify({ models: [officialModel(overrides as Partial<CatalogModel>)] }),
      );
      expect(result.ok, label).toBe(false);
    }
    // Unknown effort strings and unknown keys are fine (Custom(String) / ignored).
    const lenient = officialModel({
      supported_reasoning_levels: [{ effort: "turbo", description: "vendor level" }],
      tool_mode: "something_new",
      supports_parallel_tool_calls: true,
    } as Partial<CatalogModel>);
    expect(validateCatalog(JSON.stringify({ models: [lenient] })).ok).toBe(true);
  });

  it("requires base_instructions or model_messages.instructions_template", () => {
    const noPrompt = officialModel();
    delete (noPrompt as Record<string, unknown>)["base_instructions"];
    expect(validateCatalog(JSON.stringify({ models: [noPrompt] })).ok).toBe(false);
    const withTemplate = { ...noPrompt, model_messages: { instructions_template: "Codex" } };
    expect(validateCatalog(JSON.stringify({ models: [withTemplate] })).ok).toBe(true);
    const nullTemplate = { ...noPrompt, model_messages: { instructions_template: null } };
    expect(validateCatalog(JSON.stringify({ models: [nullTemplate] })).ok).toBe(false);
  });

  it("rejects empty lists, duplicates, non-JSON and OpenAI-dialect lists", () => {
    expect(validateCatalog(JSON.stringify({ models: [] })).ok).toBe(false);
    expect(validateCatalog(JSON.stringify({ models: [officialModel(), officialModel()] })).ok).toBe(
      false,
    );
    expect(validateCatalog("<html>").ok).toBe(false);
    expect(validateCatalog(JSON.stringify({ object: "list", data: [{ id: "gpt-5" }] })).ok).toBe(
      false,
    );
  });
});

describe("canonicalization", () => {
  it("hashes identically regardless of key order, and differently on content change", async () => {
    const a = canonicalCatalogText([officialModel()]);
    const reordered = JSON.parse(JSON.stringify(officialModel()), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse())
        : value,
    ) as CatalogModel;
    const b = canonicalCatalogText([reordered]);
    expect(a).toBe(b);
    expect(await catalogHash(a)).toBe(await catalogHash(b));
    const c = canonicalCatalogText([officialModel({ priority: 7 })]);
    expect(await catalogHash(c)).not.toBe(await catalogHash(a));
  });
});

describe("diffCatalogs", () => {
  it("emits added / changed / removed events with monotonically increasing seq", () => {
    const previous = [officialModel(), officialModel({ slug: "gpt-5.5", priority: 12 })];
    const next = [
      officialModel({ priority: 5 }),
      officialModel({ slug: "gpt-6-astra", priority: 1 }),
    ];
    const events = diffCatalogs(previous, next, {
      at: "2026-09-05T00:00:00Z",
      fromHash: "aaa",
      toHash: "bbb",
      clientVersion: "0.153.4",
      seqStart: 10,
    });
    expect(events.map((e) => [e.seq, e.kind, e.slug, e.fields_changed])).toEqual([
      [10, "changed", "gpt-5.6-sol", ["priority"]],
      [11, "added", "gpt-6-astra", []],
      [12, "removed", "gpt-5.5", []],
    ]);
  });

  it("treats a first sync as all-added", () => {
    const events = diffCatalogs(null, [officialModel()], {
      at: "t",
      fromHash: null,
      toHash: "h",
      clientVersion: "0.153.4",
      seqStart: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("added");
  });
});
