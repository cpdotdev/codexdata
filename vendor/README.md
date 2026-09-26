# Shared UI tokens

`codexpass-tokens-<version>-<sha256 prefix>.tgz` is the `@codexpass/tokens` package from the
Codex Pass design system (Ice Mint theme: `theme.css`, `docs.css`). The design-system repository
is private, so the package is vendored here instead of being installed from a registry;
`source.json` records the exact source tree and archive hash it was built from.

Do not edit the archive. To update it: build a new archive from the design system, add it here
(the filename carries its SHA-256 prefix), point `package.json` at the new file, run
`pnpm install && pnpm build:ui && pnpm validate && pnpm test`, and commit the archive, the
lockfile and the generated `public/design.css` together. Consumers build without any registry
credentials.
