# HTTP API

ClientOps Relay exposes two POST webhooks through n8n. The local base URL is `http://127.0.0.1:5678`.

| Endpoint | Credential header | Purpose |
| --- | --- | --- |
| `POST /webhook/clientops/leads` | `X-ClientOps-Intake-Key` | validate, triage, and accept a request |
| `POST /webhook/clientops/leads/contacted` | `X-ClientOps-Admin-Key` | mark a ticket contacted and cancel SLA work |

The historic path names remain stable for compatibility. The intake and administrative keys are independent. Authentication failures occur before the workflow response node and may be `401` or `403`; callers must not rely on a ClientOps JSON envelope for those failures.

## Request intake

```http
POST /webhook/clientops/leads
Content-Type: application/json
X-ClientOps-Intake-Key: <intake-key>
Idempotency-Key: <stable-request-key>
```

### Idempotency key

`Idempotency-Key` is required. After surrounding whitespace is trimmed, it must contain 8–128 characters from:

```text
A-Z a-z 0-9 . _ : -
```

Generate one key for one logical submission, persist it before the first attempt, and reuse it for a timeout or `503`. Equality uses the canonical JSON object after optional defaults are filled, not byte-for-byte HTTP encoding. Field value changes—including case or phone formatting—remain significant.

| Key and normalized request | Status | Result |
| --- | --- | --- |
| new key | `201` | request and initial delivery jobs created |
| same key and same request | `200` | original ticket returned; no duplicate jobs |
| same key and changed request | `409` | conflict; changed request rejected |

### JSON body

The body must contain only these fields:

| Field | Type | Required | Constraint | Canonical default |
| --- | --- | --- | --- | --- |
| `name` | string | yes | non-empty; at most 159 characters; no ASCII control characters | — |
| `email` | string | yes | 3–254 characters; one `@`; later dot; no control characters | — |
| `city` | string | no | at most 127 characters; no control characters | empty string |
| `phone` | string | no | at most 63 characters | empty string |
| `source` | string | no | at most 95 characters; no control characters | `webhook` |
| `message` | string | yes | non-empty; at most 8,191 characters | — |
| `consent` | boolean | yes | exactly `true` | — |

The email check is deliberately modest and is not full RFC mailbox validation. The workflow rejects a serialized body longer than 30,000 characters. The Compose-level n8n request cap is 1 MiB, but callers should treat the stricter workflow bound as the contract.

Phone normalization removes separators but does not invent a country code. `city` is optional. In the default `any` region mode, location does not affect serviceability. An operator can configure an allowlist without changing the API shape.

Example:

```json
{
  "name": "Jordan Lee",
  "email": "jordan@example.test",
  "source": "website-form",
  "message": "Our account has a critical issue and we need support today.",
  "consent": true
}
```

The same body is in [`examples/lead.json`](../examples/lead.json).

```bash
INTAKE_KEY=$(sed -n 's/^CLIENTOPS_INTAKE_API_KEY=//p' .env)

curl --insecure --request POST https://localhost:8443/webhook/clientops/leads \
  --header 'Content-Type: application/json' \
  --header "X-ClientOps-Intake-Key: $INTAKE_KEY" \
  --header 'Idempotency-Key: website:request-0001' \
  --data-binary @examples/lead.json
```

Do not log the key, put it in a URL, or commit `.env`.

### Created — `201`

```json
{
  "ok": true,
  "outcome": "created",
  "ticketId": "b6846e13-571a-4274-a21f-09ac8798e160",
  "message": "Request accepted and queued for follow-up."
}
```

`201` means the request and its initial outbox jobs committed atomically. External delivery is asynchronous.

### Exact replay — `200`

```json
{
  "ok": true,
  "outcome": "replayed",
  "ticketId": "b6846e13-571a-4274-a21f-09ac8798e160",
  "message": "Request already accepted; returning the original ticket."
}
```

### Changed request under the same key — `409`

```json
{
  "ok": false,
  "error": {
    "code": "idempotency_conflict",
    "message": "That idempotency key was already used with different data."
  }
}
```

Generate a new key only if the changed body is intentionally a new logical submission.

### Invalid request — `422`

Workflow validation returns up to 12 details:

```json
{
  "ok": false,
  "error": {
    "code": "invalid_request",
    "message": "Request validation failed",
    "details": ["consent must be true"]
  }
}
```

The compiled policy can also reject invalid normalized input with the same status and code but without a promised `details` array. Correct the request before retrying.

### Temporary failure — `503`

```json
{
  "ok": false,
  "error": {
    "code": "service_unavailable",
    "message": "Request intake is temporarily unavailable"
  }
}
```

This covers an unavailable/incompatible policy response or a persistence failure. Retry with bounded backoff and the same key and body. A replay safely resolves a response lost after commit.

## Internal policy contract

n8n calls `POST http://policy:8080/v2/qualify` inside the Compose network. It is not exposed on the host. A successful response uses policy version `clientops-triage-v1` and exactly these decision fields:

| Field | Meaning |
| --- | --- |
| `fit` / `fitReason` | deterministic acceptance explanation |
| `category` | configured category or bounded system category |
| `score` | integer from 0 through 100 |
| `serviceable` | result of `any` or allowlist location mode |
| `urgency` | `low`, `medium`, or `high` |
| `summary` | bounded neutral summary |
| `nextStep` | operator next action |
| `draftReply` | optional customer acknowledgement |
| `route` | one of the eight current generic routes |

The route vocabulary is `ROUTE_SPAM`, `ROUTE_UNSUPPORTED`, `ROUTE_INSUFFICIENT_INFORMATION`, `ROUTE_STANDARD`, `ROUTE_SPECIALIST`, `ROUTE_URGENT`, `ROUTE_LOCATION_REVIEW`, and `ROUTE_MANUAL_REVIEW`.

## Mark contacted

```http
POST /webhook/clientops/leads/contacted
Content-Type: application/json
X-ClientOps-Admin-Key: <admin-key>
```

This operation is idempotent and requires no intake idempotency header.

| Field | Type | Required | Constraint |
| --- | --- | --- | --- |
| `ticketId` | string | yes | UUID versions 1–5 with RFC 4122 variant |
| `note` | string | no | at most 1,000 characters |

Unknown fields are rejected. The note is retained with the request activity; do not place secrets in it.

```bash
ADMIN_KEY=$(sed -n 's/^CLIENTOPS_ADMIN_API_KEY=//p' .env)

curl --insecure --request POST https://localhost:8443/webhook/clientops/leads/contacted \
  --header 'Content-Type: application/json' \
  --header "X-ClientOps-Admin-Key: $ADMIN_KEY" \
  --data-binary '{"ticketId":"REPLACE_WITH_TICKET_UUID","note":"Customer contacted"}'
```

Responses:

| Status | Outcome | Message |
| --- | --- | --- |
| `200` | `contacted` | `Request marked as contacted.` |
| `200` | `replayed` | `Request was already marked as contacted.` |
| `404` | `not_found` | `Ticket was not found.` |
| `422` | `invalid_request` | workflow validation envelope |
| `503` | `service_unavailable` | contact update temporarily unavailable |

## Delivery and privacy semantics

Acceptance and outbox creation are transactional, but provider delivery is at least once. A provider may accept a message before the dispatcher records completion, so a timeout or crash can produce a duplicate. Marking contacted cancels pending/leased SLA work and re-authorizes immediately before dispatch; an already-authorized send can still win the narrow authorization-to-send race.

The business schema stores no source IP or IP-derived value. n8n execution-payload persistence is disabled. The 1.2.1 deployment places n8n behind the generated Traefik HTTPS edge, does not publish n8n or PostgreSQL, keeps Mailpit/ntfy loopback-only, and applies route-specific authentication/rate/body/header/path/TLS controls. Traefik access logs are a separate operational data surface and must be configured according to the operator's retention policy. There is no list/detail API for stored requests, and the runtime n8n role cannot select the underlying table.

See the [architecture](architecture.md) for queue semantics and the [operations runbook](runbooks/operations.md) for health checks, backups, upgrades, and recovery.
