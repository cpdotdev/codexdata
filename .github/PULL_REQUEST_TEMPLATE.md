## What

<!-- One concern per PR: one language, one product, one Codex tag, or one fix. -->

## Evidence

<!-- Annotations / translations: the rustdoc, menu copy or observed behavior each claim rests on.
     Hook products: the official documentation or the redacted local observation. -->

## Checklist

- [ ] `pnpm validate && pnpm build:static` pass locally (Node 22) and the regenerated `public/` files are committed
- [ ] No guessed meanings; unconfirmed points are marked as such in `note`
- [ ] No real usernames, workspace paths, tokens or private hook files
- [ ] `data/codex-compat/` and `data/*/sources/` untouched (see CONTRIBUTING.md)
