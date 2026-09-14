# Security

## Supported release

ClientOps Relay 1.2.1 is the supported source line in this package. Security reports should include the exact release hash, deployment mode, and a minimal reproducer. Do not include live secrets in reports.

## Default trust boundary

The default deployment is loopback-first. Traefik is the only host-published application edge (`127.0.0.1:8080/8443` in local mode); n8n publishes no host port. PostgreSQL publishes no host port. Mailpit (`127.0.0.1:8025`) and ntfy (`127.0.0.1:8081`) remain local diagnostic/delivery services. Docker's `data` and `automation` networks are internal. The edge does not mount the Docker socket.

`./clientops set-public HOST EMAIL` is the explicit transition to Internet-facing mode. It requires a lowercase public DNS hostname and ACME contact email, binds only ports 80/443 publicly, uses HTTPS as the public n8n origin, and keeps one proxy hop. Public certificate issuance still depends on real DNS plus inbound reachability to the configured host; configuration generation alone is not evidence that a public certificate was issued.

## Edge controls

The checked-in edge generator enforces:

- Traefik `3.7.12`, not an unbounded `latest` tag;
- HTTP-to-HTTPS redirect;
- public ACME HTTP-01 mode or a loopback-only self-signed development certificate;
- `core.strictTLSOptions=true` and explicit minimum TLS 1.2;
- request-path sanitization;
- rejection of aliased request-header names;
- a 64 KiB request-header ceiling;
- a 1 MiB webhook body ceiling;
- separate route rate limits for intake, administrative updates, and the n8n editor;
- exact public webhook paths only (`/webhook/clientops/leads` and `/webhook/clientops/leads/contacted`);
- generated Basic Auth in front of all remaining n8n routes;
- security response headers; HSTS is enabled only in public mode;
- read-only edge container filesystem, bounded tmpfs, dropped capabilities except `NET_BIND_SERVICE`, and `no-new-privileges`.

Traefik is the single trusted reverse proxy in this deployment. ClientOps does not enable Traefik's insecure forwarded-header trust mode. n8n is configured with `N8N_PROXY_HOPS=1`, `N8N_SECURE_COOKIE=true`, `N8N_EDITOR_BASE_URL`, and `N8N_WEBHOOK_URL` derived from the generated public origin.

## API and application controls

Intake and administrative transitions use independent generated secrets. Unknown fields, control characters, oversized payloads, malformed UUIDs/keys, and missing consent are rejected. The policy service bounds request size, concurrency, subprocess time, and output size. n8n Code nodes cannot read environment variables; command/file nodes are excluded. n8n execution-payload persistence is disabled.

The database runtime role is function-scoped: it does not receive direct SELECT rights over the request table. Request acceptance and initial outbox creation are transactional. Delivery is at least once, so downstream receivers should tolerate duplicate messages after a provider-accept/crash window. Leases and fencing prevent stale workers from completing a newer worker's claim.

## Data handling

The ClientOps business schema does not store source IP addresses or IP-derived values. The Traefik edge does emit an access log by default; operators that require an end-to-end no-IP-retention policy must configure edge/log-platform retention or disable/transform access logging according to their legal and operational requirements. Application/delivery data is retained for 90 days by default, sanitized workflow failures for 30 days, and Mailpit messages for 90 days.

## Secrets

`./clientops setup` writes `.env` mode `0600` and refuses to overwrite it. The `runtime/` directory remains mode `0700`. The three files bind-mounted into the non-root Traefik container are mode `0644` so the container can read them; `edge-users` contains only the one-way Basic Auth hash, while the generated plaintext edge password remains only in the mode-`0600` `.env`. All generated runtime files are excluded from source control. Do not commit `.env`, `runtime/`, volume backups, ACME account material, or live provider credentials. Rotate a secret if it is exposed; do not rely on repository deletion alone.

## Before public exposure

1. Back up the environment, PostgreSQL volume, and n8n volume.
2. Point the intended DNS hostname to the deployment host.
3. Run `./clientops set-public HOST EMAIL`.
4. Start the stack and confirm ACME certificate issuance and HTTPS externally.
5. Verify editor edge authentication, intake/admin API-key separation, route rate limiting, and expected webhook results.
6. Configure host firewall, OS patching, monitoring, backup retention, and external log retention.
7. Re-run `./clientops verify` on a Docker-capable host.

Generated configuration and local contract tests are not substitutes for an external Internet-facing acceptance test.
