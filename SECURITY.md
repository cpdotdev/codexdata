# Security policy

CodexData runs a public Cloudflare Worker with token-protected `/admin/*` endpoints and holds
the OAuth tokens of one dedicated ChatGPT account. If you find a way to alter published data,
reach the admin endpoints without the token, or extract those tokens, please report it privately:

- GitHub private vulnerability reporting: https://github.com/cpdotdev/codexdata/security/advisories/new
- Please do not open a public issue for security problems.

In scope: the Worker (`src/`), the sync and publish scripts (`scripts/`), the GitHub Actions
workflows, and the served datasets. Out of scope: OpenAI's services, the contents of the
official catalog, and the Codex client itself.

We acknowledge reports as quickly as we can and credit reporters in the fix unless they prefer
otherwise.
