# Case study: ClientOps Relay 1.2

## Brief

Small teams need inbound sales, support, partnership, and general requests acknowledged quickly and routed consistently. A simple “form to notification” workflow is easy to demonstrate but weak under duplicates, partial failures, provider outages, regional differences, and operator retries.

ClientOps Relay turns that problem into a configurable, self-hosted automation system.

## The problem

- Webhooks can arrive more than once.
- A request and its notifications must not drift apart.
- Triage should be explainable, repeatable, and editable without a model provider.
- Region coverage and business timezones differ between operators.
- Notification providers can accept a message and still time out.
- Urgent tickets need a shorter follow-up window.
- Marking contacted must suppress stale reminders.
- Failure records must help operators without becoming a second customer-data store.

## The solution

The public n8n workflow authenticates a strict request, rejects unknown/malformed fields, and calls a compiled deterministic C policy. Categories, keyword rules, urgency signals, exclusions, detail threshold, and optional region allowlist are configured in bounded JSON. Worldwide serviceability and UTC are safe fresh defaults; operators can choose any IANA timezone and either worldwide or allowlist region behavior.

PostgreSQL accepts the canonical request through one function that creates the ticket, activity event, customer acknowledgement, and owner notification in one transaction. A dispatcher leases outbox rows with a worker ID and UUID fencing token, re-authorizes immediately before sending, routes SMTP and ntfy independently, and records completion or bounded retry. Six failed durable attempts become a dead letter.

Scheduled workflows create SLA alerts, daily summaries, and retention jobs. A separate administrative key protects the contacted endpoint. A tracked migration upgrades v1 state, while guarded n8n bootstrap logic refuses to overwrite customized fixed-ID workflows.

For hosted intake, a small authenticated companion exposes that same native policy without reimplementing it in JavaScript. Deterministic renderers generate Railway, Render, Kubernetes, and inactive n8n Cloud hybrid artifacts while keeping secrets external.

## Reliability decisions

| Risk | Decision |
| --- | --- |
| Duplicate webhook | Require an idempotency key and compare complete canonical JSON |
| Changed body under reused key | Return `409` without creating a second ticket |
| Ticket committed but notification lost | Store ticket and delivery jobs in one transaction |
| Two workers claim one job | `FOR UPDATE SKIP LOCKED` plus worker and UUID lease token |
| Stale worker completes a new lease | Fence every completion/failure by current token |
| Provider outage | Retry after 1, 5, 15, 60, and 240 minutes, then dead-letter |
| Contacted ticket still alerts | Cancel SLA rows and authorize again immediately before send |
| Region/timezone assumptions | Worldwide default; explicit allowlist and IANA timezone controls |
| Sensitive execution history | Disable n8n execution-payload saving; store bounded failure fields |
| Existing-install upgrade | Transactional schema migration and semantic workflow fingerprints |

Delivery is intentionally at least once. A provider-accepted message cannot be retracted, and a narrow authorization-to-send cancellation race remains.

## Proof

- 13 deterministic policy cases across urgent support, standard sales, specialist partnership, fallback general, ambiguous, spam, exclusion, insufficient detail, and allowlist handling.
- 100 byte-identical reruns of the reference decision.
- Real compiled policy HTTP checks for `200`, `422`, `404`, and `415`.
- `201` create, `200` exact replay, and `409` changed-data conflict.
- Six-attempt retry/dead-letter, lease fencing, SLA, digest, contact cancellation, least privilege, and stale-lease retention contracts.
- A seeded v1→v1.1 migration with nine route mappings, preserved historical/queue state, removed obsolete columns, and idempotent rerun.
- Seven core workflows plus one optional adapter imported into exact n8n 2.37.10; the adapter remains inactive and its OAuth boundary is explicit.
- A real companion HTTP matrix across Release, Debug, ASan, and UBSan builds, plus two byte-identical deployment-renderer trees.
- A lexical and compiled-binary gate prevents old vertical, measurement, region, route, and timezone assumptions from reappearing outside the compatibility migration test.

See the [verification matrix](../verification.md).

## Outcome

The result is one cohesive portfolio product rather than a folder of tutorial flows. It demonstrates API contracts, deterministic/configurable business logic, transactions, queue semantics, safe upgrades, failure handling, privacy, operational documentation, and honest connector boundaries in a reusable system.
