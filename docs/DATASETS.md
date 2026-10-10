# Datasets

Reference for the static datasets served by CodexData. Everything on this page is **pregenerated
into `public/`** (`scripts/build-static.mjs`, `scripts/build-compat.mjs`) and served by the
Workers static-asset layer; those requests never invoke the Worker. The Worker only runs for the
live catalog mirror (`/v1/codex/*`), `/v1/index.json`, `/healthz`, `/admin/*`, the KV-first
compat endpoint, and JSON 404s on unknown dataset paths. Not affiliated with OpenAI.

All dataset responses carry `Access-Control-Allow-Origin: *`, a strong `ETag` (send
`If-None-Match`, get `304`), and `Cache-Control: public, max-age=3600` (see `public/_headers`).
The `latest.json` files of the quota policy, feature-flag registry, hook registry and compat
payload also carry `X-CodexData-Signature` (Ed25519; see [DATA-SIGNING.md](DATA-SIGNING.md)).

One asset-layer limitation (confirmed in production): `OPTIONS` on a dataset URL returns `405`;
the asset layer only serves `GET`/`HEAD`. Plain browser `fetch` and HTTP-cache revalidation are
unaffected (no preflight); only JavaScript that manually sets `If-None-Match` from a cross-origin
page trips a preflight. Server-side and native clients are unaffected.

## Quota window policy — `/v1/quotas/codex/`

`latest.json` serves the reviewed `data/codex-quota/policy.json`; `index.json` provides its
revision, latest URL, documentation and license. It is discoverable as `codex_quota_policy`
in `/v1/index.json`. Source and generated payload are byte-identical after formatting.

The envelope contains `dataset: "codex-quota-policy"`, `schemaVersion: 1`, a positive safe
integer `revision`, a calendar-date `verifiedAt`, official HTTPS `sources`, and `plans` keyed
by lowercase plan labels. Each plan has unique `windows` (`short`, `weekly`, `monthly`),
`evidenceStatus` (`confirmed` or `unconfirmed`), and a nonempty evidence `note`. Unconfirmed
plans must have an empty window list. `short` denotes a five-hour allowance in this policy.

Live account readings take priority. Without readings, use only confirmed classifications
from a compatible validated policy. Unknown and unconfirmed plans supply no windows; empty
does not mean unlimited. Clients can bundle this file and retain a validated cache when the
network fails. Accept updates by monotonically increasing revision, and preserve user reserve
preferences independently. There are no usage percentages, reset times or quota amounts here.
See [evidence and failure modes](QUOTA-POLICY.md) before changing policy.

## Feature-flag registry — `/v1/features/codex/`

What every `[features]` flag in the Codex client actually is, per verified client tag. Machine
facts are extracted deterministically from the client's own `codex-rs/features` sources
(`data/codex-features/sources/`, Apache-2.0); annotations are human-curated, one file per flag
under `data/codex-features/annotations/` (CC-BY-4.0).

| URL                                      | Content                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| `latest.json`                            | Merged registry for the latest verified tag                 |
| `<tag>.json` (e.g. `rust-v0.153.4.json`) | Same, for that tag; alias tags serve their snapshot's bytes |
| `index.json`                             | Verified tags, snapshot mapping, notes, license             |

### Payload shape (`latest.json` / `<tag>.json`)

```jsonc
{
  "dataset": "codex-feature-flags",
  "snapshot_tag": "rust-v0.153.4", // the source snapshot this body was built from
  "applies_to": ["rust-v0.153.1", "rust-v0.153.4"], // verified tags with byte-identical sources
  "counts": { "total": 135, "annotated": 135, "locales": { "zh": 135 } },
  "flags": [ /* sorted by key, see below */ ],
  "source": { "files": [...], "license": "...", "not_affiliated_with_openai": true }
}
```

### Flag fields

| Field                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                                | The `[features]` config key / `codex features enable <key>` name                                                                                                                                                                                                                                                                                                                                                                                           |
| `variant`                            | Rust enum variant name in the client source (e.g. `undo` → `GhostCommit`)                                                                                                                                                                                                                                                                                                                                                                                  |
| `stage`                              | Lifecycle stage; strings match `codex features list` output exactly: `stable`, `experimental`, `under development`, `deprecated`, `removed`                                                                                                                                                                                                                                                                                                                |
| `default_enabled`                    | `true` / `false`, or `null` when platform-conditional                                                                                                                                                                                                                                                                                                                                                                                                      |
| `default_expr`                       | Present only when `default_enabled` is `null`: the raw Rust expression (currently only `cfg!(windows)`, for `secret_auth_storage`)                                                                                                                                                                                                                                                                                                                         |
| `doc`                                | The client's own rustdoc comment for the flag (English, verbatim; multi-line collapsed to one paragraph)                                                                                                                                                                                                                                                                                                                                                   |
| `experimental`                       | For `experimental`-stage flags: OpenAI's own `/experimental` menu copy, `{ name, menu_description, announcement }` (`announcement` may be `null`); otherwise `null`                                                                                                                                                                                                                                                                                        |
| `stage_condition` / `stage_fallback` | Present only when the stage itself is platform-conditional (currently only `prevent_idle_sleep`): `stage` is the value under the listed platforms, `stage_fallback` elsewhere                                                                                                                                                                                                                                                                              |
| `legacy_aliases`                     | Older config keys the client still maps to this flag (from `legacy.rs`), e.g. `chronicle` ← `telepathy`, `apps` ← `connectors`                                                                                                                                                                                                                                                                                                                             |
| `history`                            | Across verified tags: `first_seen`, `last_seen`, `stages` (stage transitions with the tag they appeared at), `delisted_after` if the key vanished from the table entirely. **`first_seen` is bounded by the earliest verified tag** (`rust-v0.148.0`); a flag "first seen" there may well predate it                                                                                                                                                       |
| `annotation`                         | Human-curated layer, or `null` if not yet covered: optional `aka` (observed user-facing name, e.g. chronicle = "Computer History") plus `i18n` locale blocks (`{ title, summary, note?, risk? }` per locale; `zh` today, more languages via community PRs, see `CONTRIBUTING.md`). Grounded in the official docs, never invented; unconfirmed meanings say so (e.g. the `psp` acronym). Source: one file per flag under `data/codex-features/annotations/` |

### Consumption rules

- **Display enrichment only.** The authoritative flag list for a machine is always its local
  `codex features list`; this dataset adds names, context and history on top. If the fetch fails,
  degrade to showing raw keys.
- Flags with `stage` `removed` / `deprecated` are kept because the client still parses the keys;
  don't offer them as toggles.
- Nine flags are documented by the client as **requirements-only gates** (`browser_use*`,
  `computer_use`, `in_app_*`): meant to be set from system-level `requirements.toml`, not user
  config. Their annotations say so.

## ModelInfo JSON Schema — `/v1/schema/codex-model-info/`

JSON Schema (2020-12) of the Codex client's rejection rules for a `GET /models` response: required
fields, JSON types, closed enums. One schema covers every verified tag (all struct changes across
them are additive with serde defaults); each tag URL serves the same bytes. The mirror validates
every catalog it publishes against this same schema. Details and per-tag notes:
`data/codex-schema/tags.json`, served at `index.json`.

| URL                          | Content                                            |
| ---------------------------- | -------------------------------------------------- |
| `latest.json` / `<tag>.json` | The schema (identical bytes for all verified tags) |
| `index.json`                 | Verified tags, source files, change notes, license |

## Hook product registry — `/v1/hooks/codex/`

Versioned, display-only product identification: distinctive hook script paths, purpose, removal
impact and reviewed evidence, with optional embedded product icons. `latest.json` contains the
full registry; `index.json` links to it and to the contribution guide. Schema, evidence rules and
the consumer contract: [HOOKS.md](HOOKS.md).

## Compatibility intelligence — `/v1/compat/codex/latest.json`

Which managed `config.toml` keys each Codex release still accepts, whether a Codex-Pass-shaped
config still loads, deprecation notices found in the binary, and human-written advisories.
Served KV-first by the Worker (hot-published on every probe) with the committed file as static
fallback. Pipeline, probe limits and the client contract: [COMPAT.md](COMPAT.md). Maintained by
the Codex Pass team; not open for contribution.

## Versioning and updates

- A "verified tag" is a Codex release whose relevant sources are vendored in this repository and
  from which the artifacts are deterministically rebuilt (`pnpm validate` fails on any drift).
- New tags are added per release; see [RUNBOOK.md](RUNBOOK.md#adding-a-new-codex-tag). Newly
  introduced flags may temporarily lack an `annotation` (CI warns, doesn't fail); consumers must
  tolerate `annotation: null`.
- `index.json` URLs are absolute, baked from the configured public origin at build time.

## Licenses

Registry, annotations, schema, compat and hook data: CC-BY-4.0 (`data/LICENSE-DATA`), derived
from openai/codex sources (Apache-2.0, reproduced with `LICENSE` + `NOTICE` under the respective
`sources/` directories). Annotations are community commentary grounded in the client's own doc
comments and observed behavior, **not OpenAI documentation**. Product icons retain their owners'
rights.
