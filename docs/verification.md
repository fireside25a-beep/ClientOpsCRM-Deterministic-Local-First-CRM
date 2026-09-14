# Verification evidence

This file separates proof executed during the 1.2.1 preparation pass from gates that could not be re-executed because their exact runtime dependency or live environment was unavailable.

Preparation date: 2026-09-06  
ClientOps Relay: 1.2.1  
Pinned n8n: 2.37.10

## Executed locally

| Gate | Result | Evidence |
| --- | --- | --- |
| C policy contracts | PASS | 13 generic cases and 100 byte-identical reference repetitions |
| Policy reference digest | PASS | `0ec3664b6826705d5b1fd5aade3f7e5a2061565f8942012133b036aac44509ab` |
| Policy HTTP wrapper | PASS | real compiled child through `/v2/qualify`; statuses `200`, `422`, `404`, `415` |
| ASan + UBSan | PASS | decision and HTTP paths; leak detection disabled because the sandbox restricts proc/ptrace behavior |
| Hermetic native supply chain | PASS | cJSON 1.7.19 files and archive hash pinned; no dynamic `libcjson`; GCC and Node bases locked by OCI index digest |
| Native build parity | PASS | Release, Debug, ASan, and UBSan emit the same reference bytes; each sanitizer also passes the 13-case corpus |
| Companion HTTP boundary | PASS | real C child; 20 byte-identical responses; `200/401/404/405/413/415/422`; startup/readiness/auth/secret checks |
| Workflow contracts | PASS | seven core, one optional adapter, 48 nodes, exact versions, reachability, Code syntax, generic adapter validation, Sheets/Slack injection handling |
| Backup integrity | PASS | workflow, encrypted-credential, and plan files protected by byte counts and SHA-256; tampering rejected |
| Installer/configuration | PASS | unsafe email/timezone rejected; mode `0600`; secrets preserved; UTC default; any/allowlist region modes |
| Deployment contracts | PASS | exact pins, migration dependency, disabled execution payloads, split secrets, runner readiness, timezone/region controls, no IP field |
| Deployment renderers | PASS | two byte-identical Railway/Render/Kubernetes/n8n Cloud trees; secret-free outputs; insecure/partial inputs rejected |
| Domain neutrality | PASS | 82 text/source/generated files plus compiled binary; historical terms allowed only in migration/upgrade fixtures |
| Documentation links | PASS | 14 Markdown files and 39 local links |
| Shell syntax | PASS | CLI, n8n bootstrap, database bootstrap/migrator, and Docker acceptance script |

The database and exact-n8n suites are real integration tests, not mocks, but they were not re-executed in this preparation environment because `@electric-sql/pglite` and the exact n8n CLI were unavailable locally and package fetching was unavailable. Their presence in the source tree is therefore not a current-run PASS claim.


## Current preparation - dependency-limited gates

| Gate | Current status | Reason |
| --- | --- | --- |
| Fresh database contracts | NOT RUN | `@electric-sql/pglite` 0.3.14 unavailable locally; package fetch unavailable |
| Seeded database upgrade | NOT RUN | same PGlite dependency |
| Exact n8n fresh/upgrade/refusal/current suite | NOT RUN | exact n8n 2.37.10 CLI unavailable locally |
| Docker acceptance / real PostgreSQL 16 stack | NOT RUN | Docker engine unavailable |
| Public ACME/TLS handshake | NOT RUN | requires real DNS and reachable public ports 80/443 |
| Live OAuth/provider adapters | NOT RUN | requires operator accounts and credentials |

## Not executed in the preparation environment

Docker was unavailable, so the following are authored acceptance gates—not claimed as locally passed:

| Gate | Command | Expected proof |
| --- | --- | --- |
| Compose model | `docker compose --env-file .env config --quiet` | Docker accepts all nine services and dependencies |
| Companion image | build/run in CI | pinned images resolve; `/healthz`, `/readyz`, authenticated `200`, and validation `422` pass |
| Complete stack | `./clientops verify` | images build and all health checks pass |
| PostgreSQL 16 migration | included in stack start | tracked migration completes before n8n initialization |
| Public webhooks | included in verify | `201`, `200`, `409`, `422`; generic support decision persisted |
| Auth isolation | included in verify | wrong/cross-role keys rejected |
| Policy recovery | included in verify | deliberate stop returns `503`; restart accepts same request |
| Real local delivery | included in verify | acknowledgement reaches Mailpit and owner alert reaches ntfy |
| Runtime privilege boundary | included in verify | application role cannot select the request table |
| Administrative transition | included in verify | contacted returns `200` and cancels SLA work |

The GitHub Actions workflow separates the native CRM core, Relay deterministic contracts, exact n8n compatibility, and Docker acceptance so presentation tooling cannot block the compiled application gate.

## Reproduce native proof

Install Node.js 22.22 or newer, a C11 compiler, and make. cJSON is already vendored and verified. Then:

```bash
npm ci
npm test
node scripts/render-deployments.mjs
node scripts/build-release-manifest.mjs
make -C policy-engine sanitize
```

Sanitizer binaries live in isolated build directories and never replace `policy-engine/build/policy_cli`. Portfolio rendering (`node scripts/render-portfolio.mjs`) is optional presentation tooling and is intentionally not a release gate for the application.

## Reproduce exact n8n bootstrap and stock upgrade

Use a disposable profile; never point this check at an existing n8n installation:

```bash
mkdir -p /tmp/clientops-n8n-2.37.10
npm install --prefix /tmp/clientops-n8n-2.37.10 n8n@2.37.10

N8N_BIN=/tmp/clientops-n8n-2.37.10/node_modules/.bin/n8n npm run test:exact-n8n

export PATH="/tmp/clientops-n8n-2.37.10/node_modules/.bin:$PATH"
export N8N_USER_FOLDER=$(mktemp -d)
export N8N_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef
export CLIENTOPS_PROJECT_ROOT=$PWD
export CLIENTOPS_INTAKE_API_KEY=1111111111111111111111111111111111111111111111111111111111111111
export CLIENTOPS_ADMIN_API_KEY=2222222222222222222222222222222222222222222222222222222222222222
export CLIENTOPS_DB_PASSWORD=temporary-contract-password

sh scripts/bootstrap-n8n.sh
n8n import:workflow --input=workflows/adapters/google-sheets-slack-gmail.json
n8n import:workflow --input=workflows/cloud/01-api-lead-intake.json
```

The automated command uses disposable profiles to prove a fresh bootstrap, an upgrade from the frozen
stock-v1 workflow set with credential ciphertext preservation, and customized fixed-ID refusal. The
manual commands below it reproduce only the fresh bootstrap. The optional adapter and Cloud hybrid
intake both import inactive.

## Truth boundary

The credential-free core contains real policy, database, queue, SMTP, and HTTP-push implementations. The Google Sheets, Slack, and Gmail adapter is structurally tested and exact-version import-tested only because no live OAuth accounts were supplied. Its live checklist is in [adapters.md](adapters.md).

The Railway, Render, and Kubernetes artifacts are generated configurations, not live deployments. The n8n Cloud artifact is an import-validated hybrid intake, not a claim of live Cloud/provider integration; it still requires operator-supplied HTTPS, PostgreSQL, credentials, and the separately running operational workflows described in the [deployment guide](../deploy/README.md).
