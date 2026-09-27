# CodexData UI

The docs page is static HTML (`public/index.html`). Colors, typography and the docs layout come
from `@codexpass/tokens`, the shared Codex Pass design system (neutral white/gray light and dark themes with terracotta actions). That
package is vendored as a tarball under `vendor/` because the design-system repository is private;
`public/design.css` is generated from it by `scripts/build-ui.mjs` and checked for drift by
`pnpm validate`.

Rules:

- Never edit `public/design.css` by hand. Change the design system, vendor the new archive, run
  `pnpm install && pnpm build:ui && pnpm validate && pnpm test`, and commit the archive, the
  lockfile and the generated CSS together (see `vendor/README.md`).
- The header uses an inline approved CP mark that inherits light/dark neutral logo tokens.
- Theme behavior (system / light / dark toggle) lives in `public/theme.js`.
- Page changes never touch the data API, schemas, KV/DO or cache contracts.
- Static dataset links in the page are relative, so the HTML works from any host; live endpoints
  (`/v1/codex/*`, `/healthz`, `/v1/index.json`) are absolute links to the Worker origin declared
  in `<meta name="codexdata-live-origin">`.
- The "Data at a glance" panel (`public/status.js`) is progressive: without JS every link and
  all documentation still work. Check time and content-fetch time are shown separately, in UTC;
  a 503 shows "Needs attention", a network or data error shows "Unavailable".

Visual check: `node scripts/e2e/design-refresh.mjs` serves `public/` locally on port 5191 with
synthetic metadata and exercises Chromium and WebKit, the 503 and network-error states, no-JS,
and 320/390/1440 px widths in light and dark. First run `pnpm exec playwright install chromium webkit`.
Screenshots go to `.artifacts/design-refresh/` (override with `DESIGN_ARTIFACT_DIR`). It writes
no production data and is not part of CI.
