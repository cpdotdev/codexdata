# Codex compatibility intelligence (compat)

Answers one question: **will the next Codex release break the configuration that Codex Pass
manages?** On every Codex CLI release the pipeline downloads the official binary, probes it and
publishes the hard facts as machine-readable JSON. The Codex Pass client polls that file and
shows broken configuration (with one-click cleanup) and upgrade warnings in Codex Doctor.

This dataset is produced by an automated probe and adjudicated by the Codex Pass team. It is
**not open for contribution** because its verdicts drive destructive actions in the client. If
you believe a verdict is wrong, open an issue with the Codex version and what you observed.

## Data flow

```
npm dist-tags (latest / alpha)
   │  .github/workflows/compat-watch.yml (every 6 hours)
   ▼
scripts/compat-probe.mjs        download binary → key-string probe / deprecation scan / config loadability / release notes
   ▼
data/codex-compat/probes/<version>.json     (probe facts, committed to the repository)
   │
   ├── data/codex-compat/tracked.json        (managed keys + human verdicts: statusOverride / action)
   ├── data/codex-compat/advisories/*.json   (human-written advisories, i18n)
   ▼
scripts/build-compat.mjs → public/v1/compat/codex/latest.json   (deterministic; --check guards drift)
   ▼
scripts/publish-compat.mjs → POST /admin/compat/publish → KV    (signed in the publish job; hot update)
   ▼
GET https://data.cp.dev/v1/compat/codex/latest.json             (KV first, static asset as fallback; ETag/304)
```

## Probe method and its limits

- **Key presence.** `config.toml` keys are serde field names, so they necessarily exist as
  strings inside the CLI binary. "Present in the previous stable, absent in this one" means the
  key was almost certainly removed (`disable_response_storage` is the precedent: after upstream
  removed it, not even the string survived in any later binary). False positives lean the safe
  way: a string that is still there but changed meaning is not detectable; a string that vanished
  is a near-certain removal.
- **Config loadability.** A `config.toml` is assembled with every shape Codex Pass manages and
  `codex features list` is run against it. Releases that reject the whole file (as 0.148/0.149
  did) fail here.
- **Deprecation notices.** The binary is scanned for `no longer supported` / `is deprecated`
  messages. Token boundaries are lost in the symbol table, so displayed text carries a few
  stray characters at either end; diffs anchor on the phrase ±24/40 characters and are stable
  across versions.
- **Not probeable.** The `[desktop]` table is read by the ChatGPT desktop app (asar), not the
  CLI binary (`probe: "none"`; status maintained by hand). A key whose semantics change under
  the same name is not detectable either; that is what advisories are for.
- **`daemon` table.** Keys with `table: "daemon"` live in the app-server daemon's
  `settings.json` (`$CODEX_HOME/app-server-daemon/settings.json`), not in `config.toml`. The
  daemon is the same binary as the CLI, so its serde field names (camelCase) are probed the same
  way. Presence only shows the mechanism still exists, not that the daemon is running.

## Handling a regression

The probe only reports facts. When a stable release shows a vanished key or a rejected config,
the workflow opens an `ops` issue (exit code 20) and still commits and publishes the data, so
clients see `status: "missing"` (display only, no action offered). After a human verdict:

- Removal confirmed → add `statusOverride: "removed"` and `action: "remove"` to `tracked.json`
  (only then does the client offer one-click cleanup).
- Upgrade risk → add an advisory under `advisories/` with all four locales (`zh`, `en`,
  `zh-TW`, `ja`, matching the client's locales).
- Run `pnpm build:compat`, commit, and publish (the workflow does it, or run
  `node scripts/publish-compat.mjs` by hand).

## Client contract

The payload schema is [data/codex-compat/compat.schema.json](../data/codex-compat/compat.schema.json);
the publish endpoint validates against it, so invalid data never reaches KV. Clients agree to:

- Offer a fix action only for keys with `action: "remove"`; `status: "missing"` is display only.
- Filter `advisories[]` by the installed Codex version against `affects.min` / `affects.max`
  (prerelease ignored in the comparison, matching the Codex Pass `codex_client_gate`
  convention). `clientAction: "hold-upgrade"` plus `codexPassFixedIn` drives the "update Codex
  Pass before updating Codex" reminder.
- Treat versions above `codex.maxProbedStable` as unverified.
- Degrade silently when the fetch fails (same pattern as the feature annotations: hourly refresh,
  10-minute backoff, on-disk cache).
