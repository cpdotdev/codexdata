# Contributing

CodexData is an open dataset for the OpenAI Codex client (not affiliated with OpenAI). The most
useful contributions are **feature-flag annotations and their translations** and **hook product
entries**: the human-readable layers over the machine-extracted data.

Two commands cover every change:

```bash
corepack enable && pnpm install     # Node 22
pnpm validate && pnpm build:static  # check, then regenerate public/v1/** (commit the result)
```

CI runs `pnpm check` (typecheck, prettier, validate, tests) on every pull request and fails on
stale generated files, so always commit `public/` together with the source change.

## Feature-flag annotations and translations

One JSON file per flag, named after the flag key:

```
data/codex-features/annotations/<flag_key>.json
```

```jsonc
{
  "key": "chronicle", // must equal the filename
  "aka": "Computer History", // optional: observed official/user-facing name, locale-independent
  "i18n": {
    "zh": {
      "title": "电脑使用历史（Computer History）",
      "summary": "启用 Chronicle 边车进程，被动记录屏幕上下文形成记忆。",
      "note": "…", // optional extra context
      "risk": "…", // optional risk note
    },
    "en": { "title": "…", "summary": "…" },
  },
}
```

**Adding a language = adding one `i18n` block** to the files you can translate. Locale codes are
BCP-47-style (`zh`, `en`, `ja`, `zh-TW`, `zh-Hant`, …). `title` and `summary` are required per
locale; `note` and `risk` are optional. The full schema is
`data/codex-features/annotations.schema.json`. Machine facts (stage, defaults, official English
rustdoc, menu copy) come from the extracted registry and are **not** edited here.

### Honesty rules (the review bar)

- Ground every claim in the flag's official rustdoc (`doc` in `/v1/features/codex/latest.json`),
  the client's own menu copy, or behavior you have personally observed. **Do not guess.**
- If a meaning is unconfirmed, say so in `note` (see `psp.json` for the pattern) rather than
  inventing an expansion.
- Translations translate the grounded summary; they do not embellish it.
- These annotations are community commentary, not OpenAI documentation; keep that tone.

## Hook product entries

One file per product under `data/codex-hooks/products/`, optional icon under
`data/codex-hooks/icons/`. [docs/HOOKS.md](docs/HOOKS.md) has the schema, the evidence
requirements, the matching contract and the icon rules. Never include real usernames, workspace
paths, tokens or whole private hook files; use `/Users/demo`, `/home/demo` or `C:\Users\demo`.

## New Codex tags

When a new `rust-v*` release changes the feature table or the `ModelInfo` types, vendor the
sources at that tag and regenerate; the extractor is strict on purpose and CI rejects hand
edits to `registry.json`. Steps: [docs/RUNBOOK.md](docs/RUNBOOK.md#adding-a-new-codex-tag).

## What is not open for contribution

`data/codex-compat/` (compatibility intelligence) is produced by an automated probe and
adjudicated by the Codex Pass team, because its verdicts drive one-click cleanup actions in the
Codex Pass client. Please do not open pull requests against it; if you believe a verdict is
wrong, open an issue with the Codex version and what you observed.

## Pull requests

- Keep one concern per PR (one language, one product, one tag).
- Commit source and generated files together; CI fails on drift.
- Describe the evidence you used. Reviewers check grounding, not just formatting.

## Licensing

By contributing you agree that your data contributions under `data/` are licensed CC-BY-4.0
(`data/LICENSE-DATA`) and your code contributions under MIT (`LICENSE`). Vendored `sources/`
snapshots are OpenAI's, Apache-2.0, and must stay byte-verbatim. Product icons remain their
owners' marks; you must state their source and rights in the product file.

---

### 中文速览

- 旗标注释：每个旗标一个文件 `data/codex-features/annotations/<旗标名>.json`，`key` 必须等于文件名。
  **加一种语言 = 在 `i18n` 里加一个语言块**（`title`、`summary` 必填，`note`、`risk` 选填）。
- 诚实纪律：只写有依据的内容（官方 rustdoc、菜单文案、你亲自验证过的行为），拿不准就在
  `note` 里写明「未确认」，禁止编造；翻译忠实于原意，不加戏。
- Hook 产品：`data/codex-hooks/products/` 下一个产品一个文件，规则见 `docs/HOOKS.md`；
  绝不提交真实用户名、路径、令牌或整份私有 hooks 文件。
- `data/codex-compat/` 由 Codex Pass 团队维护，不接受 PR；数据有误请开 issue。
- 提交前跑 `pnpm validate && pnpm build:static`（Node 22），把 `public/` 下生成的变更一并提交。
