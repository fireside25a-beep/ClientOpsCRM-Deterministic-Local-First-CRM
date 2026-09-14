# Changelog

## 1.2.1 CI portability fix — 2026-09-14

- Fixed Docker acceptance on fresh Linux hosts by rendering Traefik bind-mounted configuration files mode `0644` inside the still-private mode `0700` runtime directory. The plaintext edge password remains in `.env` mode `0600`; `edge-users` contains only its one-way hash.
- Corrected the external n8n task-runner health probe from port `5681` to the runner image's observed health endpoint on port `5680`.
- Added regression assertions for edge-file readability and the task-runner health endpoint.

## 1.2.1 - 2026-09-06

- Refreshed the TLS edge pin to Traefik 3.7.13 with its verified multi-platform OCI index digest.

- Added a pinned Traefik 3.7.13 trusted edge and removed direct n8n host exposure.
- Switched generated public n8n identity to HTTPS with secure cookies, `N8N_WEBHOOK_URL`, `N8N_EDITOR_BASE_URL`, and exactly one proxy hop.
- Kept PostgreSQL unpublished and Mailpit/ntfy loopback-only.
- Added exact webhook routing, editor edge authentication, route-specific rate controls, 1 MiB webhook-body buffering limit, aliased-header rejection, path sanitization, 64 KiB header limit, strict TLS option handling, and explicit TLS 1.2 minimum.
- Added deterministic local/public/local reverse configuration tests and release-level byte/adversarial audits.
- Added Apache-2.0 project licensing metadata and a complete scientific documentation/research package in the AIO distribution.

## 1.2.0 fixed build — 2026-08-11

- Tightened the companion API to accept only JSON with UTF-8 encoding and reject malformed UTF-8 before policy execution.
- Added exact runtime validation for successful and validation-error policy response contracts.
- Added cross-origin isolation and sensitive-feature denial response headers.
- Hardened the companion container build with exact-file inputs, PIE, stack protection, FORTIFY, RELRO/NOW, a non-executable stack, stripped build metadata, and a numeric non-root runtime user.
- Expanded companion tests across all reachable routing classes, media-type boundaries, malformed UTF-8, response schemas, and container build constraints.

## 1.2.0 — 2026-08-11

- Vendored and hash-pinned cJSON 1.7.19; removed the host/runtime `libcjson` dependency.
- Isolated Release, Debug, ASan, and UBSan native outputs and added deterministic cross-build parity plus native-linkage checks.
- Added an authenticated, bounded companion service that executes the real compiled policy through `/v2/qualify`.
- Added deterministic Railway, Render, Kubernetes, and inactive n8n Cloud hybrid-intake renderers with secret references only.
- Added a pre-migration workflow customization gate and SHA-256 verification for copied workflow/credential/bootstrap state.
- Pinned companion build/runtime container bases by verified multi-platform image-index digest.
- Preserved the seven local core workflows, database contract, migration history, and optional OAuth adapter boundary from 1.1.

## 1.1.0 — 2026-08-10

- Replaced vertical-specific qualification with bounded, config-driven request triage for sales, support, partnership, and operator-defined categories.
- Added universal region behavior: worldwide by default, optional user-selected allowlist, and no inferred phone country code.
- Added user-selectable IANA timezone shared by n8n schedules and PostgreSQL business-day calculations; fresh installs default to UTC.
- Added generic category, score, serviceability, urgency, route, acknowledgement, SLA, and adapter contracts without removing public webhook capabilities.
- Added transactional v1→v1.1 database migration with checksum tracking, legacy route mapping, preserved history/queue state, and idempotent reruns.
- Added guarded n8n workflow upgrade with encrypted backups, semantic stock-workflow fingerprints, fixed-ID preservation, and customization refusal.
- Added compiled policy HTTP tests, seeded upgrade tests, domain-neutrality checks, and universal portfolio assets/documentation.

## 1.0.0 — 2026-08-10

- Added seven production-minded n8n workflows for intake, delivery, SLA, digest, contact state, retention, and sanitized errors.
- Added deterministic C qualification policy and bounded HTTP wrapper.
- Added PostgreSQL idempotency and transactional-outbox contracts.
- Added Mailpit and ntfy delivery with retry, lease fencing, and dead-letter behavior.
- Added split intake/admin authentication and least-privilege database access.
- Added privacy-safe execution settings, zero IP retention, and timed data retention.
- Added optional Google Sheets/Slack/Gmail adapter with Sheets upsert and formula neutralization.
- Added native contracts, exact n8n import/publish checks, Docker black-box acceptance, CI, portfolio visuals, and operational documentation.
