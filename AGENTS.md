# Instructions for coding agents

- Read `README.md` and `CONTRIBUTING.md` first. Run `pnpm check` with Node 22 before proposing a
  change; CI runs exactly that.
- Generated files are never edited by hand. Regenerate them with the source change and commit
  both: `data/codex-features/registry.json` (`node scripts/extract-features.mjs`), `public/v1/**`
  (`pnpm build:static`, `pnpm build:compat`), `public/design.css` (`pnpm build:ui`).
- Files under `data/*/sources/` are verbatim `openai/codex` snapshots. Never modify them.
- Annotations and hook entries must be grounded in the client's rustdoc, its menu copy, official
  documentation or observed behavior. Write "unconfirmed" rather than guess. Never include real
  usernames, workspace paths or tokens in examples.
- `data/codex-compat/` is maintained by the Codex Pass team. Do not change it unless the task
  explicitly asks for it.
- UI, theme or docs-page changes: read `DESIGN.md` first.
