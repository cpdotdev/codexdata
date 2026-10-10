# CodexData

Open datasets for the [OpenAI Codex](https://github.com/openai/codex) client, served as JSON
from **https://data.cp.dev**.

**Not affiliated with, endorsed by, or maintained by OpenAI.** "Codex" refers to OpenAI's Codex
client. CodexData is an independent mirror and dataset for it, run by the
[Codex Pass](https://console.cp.dev) team.

## Datasets

| Dataset                        | Endpoint                                                                        | Built from                                                                                                                        | Contributions                               |
| ------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Official catalog mirror**    | `/v1/codex/models.json` (+ `meta.json`, `snapshots/index.json`, `changes.json`) | Live: the exact `{"models":[...]}` envelope from `chatgpt.com/backend-api/codex/models`, synced hourly with one dedicated account | none (relayed as-is)                        |
| **ModelInfo JSON Schema**      | `/v1/schema/codex-model-info/latest.json`, `/<tag>.json`, `/index.json`         | `data/codex-schema/`: what makes the client reject a whole `/models` response, derived from its own source per verified tag       | new Codex tags                              |
| **Feature-flag registry**      | `/v1/features/codex/latest.json`, `/<tag>.json`, `/index.json`                  | `data/codex-features/`: every `[features]` flag per verified tag, extracted from `codex-rs/features`, plus curated annotations    | **annotations and translations**            |
| **Hook product registry**      | `/v1/hooks/codex/latest.json`, `/index.json`                                    | `data/codex-hooks/`: known hook script paths, purpose and removal notes, optional product icons                                   | **product entries and icons**               |
| **Compatibility intelligence** | `/v1/compat/codex/latest.json`                                                  | `data/codex-compat/`: which managed `config.toml` keys each Codex release still accepts, probed automatically on every release    | maintained by the Codex Pass team; not open |

Voice API test audio: [`/v1/audio/samples/index.json`](https://data.cp.dev/v1/audio/samples/index.json) lists original Chinese and English WAV samples, their transcripts and SHA-256 checksums. See [audio samples](docs/AUDIO.md).

Quota policy: `/v1/quotas/codex/latest.json` classifies confirmed plan quota windows as a
fallback when live readings are unavailable. Source: `data/codex-quota/policy.json`; evidence,
update procedure and failure modes: [quota policy](docs/QUOTA-POLICY.md). Unknown windows remain
unconfirmed; this dataset contains no account usage or allowance amounts.

Discovery: `/v1/index.json`. Health: `/healthz`. Field reference for every dataset:
[docs/DATASETS.md](docs/DATASETS.md); compat details: [docs/COMPAT.md](docs/COMPAT.md); hook
products: [docs/HOOKS.md](docs/HOOKS.md).

## How it is served

- **Cloudflare Worker** (`wrangler.jsonc`, custom domain `data.cp.dev`). The live mirror
  (`/v1/codex/*`, `/v1/index.json`, `/healthz`, `/admin/*`) is Worker code backed by KV and a
  Durable Object. Everything else is pregenerated into `public/` by `scripts/build-static.mjs`
  and `scripts/build-compat.mjs` and served by the Workers static-asset layer with
  `public/_headers`; those requests never invoke the Worker.
- **Catalog sync** (`.github/workflows/sync.yml`, hourly). Cloudflare Workers cannot reach
  `chatgpt.com` (403 from the edge), so a GitHub-hosted runner leases a short-lived access token
  from the Worker, fetches the catalog and pushes it back for validation and publishing. The
  refresh token never leaves the Worker. Details: [docs/RUNBOOK.md](docs/RUNBOOK.md).
- **Catalog signature.** `/v1/codex/models.json` (including `304` responses) and
  `/v1/codex/snapshots/<hash>.json` carry `X-CodexData-Signature: v1.<kid>.<signature>` once the
  sync job signs: an Ed25519 signature (base64url, no padding) over the UTF-8 bytes of
  `"codexdata-catalog-v1\n"` followed by the exact response body; `kid` is the first 16 hex
  characters of SHA-256 of the raw 32-byte public key. The private key lives only in the sync
  job's GitHub environment, and the Worker publishes a signed catalog only after verifying it.
  Clients should verify the header with embedded public keys instead of trusting the transport;
  `meta.json` → `signature_kid` names the current key. Details:
  [docs/RUNBOOK.md](docs/RUNBOOK.md#catalog-signing).
- **Compat watch** (`.github/workflows/compat-watch.yml`, every 6 hours). Downloads each new
  Codex CLI release, probes it, commits the results and hot-publishes them to KV.

## Notes

- The mirror is a server-side use of the Codex client's public OAuth flow with a dedicated
  ChatGPT account. OpenAI can change or revoke that at any time; the mirror then keeps serving
  the last successfully fetched catalog and `/healthz` turns 503.
- The catalog reflects that one account's plan and rollout view (`meta.json` →
  `source.plan_label`).
- `/v1/codex/*` bodies include OpenAI's model instructions verbatim because the Codex client
  requires them. They are relayed as-is; CodexData grants no license over them.
- A Codex client discards the **entire** `/models` response if any single entry fails to parse.
  The mirror validates every catalog it publishes against the ModelInfo schema above; clients
  that add entries of their own should do the same before serving them.
- Feature-flag annotations are community commentary grounded in the client's own doc comments
  and observed behavior, not OpenAI documentation. Entries say so where a meaning is unconfirmed
  (for example the `psp` acronym). The machine-extracted facts (stage, defaults, official copy)
  are reproducible from the snapshots under `data/codex-features/sources/`; CI fails if the
  committed registry drifts from them.
- The authoritative flag list for a given machine is always its local `codex features list`;
  the registry is display enrichment on top.

## Development

Node 22 (`.node-version`) and pnpm via corepack.

```bash
corepack enable && pnpm install
pnpm check          # typecheck + prettier + validate + tests (what CI runs)
pnpm typecheck      # wrangler types + tsc
pnpm validate       # data/*: schemas compile, snapshots present, extractor + static artifacts byte-match
pnpm test           # vitest (workers pool / Miniflare; no network)
pnpm dev            # local Worker on http://localhost:8787

# data pipelines: outputs are committed, validate fails on drift
node scripts/extract-features.mjs   # sources/*.rs -> data/codex-features/registry.json
pnpm build:static                   # data/* -> public/v1/** + public/_headers
pnpm build:compat                   # data/codex-compat -> public/v1/compat/codex/latest.json
```

Deploys are manual (`Deploy` workflow) after CI is green; see [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Contributing

Annotations, translations, hook products and new Codex tags are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); it has the review bar (grounded claims only), the file
layout and the two commands you need. Bugs and questions go to
[issues](https://github.com/cpdotdev/codexdata/issues).

## Licenses

Code: MIT ([LICENSE](LICENSE)). Datasets under `data/`: CC-BY-4.0
([data/LICENSE-DATA](data/LICENSE-DATA)). Vendored `openai/codex` source snapshots under
`data/*/sources/` keep their Apache-2.0 license and NOTICE. Third-party product icons retain
their owners' rights and are excluded from both licenses (see `icon.rights` in each product and
[docs/HOOKS.md](docs/HOOKS.md#product-icons)). `/v1/codex/*`: no license granted (OpenAI's
content, relayed as-is).
