# Signing the other datasets

Since 2026-10-10 the official catalog mirror is signed (RUNBOOK "Catalog signing"). The Codex
Pass client also reads four other datasets from data.cp.dev, and before this change it trusted
them on TLS alone. Anyone with the Cloudflare API token, the `ADMIN_TOKEN`, KV write access, or a
custom mirror address could change them for every client. This document records what each
dataset controls, where its signature is made, and how the client falls back. The operating steps
are in [RUNBOOK.md](RUNBOOK.md#data-signing).

## What each dataset controls (highest impact first)

| Dataset             | Path                                               | What a forged copy could do in the client                                                                                                                                                                                                                                           | Fallback without a verified copy                                                                 |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Compat              | `/v1/compat/codex/latest.json` (KV, hot-published) | Offer one-click removal of top-level `config.toml` keys (`action: "remove"`; only the App's own routing keys are protected). Show "hold the upgrade" advisories at startup, in Doctor and in the capability scan, with links. Mark Codex versions as "issues" or "no known issues". | No report: the Doctor block is hidden, one-click removal is refused, versions show "unverified". |
| Quota policy        | `/v1/quotas/codex/latest.json` (static)            | Choose which quota windows, and so which stop-line controls, the App shows before the first reading. Readings always win and the gate itself never reads the policy. A forged `revision` near 2^53 would also pin the cache, because older revisions are refused.                   | The policy bundled with the App.                                                                 |
| Hook registry       | `/v1/hooks/codex/latest.json` (static)             | Doctor text for each detected hook product: summary, removal instructions, reference links.                                                                                                                                                                                         | No descriptions.                                                                                 |
| Feature annotations | `/v1/features/codex/latest.json` (static)          | Titles, notes, risk text and lifecycle hints on the feature-flag page. The flag list and its toggles come from the local `codex features list`.                                                                                                                                     | Plain flag names.                                                                                |
| Voice samples       | `/v1/audio/samples/*.wav`                          | Nothing: the client ships the expected SHA-256 and size of each file and refuses any other bytes.                                                                                                                                                                                   | Not signed; no change.                                                                           |

## Format

The format is catalog format v1 with a different context string per dataset:

- Signed bytes: the context string, then the exact response body (raw file bytes; never
  re-serialized).
- Pure Ed25519 (RFC 8032). Public key: raw 32 bytes, base64url without padding. `kid`: the first
  16 lowercase hex characters of SHA-256(raw public key).
- Header: `X-CodexData-Signature: v1.<kid>.<64-byte signature, base64url without padding>`. A
  response with the header more than once is refused.

| Dataset              | Context string                  |
| -------------------- | ------------------------------- |
| Quota policy         | `"codexdata-quota-policy-v1\n"` |
| Feature annotations  | `"codexdata-features-v1\n"`     |
| Compat               | `"codexdata-compat-v1\n"`       |
| Hook registry        | `"codexdata-hooks-v1\n"`        |
| (catalog, unchanged) | `"codexdata-catalog-v1\n"`      |

No context string is a prefix of another, so a signature for one dataset never verifies as
another.

## The key

The datasets use their own key, `DATA_SIGNING_KEY`, in a separate environment `data-signing`
whose deployment branch rule admits only `main`. The catalog key stays where it is.

- The catalog is signed every hour from what chatgpt.com returns. These datasets are signed from
  reviewed repository content. Separate keys give separate blast radii and separate rotations.
- Neither key enters a job that runs third-party code. The Deploy job runs `pnpm install`, and
  the compat probe runs downloaded Codex binaries. Signing therefore happens in a small extra job
  that checks out the commit and runs `scripts/data-signature.mjs` with Node built-ins only, and
  only signatures (public data) leave that job.
- The signing jobs run the scripts on `main`, so nothing that runs third-party code may be able
  to change `main` either. No such job holds a token that can push: the compat probe and the
  Codex tag sync run with read-only tokens and hand their data changes to a second job as a patch.
  That job runs no third-party code and applies the patch only if it adds, changes or deletes
  regular files under the dataset paths (`scripts/apply-data-patch.mjs`); a change to a script, a
  workflow, a symlink or an executable bit is refused. CI, Deploy and the catalog sync already
  had read-only tokens.
- Pull request workflows cannot read the secret (branch rule), and the signing jobs also check
  `github.ref == 'refs/heads/main'`. A side effect: Deploy can no longer run from other branches.

## Where signatures are made

**Static datasets (Deploy workflow).** The `sign` job signs the three committed `latest.json`
files of the commit being deployed and outputs `{path: header}`. The `deploy` job checks each
signature against its own checkout and the `DATA_SIGNING_PUBLIC_KEYS` var in `wrangler.jsonc`,
then appends one exact-path rule per file to `public/_headers` before `wrangler deploy`. The asset
layer serves the body and the header from the same deployment, so they cannot get out of step. A
signature that does not verify fails the deploy. Without the secret the deploy goes out unsigned,
unless `DATA_SIGNATURE_REQUIRED` is `"true"`.

**Compat (Compat watch workflow).** The probe job no longer commits or publishes. The `commit`
job applies its data-only patch and pushes it; a new `publish` job runs the scripts of the commit
the run started on, refuses a pushed commit that is not on `main`, reads only
`public/v1/compat/codex/latest.json` from it, signs those bytes and posts them with the header to
`/admin/compat/publish`. The Worker verifies the signature against `DATA_SIGNING_PUBLIC_KEYS`,
stores the exact bytes (it used to re-serialize them) with the signature in the KV metadata, and
serves both. The ETag covers body and signature, so a re-signed body is fetched again. A bad
signature is always refused; an unsigned post is refused once `DATA_SIGNATURE_REQUIRED` is
`"true"`.

## Client behaviour

- A 2xx body is used only if its signature verifies with a key embedded in the App for that
  dataset. Unsigned or invalid responses never replace the cache. They are logged as warnings
  (reason only, no key material) and retried after the normal 10-minute backoff.
- The disk cache stores the signed body and its header, not parsed data. It is verified again
  every time it is loaded, so an edited file is ignored. Caches written by earlier versions have
  no signature, so they are ignored and downloaded again.
- A `304` reuses the cached body and signature, which were verified when they were loaded.
- Fallback order: fresh verified response, then the last verified cache, then the bundled policy
  (quota) or nothing (compat, hooks, features; see the table). The bundled default is never
  replaced by unverified data.
- A custom mirror must forward the body and the `X-CodexData-Signature` header unchanged, as it
  already must for the catalog.

## Known limits

- **Rollback.** Like the catalog, a signature carries no timestamp. Someone who can serve files
  for data.cp.dev can serve any older signed copy. The quota policy still refuses lower revisions;
  the other datasets have no ordering. A format v2 would sign a timestamp or counter.
- **The signature means "on `main` when signed", not "reviewed".** Anyone who can push to `main`
  can get content signed. The compat probe's data reaches `main` without review by design (only
  probe files and the compat payload), and that payload is signed automatically.
- **Compat before its first signed publish.** The Worker falls back to the static compat file
  when KV is empty, and that response has no signature, so clients treat compat as unavailable
  until the next publish. The fallback is served `no-store`, so the edge does not keep it after
  that publish.
- **Deploy secrets.** The Cloudflare token and `ADMIN_TOKEN` are repository secrets, readable by
  workflows on any branch. With signing, misuse can only serve older signed or unsigned content,
  which clients refuse. Moving them into a `main`-only environment would close that too.
