# Operations runbook

This runbook operates the checked-in single-host Compose deployment. Commands run from the repository root unless stated otherwise.

## Operating model

- n8n, Mailpit, and ntfy bind to localhost.
- PostgreSQL is reachable only on the Compose network.
- `./clientops down` stops containers but preserves all named volumes.
- the credential-free core sends real messages to the local Mailpit and ntfy services;
- Google Sheets, Slack, and Gmail are an optional, inactive, import-validated-only adapter—not part of the verified core.

The generated `.env` is part of the deployment state. Keep it mode `0600`, out of source control, and backed up with the data volumes. In particular, a restored n8n database needs the matching `N8N_ENCRYPTION_KEY` to decrypt imported credentials.

## Lifecycle

First start:

```bash
./clientops setup owner@example.com UTC
./clientops up
```

Routine commands:

```bash
./clientops status
./clientops logs n8n
./clientops logs task-runner
./clientops down
```

`./clientops up` builds the policy image, preflights managed n8n state, runs the tracked database migrator, initializes or upgrades managed n8n workflows, starts the stack, waits for n8n and the external Code runner, and sends an authenticated invalid probe that must return `422`. On a fresh PostgreSQL volume, bootstrap creates roles and both databases. On every existing-install start, `n8n-upgrade-preflight` must succeed before `database-migrate` can reconcile the current ClientOps schema; n8n initialization follows. A fresh n8n state receives four credentials and seven published core workflows.

PostgreSQL executes `database/001-bootstrap.sh` only for an empty data directory, but the separate migration service always runs. n8n's v2 marker verifies semantic current-workflow fingerprints. During an upgrade the preflight exports plaintext workflow/plan state plus n8n-encrypted credential ciphertext into a mode-`0700` directory, writes and verifies byte counts and SHA-256 values, and refuses an unrecognized/customized fixed-ID workflow. The later install step replaces only recognized untouched stock workflows.

## Universal configuration

Fresh installs default to UTC and accept every region. Choose any IANA timezone and either worldwide or allowlist location behavior:

```bash
./clientops set-timezone Pacific/Auckland
./clientops set-regions any

# Or require one of the configured names:
./clientops set-regions allowlist "Central Region" "Coastal Region"
./clientops up
```

PostgreSQL validates the timezone during startup; n8n and database business-day calculations receive the same value. `set-regions` rewrites the bounded policy config and requires a policy rebuild, which `up` performs. In `any` mode, location is optional and serviceability is true. In allowlist mode, a missing or unmatched location goes to manual location review. The runtime never infers a phone country code.

Edit `policy-engine/config/policy.json` to change categories, specialist flags, fallback category, urgency signals, exclusions, spam rules, or detail threshold. Run `make -C policy-engine test` after a change. Unknown configuration keys and out-of-bound values fail startup instead of being ignored.

## Health and readiness

Start with container state:

```bash
./clientops status
```

Check the exposed services:

```bash
curl --fail --silent http://127.0.0.1:5678/healthz/readiness
curl --fail --silent http://127.0.0.1:8081/v1/health
curl --fail --silent http://127.0.0.1:8025/api/v1/messages >/dev/null
```

Check internal-only services from their containers:

```bash
docker compose --env-file .env exec -T policy \
  node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

docker compose --env-file .env exec -T task-runner \
  node -e "fetch('http://127.0.0.1:5680').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
```

When one check fails, inspect only the relevant logs first:

```bash
./clientops logs policy
./clientops logs postgres
./clientops logs mailpit
./clientops logs ntfy
```

Treat logs as potentially sensitive operational data even though n8n execution payload saving is disabled.

## Verification

Native contracts do not require the Compose stack:

```bash
npm ci
npm test
```

The black-box suite builds and starts the real stack, writes fresh acceptance requests, sends local SMTP/ntfy notifications, deliberately stops and restarts the policy service, and marks a ticket contacted:

```bash
./clientops verify
```

It checks the `201`/`200`/`409` idempotency contract, `422` validation, intake/admin credential isolation, policy outage recovery, runtime database restrictions, local delivery, and the contacted transition. Because it writes durable test records and messages, run it where acceptance data is appropriate. See [verification evidence](../verification.md) for what was and was not executed during repository preparation.

## Queue monitoring

The runtime role can read only the aggregate `clientops.queue_health` view, not the underlying business tables. An operator can inspect the same view through the local PostgreSQL administrator:

```bash
docker compose --env-file .env exec -T postgres \
  psql --username postgres --dbname clientops \
  --command 'TABLE clientops.queue_health;'
```

The view reports pending, leased, and dead-letter counts, the oldest pending availability time, and the most recent delivery update. Interpret it with the dispatcher schedule:

- `pending` can be non-zero while jobs wait for their retry time;
- a short-lived `leased` count is normal;
- a lease older than five minutes is eligible for reclaim;
- `dead_letter > 0` requires investigation;
- a growing `pending` count with no recent delivery usually means the dispatcher or one channel is unavailable.

List dead letters without selecting message bodies or recipients:

```bash
docker compose --env-file .env exec -T postgres \
  psql --username postgres --dbname clientops --command "
    SELECT id, kind, channel, attempts, dead_lettered_at,
           left(coalesce(last_error, ''), 240) AS last_error
      FROM clientops.delivery_outbox
     WHERE status = 'dead_letter'
     ORDER BY dead_lettered_at DESC
     LIMIT 50;"
```

Inspect sanitized workflow failures:

```bash
docker compose --env-file .env exec -T postgres \
  psql --username postgres --dbname clientops --command "
    SELECT id, workflow_name, workflow_id, execution_id, last_node,
           left(error_message, 240) AS error_message,
           sanitized_context, created_at
      FROM clientops.workflow_failures
     ORDER BY created_at DESC
     LIMIT 50;"
```

The error table intentionally does not contain arbitrary workflow input, but error strings can still include provider or operator text.

## Retry and dead-letter operations

One leased database attempt can make up to three immediate channel calls one second apart. A failed database attempt is retried after 1 minute, 5 minutes, 15 minutes, 1 hour, and 4 hours; the sixth failed attempt dead-letters the job. An expired sixth lease is dead-lettered on a later dispatcher claim pass.

Before replaying a dead letter:

1. restore the failed dependency or correct the destination;
2. record the row's ID, kind, channel, last error, and timestamps;
3. decide whether the provider may already have accepted the message;
4. get approval for a possible duplicate;
5. requeue exactly one reviewed row.

The application role has no dead-letter replay function. The following is an explicit administrator action; replace the UUID and verify the one returned row before commit:

```sql
BEGIN;

SELECT id, kind, channel, status, attempts, dead_lettered_at, last_error
  FROM clientops.delivery_outbox
 WHERE id = 'REPLACE_WITH_OUTBOX_UUID'::uuid
 FOR UPDATE;

UPDATE clientops.delivery_outbox
   SET status = 'pending',
       attempts = 0,
       available_at = clock_timestamp(),
       lease_owner = NULL,
       lease_token = NULL,
       lease_expires_at = NULL,
       delivered_at = NULL,
       dead_lettered_at = NULL,
       updated_at = clock_timestamp()
 WHERE id = 'REPLACE_WITH_OUTBOX_UUID'::uuid
   AND status = 'dead_letter'
 RETURNING id, kind, channel, status, attempts, available_at;

COMMIT;
```

Open an interactive administrator session with:

```bash
docker compose --env-file .env exec postgres \
  psql --username postgres --dbname clientops
```

If the `UPDATE` returns no row, issue `ROLLBACK` and investigate; never broaden the predicate. Requeueing resets durable attempts but does not provide provider-side deduplication. SMTP or ntfy may deliver a duplicate if the original call succeeded before its acknowledgement was lost.

## Incident procedures

### Policy unavailable

Symptoms: intake returns `503`; policy health fails; no new accepted ticket is returned.

```bash
./clientops logs policy
docker compose --env-file .env restart policy
```

After health recovers, retry the original request with its original idempotency key and body. The black-box suite exercises this exact stop, `503`, start, `201` recovery path.

### PostgreSQL unavailable

Symptoms: n8n readiness or database nodes fail, intake returns `503` or the workflow cannot answer, and the dispatcher stops progressing.

```bash
./clientops logs postgres
docker compose --env-file .env restart postgres
./clientops status
```

Do not change database passwords as a recovery guess. After PostgreSQL is healthy, inspect queue health and retry the client request with the same idempotency key. The acceptance transaction prevents a partially inserted lead/outbox set; a lost response can still hide a committed request, which replay resolves safely.

### Mailpit or ntfy unavailable

Lead acceptance remains durable because channel calls happen after the outbox commit. Restore the failed service before all six durable attempts are exhausted:

```bash
docker compose --env-file .env restart mailpit
docker compose --env-file .env restart ntfy
```

Then watch `queue_health`. Ready jobs are picked up by the minute dispatcher. Review dead letters separately; they are not automatically replayed.

### Dispatcher stopped or stale leases

Confirm n8n and the task runner are healthy, then inspect their logs:

```bash
./clientops logs n8n
./clientops logs task-runner
```

Restart only the unhealthy service. A claim has a five-minute lease and a unique fencing token. After expiration, another dispatcher run can reclaim attempts below six; a stale worker cannot complete the newer lease.

### Contacted request still receives an SLA alert

Confirm the administrative endpoint returned `200`, then inspect the ticket's activity and SLA outbox rows as an administrator. Pending and leased SLA jobs are cancelled transactionally, and the dispatcher re-authorizes immediately before the channel call. A notification can still win the small authorization-to-send race: once authorization commits, a concurrent contact update cannot retract the external call. Record this as the expected residual race if timestamps support it; otherwise investigate credential use, ticket ID, workflow version, and clock health.

## Retention

Defaults created on a fresh database are:

- 90 days for requests and delivery-outbox rows;
- 30 days for sanitized workflow failures;
- 90 days and at most 500 messages in Mailpit.

The retention workflow runs daily at 03:10 in `CLIENTOPS_TIMEZONE`. The database purge preserves only an outbox row with a currently live lease, and only until that lease expires. An expired or stale lease is eligible at the next maintenance run. The function then deletes old requests and old workflow failures. Activity cascades with its ticket.

Run and inspect the purge manually:

```bash
docker compose --env-file .env exec -T postgres \
  psql --username postgres --dbname clientops \
  --command 'SELECT * FROM clientops.purge_expired_data();'
```

Retention settings must be integers from 7 through 3,650. Change them deliberately in an administrator transaction, then invoke the function and check the returned counts. Changing `.env` does not update settings already stored on a persistent PostgreSQL volume.

The application stores no source IP or IP-derived value. This guarantee covers the checked-in intake workflow and ClientOps schema. If a reverse proxy, host agent, or centralized log collector is added, configure its access-log retention separately to preserve the end-to-end zero-IP policy.

## Cold backup

Back up a **paired recovery set**:

1. `.env`, including the n8n encryption key and database credentials;
2. `clientops-relay_postgres_data`, containing both the n8n and ClientOps PostgreSQL databases;
3. `clientops-relay_n8n_data`, containing the bootstrap marker and filesystem-mode n8n state;
4. the exact release artifact that supplied the matching Compose, schema, and workflow files.

Do not treat either named volume as a complete backup by itself. Stop the stack so the two volume archives represent the same maintenance window. Mailpit and ntfy volumes are optional for functional recovery but should also be archived if delivery evidence must be retained.

The example below uses the already pinned PostgreSQL Alpine image as a read-only tar helper:

```bash
set -eu

backup_dir="$PWD/backups/clientops-relay-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

./clientops down
cp -p .env "$backup_dir/.env"
node -p "require('./package.json').version" >"$backup_dir/release-version.txt"
cp RELEASE_MANIFEST.json "$backup_dir/RELEASE_MANIFEST.json"

docker run --rm --entrypoint /bin/sh \
  --volume clientops-relay_postgres_data:/source:ro \
  --volume "$backup_dir:/backup" \
  postgres:16.14-alpine \
  -c 'tar -C /source -czf /backup/postgres_data.tar.gz .'

docker run --rm --entrypoint /bin/sh \
  --volume clientops-relay_n8n_data:/source:ro \
  --volume "$backup_dir:/backup" \
  postgres:16.14-alpine \
  -c 'tar -C /source -czf /backup/n8n_data.tar.gz .'

(cd "$backup_dir" && sha256sum .env release-version.txt RELEASE_MANIFEST.json postgres_data.tar.gz n8n_data.tar.gz >SHA256SUMS)
chmod 600 "$backup_dir"/*

./clientops up
```

On macOS, use `shasum -a 256` in place of `sha256sum`, and record the matching verification command. Store the completed directory in encrypted backup storage with access controls appropriate for customer data and secrets. Test restoration periodically; archive creation alone is not proof of recoverability.

To retain local delivery evidence, create cold archives for `clientops-relay_mailpit_data` and `clientops-relay_ntfy_cache` using the same pattern and maintenance window.

## Restore and paired-volume recovery

Restore onto a clean Docker volume set using the exact release recorded with the backup. Overlay-extracting onto existing volumes is unsupported and can corrupt or silently mix deployments.

1. unpack or check out the recorded release;
2. verify archive hashes;
3. ensure no ClientOps containers are running;
4. refuse the operation if either target named volume already exists;
5. restore `.env` with mode `0600`;
6. create and populate both named volumes;
7. start and verify the stack.

Linux example:

```bash
set -eu

backup_dir=/absolute/path/to/clientops-relay-backup

(cd "$backup_dir" && sha256sum --check SHA256SUMS)
test -f "$backup_dir/.env"
test -f "$backup_dir/postgres_data.tar.gz"
test -f "$backup_dir/n8n_data.tar.gz"

for volume in clientops-relay_postgres_data clientops-relay_n8n_data; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "Refusing to overlay existing volume: $volume" >&2
    exit 1
  fi
done

cp "$backup_dir/.env" .env
chmod 600 .env

docker volume create clientops-relay_postgres_data >/dev/null
docker volume create clientops-relay_n8n_data >/dev/null

docker run --rm --entrypoint /bin/sh \
  --volume clientops-relay_postgres_data:/target \
  --volume "$backup_dir:/backup:ro" \
  postgres:16.14-alpine \
  -c 'tar -C /target -xzf /backup/postgres_data.tar.gz'

docker run --rm --entrypoint /bin/sh \
  --volume clientops-relay_n8n_data:/target \
  --volume "$backup_dir:/backup:ro" \
  postgres:16.14-alpine \
  -c 'tar -C /target -xzf /backup/n8n_data.tar.gz'

./clientops up
./clientops verify
```

If either named volume exists, stop. Preserve it with a new backup and move to a clean Docker host or deliberately remove only the reviewed target after separate authorization. Do not extract over it.

After restore, also verify:

- the seven core workflows are published;
- the four expected credentials are present;
- an intake/admin key cross-use is rejected;
- the runtime database role cannot directly select `clientops.leads`;
- SMTP and ntfy delivery complete;
- `queue_health` and recent failure records are understood.

`./clientops verify` performs these functional checks but creates acceptance data. The v2 marker also checks current workflow semantics and expected credentials, but neither it nor verification replaces a paired restore drill.

## Secret and key rotation

Plan rotations as maintenance operations and take a paired backup first. This stack has no dual-key acceptance window.

### Intake and administrative API keys

Rotate the endpoints independently:

1. generate a new 32-byte secret, for example `openssl rand -hex 32`;
2. in n8n, update only the matching credential—`ClientOps Intake API Key` or `ClientOps Admin API Key`;
3. update the authorized caller immediately;
4. replace only the matching `.env` value and keep the file mode `0600`;
5. verify the new key succeeds and the old and cross-role keys return `401` or `403`.

Changing `.env` alone does **not** update an already imported n8n credential. Conversely, editing the n8n credential without updating `.env` makes the acceptance suite and a future bootstrap inconsistent. The core does not support two simultaneous keys, so schedule the short handover accordingly.

### Task-runner token

`N8N_RUNNERS_AUTH_TOKEN` must match on n8n and the external task runner. Replace it in `.env`, then recreate both services together in a maintenance window:

```bash
docker compose --env-file .env up --detach --force-recreate n8n task-runner
./clientops status
```

Confirm the task-runner health check and execute a workflow containing a Code node before closing the change.

### PostgreSQL passwords

The persistent database roles and their consumers must change together:

| Secret | PostgreSQL role | Consumer state to synchronize |
| --- | --- | --- |
| `POSTGRES_ADMIN_PASSWORD` | `postgres` | `.env` / container configuration |
| `N8N_DB_PASSWORD` | `n8n` | `.env` / n8n database connection environment |
| `CLIENTOPS_DB_PASSWORD` | `clientops_app` | `.env` and the imported `ClientOps PostgreSQL` n8n credential |

Use PostgreSQL's interactive `\password <role>` command from an administrator session so the new value is not exposed in shell history:

```bash
docker compose --env-file .env exec postgres \
  psql --username postgres --dbname postgres
```

Coordinate the role password, `.env`, and relevant n8n credential during one maintenance window, then recreate affected services and run verification. Merely changing `.env` and restarting is insufficient: the initialization script does not run against an existing PostgreSQL data directory, and the stored ClientOps PostgreSQL credential is not automatically re-rendered.

### n8n encryption keys

The checked-in deployment sets one stable `N8N_ENCRYPTION_KEY`. Preserve it with every backup. Do **not** replace that environment value in place as a routine rotation: existing n8n credentials were encrypted under the matching master material and can become unreadable.

n8n 2.37.10 has an optional data-encryption-key rotation workflow, but this repository does not enable or test it. If adopting it:

1. take and test a paired backup;
2. read the pinned version's official [Rotate encryption keys](https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/rotate-encryption-keys) procedure;
3. enable `N8N_ENV_FEAT_ENCRYPTION_KEY_ROTATION=true` on every n8n instance and restart;
4. keep the feature enabled because the migration is one-way;
5. as the n8n owner, rotate the data encryption key in **Settings → Data Encryption Keys**;
6. keep the instance/master `N8N_ENCRYPTION_KEY` stable and protected;
7. verify credential-backed core workflows and perform another recoverability test.

This is an operator-added deployment change, not a capability claimed by the current Compose file.

## Configuration changes on persistent volumes

The database settings contain owner email, ntfy topic, business timezone, and retention days. The always-run migration service synchronizes only `business_timezone` from `.env`; other persisted settings remain explicit operator state. Inspect them as an administrator:

```bash
docker compose --env-file .env exec -T postgres \
  psql --username postgres --dbname clientops \
  --command 'SELECT key, value, updated_at FROM clientops.settings ORDER BY key;'
```

Use `./clientops set-timezone NAME` for timezone changes so n8n and PostgreSQL remain aligned. Apply other reviewed setting changes directly in a transaction and run the affected workflow manually.

## Upgrade from 1.0 to 1.1

This upgrade replaces the internal triage schema. Public webhook paths, headers, request fields, status envelopes, fixed workflow IDs, idempotency keys, ticket IDs, and administrative endpoint remain compatible. Existing raw policy JSON remains historical evidence, while current first-class columns become generic.

Treat it as a maintenance-window migration:

1. stop new intake at the caller or edge;
2. inspect `clientops.queue_health` and wait for `pending=0` and `leased=0`;
3. review every dead letter and either retain it for restore, requeue it before the window, or document its disposition;
4. run `./clientops down` and create the paired cold backup above;
5. if `.env` lacks `CLIENTOPS_TIMEZONE`, add the intended existing business timezone with `./clientops set-timezone NAME`;
6. unpack/check out v1.1 and run `npm test`;
7. run `./clientops up` and read `database-migrate` and `n8n-init` output;
8. run `./clientops verify`, then inspect queue health and the seven published workflows.

Queue check before shutdown:

```bash
docker compose --env-file .env exec -T postgres \
  psql --username postgres --dbname clientops --command "
    SELECT status, count(*)
      FROM clientops.delivery_outbox
     WHERE status IN ('pending', 'leased', 'dead_letter')
     GROUP BY status ORDER BY status;"
```

The database migration is transactional, advisory-locked, checksum-tracked, and idempotent. It preserves ticket/idempotency data, canonical request, raw policy, activities, outbox state, delivery evidence, and failures. It maps historical routes, creates generic category/score/serviceability columns, and removes obsolete structured decision columns.

Before the ClientOps migration starts, `n8n-upgrade-preflight` exports encrypted credentials and plaintext workflows under the n8n data directory, checksum-verifies the copied state, and accepts only recognized stock/current semantics. `n8n-init` repeats that guard before replacing a managed workflow. If either reports a customized fixed-ID workflow, stop: preserve the export, compare the customization with generated v1.1 JSON, and merge it deliberately under a new workflow ID or after a reviewed export/import process. Do not bypass the refusal by deleting persistent n8n state. The bootstrap export is integrity-protected recovery evidence, not a substitute for the paired cold backup.

Rollback after the database transform is not a reverse SQL script. Stop the stack and restore the paired v1.0 `.env`, PostgreSQL volume, n8n volume, and release artifact from the same backup window.

## Future upgrades

The Compose images and workflow node versions are pinned. Before an upgrade:

1. read upstream release and migration notes for every changed component;
2. run `npm test` on the proposed source;
3. take and test a paired backup;
4. test the full `./clientops verify` path in an isolated volume set;
5. verify execution-data privacy settings and database grants did not drift;
6. schedule rollback using the paired backup and exact previous release.

Do not assume every future source update is migration-safe. Add a tracked migration and recognized managed-workflow path for each breaking internal change, then test both fresh installation and seeded upgrade. Never silently overwrite operator-customized workflows.

## Exposure boundary

The checked-in stack is safe for a localhost demo boundary, not direct public exposure. Before accepting Internet traffic:

- terminate TLS at a maintained reverse proxy;
- set the public n8n webhook/editor URLs and the correct trusted proxy-hop count;
- enable secure cookies for an HTTPS editor;
- add edge request-size and rate limits;
- restrict editor access separately from webhook access;
- authenticate ntfy rather than relying on its localhost-only binding;
- decide whether proxy/access logs are compatible with the zero-IP-retention requirement;
- add monitoring, alerting, off-host encrypted backups, and restore drills.

Do not publish PostgreSQL, Mailpit, the n8n editor, or an unauthenticated ntfy topic directly to the Internet.

## Optional Google/Slack/Gmail adapter

[`workflows/adapters/google-sheets-slack-gmail.json`](../../workflows/adapters/google-sheets-slack-gmail.json) is **optional and import-validated only**. Core bootstrap does not import or publish it, core acceptance does not call it, and no provider OAuth credentials are bundled. Its repository checks prove workflow structure and compatibility with the pinned n8n import path, not successful execution against Google Sheets, Slack, or Gmail.

If an operator chooses to enable it, follow [the adapter setup and live checklist](../adapters.md). Back up first, assign least-privilege provider scopes, keep it inactive until live checks pass, and document that Slack and Gmail remain at-least-once actions.

## Incident closeout checklist

- dependency health is green;
- `queue_health` is understood and dead letters are dispositioned;
- no unreviewed replay was performed;
- callers retained/reused idempotency keys correctly;
- key or credential changes are synchronized across persistent state and `.env`;
- new workflow failures contain only expected bounded metadata;
- recovery changes did not enable n8n execution payload saving;
- the incident timeline records any possible duplicate delivery or SLA authorize-to-send race;
- backup recoverability is restored after any secret, schema, workflow, or volume change.
