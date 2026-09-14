# Trusted edge

ClientOps Relay 1.2.1 places n8n behind Traefik. n8n no longer publishes a host port. The edge is generated from the private `.env` by `scripts/configure-edge.mjs`; generated runtime files are intentionally excluded from source control.

Two modes exist:

- `local`: HTTPS is bound only to `127.0.0.1:8443`; Traefik uses its generated local certificate and browsers/curl will not trust it by default. This mode is not internet exposed.
- `public`: `./clientops set-public HOST EMAIL` switches the edge to ports 80/443, requests an ACME certificate, sets n8n's public HTTPS origin, enables secure cookies, and keeps `N8N_PROXY_HOPS=1`.

Only `/webhook/clientops/leads` and `/webhook/clientops/leads/contacted` are exposed as API routes. They remain API-key protected by ClientOps itself and receive independent edge rate/body controls. Arbitrary n8n webhook paths are not exposed by the API routers. All other n8n routes fall through to the editor router and are additionally protected with generated edge Basic Auth. PostgreSQL is never published. Mailpit and ntfy remain loopback-only diagnostic/local services.

Run `./clientops set-local` to return to loopback-only mode.

Hardening is explicit: aliased request-header names are rejected, request paths are sanitized, request headers are capped at 64 KiB, webhook bodies at 1 MiB, TLS is at least 1.2, TLS option conflicts fail closed, and Traefik does not mount the Docker socket. Do not enable insecure forwarded-header trust unless you intentionally introduce and pin an additional upstream proxy; the shipped topology has exactly one proxy hop.
