import type { CatalogModel } from "../src/sync/catalog";

/// One official catalog entry satisfying every field Codex 0.153.x requires (any field can be
/// overridden).
export function officialModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    default_reasoning_level: "low",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "high", description: "Deep" },
    ],
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 6,
    support_verbosity: true,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    base_instructions: "You are Codex.",
    use_responses_lite: true,
    ...overrides,
  };
}
