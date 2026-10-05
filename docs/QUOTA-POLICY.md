# Quota policy evidence and failure modes

The quota policy is a manually reviewed classification fallback, not account usage data. Its
evidence was checked against [OpenAI pricing](https://learn.chatgpt.com/docs/pricing) on
2026-10-05. Plus has a five-hour allowance and may also have weekly limits; Pro has no
five-hour limit and may have weekly limits. Other listed plan labels remain unconfirmed.

Failures that clients and dataset checks must handle:

- Official readings disagree with this snapshot: use the actual reported windows first.
- No readings and an unconfirmed or unknown plan: show no invented quota window. An empty
  `windows` array means unknown, not unlimited.
- Policy changes: review official evidence, increment `revision`, update `verifiedAt`, and
  regenerate the static dataset. Nothing here automatically monitors or deploys policy changes.
- Network outage, invalid response, unknown schema or older revision: retain the client's
  validated cache or bundled policy. Never erase known policy with a failed download.
- A malformed source could otherwise publish invented limits: strict validation rejects unknown
  fields, duplicate windows, unconfirmed nonempty windows, invalid dates, unsafe revisions,
  nonofficial source URLs and missing uncertainty notes.
- A wrong endpoint could return HTML: HTTP tests require JSON 404s for mistyped dataset paths,
  alongside 200, CORS, ETag/304 and discovery checks for the real endpoint.

This dataset contains no account identifiers, usage percentages, reserve preferences, reset
times or request counts. Consumers must not use classification alone to decide that an account
has remaining allowance. The JSON Schema is in `data/codex-quota/policy.schema.json`.
