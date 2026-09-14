#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
environment_file="$project_root/.env"
if [ ! -f "$environment_file" ]; then
    printf '%s\n' 'Run ./clientops setup before the acceptance suite.' >&2
    exit 1
fi
. "$environment_file"
acceptance_key="acceptance:$(date +%s):$$"

compose() {
    docker compose --project-directory "$project_root" --env-file "$environment_file" "$@"
}

edge_curl() {
    if [ "${CLIENTOPS_EDGE_MODE:-local}" = local ]; then
        curl --insecure "$@"
    else
        curl "$@"
    fi
}


temporary_directory=$(mktemp -d)
cleanup() {
    compose start policy >/dev/null 2>&1 || true
    rm -rf "$temporary_directory"
}
trap cleanup EXIT HUP INT TERM

initial_failure_count=$(compose exec -T postgres psql --username postgres --dbname clientops --tuples-only --no-align \
    --command 'SELECT count(*) FROM clientops.workflow_failures;' | tr -d '[:space:]')

request_file="$temporary_directory/request.json"
changed_file="$temporary_directory/changed.json"
invalid_file="$temporary_directory/invalid.json"
printf '%s' '{"name":"Jordan Lee","email":"jordan@example.test","source":"acceptance-suite","message":"Our account has a critical issue and we need support today.","consent":true}' >"$request_file"
printf '%s' '{"name":"Jordan Lee","email":"jordan@example.test","source":"acceptance-suite","message":"Our account has a critical issue and we need support today. It affects two users.","consent":true}' >"$changed_file"
printf '%s' '{"name":"Jordan Lee","email":"jordan@example.test","message":"Our account has a critical issue and we need support today.","consent":false}' >"$invalid_file"

post_lead() {
    body_file=$1
    output_file=$2
    request_key=${3:-$acceptance_key}
    edge_curl --silent --show-error \
        --output "$output_file" \
        --write-out '%{http_code}' \
        --header 'Content-Type: application/json' \
        --header "X-ClientOps-Intake-Key: $CLIENTOPS_INTAKE_API_KEY" \
        --header "Idempotency-Key: $request_key" \
        --data-binary "@$body_file" \
        "$CLIENTOPS_PUBLIC_ORIGIN/webhook/clientops/leads"
}

created_body="$temporary_directory/created.json"
created_status=000
attempt=1
while [ "$attempt" -le 15 ]; do
    created_status=$(post_lead "$request_file" "$created_body")
    case "$created_status" in
        500|502|503|504) sleep 1; attempt=$((attempt + 1)) ;;
        *) break ;;
    esac
done
[ "$created_status" = 201 ] || { printf 'Expected 201, received %s: ' "$created_status" >&2; cat "$created_body" >&2; exit 1; }
ticket_id=$(node -e "const f=require('node:fs');const b=JSON.parse(f.readFileSync(process.argv[1]));if(!b.ok||!b.ticketId)process.exit(1);process.stdout.write(b.ticketId)" "$created_body")

decision=$(compose exec -T postgres psql --username postgres --dbname clientops --tuples-only --no-align \
    --command "SELECT category || '|' || score || '|' || serviceable || '|' || route FROM clientops.leads WHERE id = '$ticket_id'::uuid;" | tr -d '[:space:]')
[ "$decision" = 'support|85|true|ROUTE_URGENT' ] || {
    printf 'Unexpected persisted decision: %s\n' "$decision" >&2
    exit 1
}

replay_body="$temporary_directory/replay.json"
replay_status=$(post_lead "$request_file" "$replay_body")
[ "$replay_status" = 200 ] || { printf 'Expected replay 200, received %s\n' "$replay_status" >&2; exit 1; }
replay_ticket=$(node -e "const f=require('node:fs');process.stdout.write(JSON.parse(f.readFileSync(process.argv[1])).ticketId)" "$replay_body")
[ "$replay_ticket" = "$ticket_id" ] || { printf '%s\n' 'Replay returned a different ticket.' >&2; exit 1; }

conflict_body="$temporary_directory/conflict.json"
conflict_status=$(post_lead "$changed_file" "$conflict_body")
[ "$conflict_status" = 409 ] || { printf 'Expected conflict 409, received %s\n' "$conflict_status" >&2; exit 1; }

invalid_body="$temporary_directory/invalid-response.json"
invalid_status=$(edge_curl --silent --show-error --output "$invalid_body" --write-out '%{http_code}' \
    --header 'Content-Type: application/json' \
    --header "X-ClientOps-Intake-Key: $CLIENTOPS_INTAKE_API_KEY" \
    --header "Idempotency-Key: $acceptance_key-invalid" \
    --data-binary "@$invalid_file" \
    "$CLIENTOPS_PUBLIC_ORIGIN/webhook/clientops/leads")
[ "$invalid_status" = 422 ] || { printf 'Expected validation 422, received %s\n' "$invalid_status" >&2; exit 1; }

assert_auth_rejected() {
    label=$1
    header_name=$2
    header_value=$3
    endpoint=$4
    auth_status=$(edge_curl --silent --output /dev/null --write-out '%{http_code}' \
        --header 'Content-Type: application/json' \
        --header "$header_name: $header_value" \
        --header "Idempotency-Key: $acceptance_key-auth" \
        --data '{}' \
        "$endpoint")
    case "$auth_status" in
        401|403) ;;
        *) printf '%s expected authentication rejection, received %s\n' "$label" "$auth_status" >&2; exit 1 ;;
    esac
}

assert_auth_rejected 'wrong intake key' 'X-ClientOps-Intake-Key' 'definitely-not-the-generated-key' \
    "$CLIENTOPS_PUBLIC_ORIGIN/webhook/clientops/leads"
assert_auth_rejected 'admin key on intake' 'X-ClientOps-Intake-Key' "$CLIENTOPS_ADMIN_API_KEY" \
    "$CLIENTOPS_PUBLIC_ORIGIN/webhook/clientops/leads"
assert_auth_rejected 'intake key on admin endpoint' 'X-ClientOps-Admin-Key' "$CLIENTOPS_INTAKE_API_KEY" \
    "$CLIENTOPS_PUBLIC_ORIGIN/webhook/clientops/leads/contacted"

recovery_key="$acceptance_key-policy-recovery"
recovery_body="$temporary_directory/policy-unavailable.json"
compose stop policy >/dev/null
unavailable_status=$(post_lead "$request_file" "$recovery_body" "$recovery_key")
[ "$unavailable_status" = 503 ] || { printf 'Expected policy outage 503, received %s\n' "$unavailable_status" >&2; exit 1; }
compose start policy >/dev/null
attempt=1
while [ "$attempt" -le 20 ]; do
    if compose exec -T policy node -e \
        "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
        >/dev/null 2>&1; then
        break
    fi
    sleep 1
    attempt=$((attempt + 1))
done
[ "$attempt" -le 20 ] || { printf '%s\n' 'Policy service did not recover.' >&2; exit 1; }
recovered_status=$(post_lead "$request_file" "$recovery_body" "$recovery_key")
[ "$recovered_status" = 201 ] || { printf 'Expected recovered policy request 201, received %s\n' "$recovered_status" >&2; exit 1; }

if compose exec -T -e PGPASSWORD="$CLIENTOPS_DB_PASSWORD" postgres \
    psql --host 127.0.0.1 --username clientops_app --dbname clientops --tuples-only --command 'SELECT count(*) FROM clientops.leads;' \
    >"$temporary_directory/forbidden-select.log" 2>&1; then
    printf '%s\n' 'Runtime role unexpectedly has direct table access.' >&2
    exit 1
fi

attempt=1
delivered=0
while [ "$attempt" -le 55 ]; do
    delivered=$(compose exec -T postgres psql --username postgres --dbname clientops --tuples-only --no-align \
        --command "SELECT count(*) FROM clientops.delivery_outbox WHERE lead_id = '$ticket_id'::uuid AND status = 'delivered';" | tr -d '[:space:]')
    [ "$delivered" = 2 ] && break
    sleep 2
    attempt=$((attempt + 1))
done
[ "$delivered" = 2 ] || { printf 'Expected two delivered messages, found %s\n' "$delivered" >&2; exit 1; }

mail_count=$(curl --fail --silent http://127.0.0.1:8025/api/v1/messages | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);process.stdout.write(String(x.total ?? x.messages_count ?? 0))})")
[ "$mail_count" -ge 1 ] || { printf '%s\n' 'Mailpit did not capture the customer acknowledgement.' >&2; exit 1; }

curl --fail --silent "http://127.0.0.1:8081/$CLIENTOPS_NTFY_TOPIC/json?poll=1&since=all" >"$temporary_directory/ntfy.ndjson"
grep -F "$ticket_id" "$temporary_directory/ntfy.ndjson" >/dev/null || { printf '%s\n' 'ntfy did not receive the owner alert.' >&2; exit 1; }

contact_body="$temporary_directory/contact.json"
printf '{"ticketId":"%s","note":"Acceptance suite contact"}' "$ticket_id" >"$contact_body"
contact_response="$temporary_directory/contact-response.json"
contact_status=$(edge_curl --silent --show-error --output "$contact_response" --write-out '%{http_code}' \
    --header 'Content-Type: application/json' \
    --header "X-ClientOps-Admin-Key: $CLIENTOPS_ADMIN_API_KEY" \
    --data-binary "@$contact_body" \
    "$CLIENTOPS_PUBLIC_ORIGIN/webhook/clientops/leads/contacted")
[ "$contact_status" = 200 ] || { printf 'Expected contact update 200, received %s\n' "$contact_status" >&2; exit 1; }

failure_count=$(compose exec -T postgres psql --username postgres --dbname clientops --tuples-only --no-align \
    --command 'SELECT count(*) FROM clientops.workflow_failures;' | tr -d '[:space:]')
[ "$failure_count" = "$initial_failure_count" ] || { printf 'New workflow failures recorded: before=%s after=%s\n' "$initial_failure_count" "$failure_count" >&2; exit 1; }

printf '%s\n' '{'
printf '%s\n' '  "status": "PASS",'
printf '%s\n' '  "contract": "docker-e2e",'
printf '  "ticketId": "%s",\n' "$ticket_id"
printf '%s\n' '  "idempotency": [201, 200, 409],'
printf '%s\n' '  "invalidRequest": 422,'
printf '%s\n' '  "authIsolation": true,'
printf '%s\n' '  "policyRecovery": [503, 201],'
printf '%s\n' '  "decision": {"category":"support","score":85,"serviceable":true,"route":"ROUTE_URGENT"},'
printf '%s\n' '  "delivered": ["smtp", "ntfy"],'
printf '%s\n' '  "runtimeRoleRestricted": true,'
printf '%s\n' '  "contactUpdate": 200'
printf '%s\n' '}'
