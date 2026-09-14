#!/usr/bin/env bash
set -euo pipefail

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
environment_file="$project_root/.env"
crm_dir="$project_root/crm"
crm_binary="$crm_dir/build/clientops-crm"
crm_db=${CLIENTOPS_CRM_DB:-"$project_root/runtime/clientops-crm.db"}

if [[ ! -f "$environment_file" ]]; then
  printf '%s\n' 'Relay .env is missing. Run ./clientops setup first.' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Docker with the Compose plugin is required to import the live Relay database.' >&2
  exit 1
fi
if [[ ! -x "$crm_binary" || "$crm_dir/src/clientops_crm.cpp" -nt "$crm_binary" ]]; then
  make -C "$crm_dir" release >/dev/null
fi
mkdir -p "$(dirname -- "$crm_db")"
chmod 700 "$(dirname -- "$crm_db")"
if [[ ! -f "$crm_db" ]]; then
  umask 077
  "$crm_binary" --db "$crm_db" init >/dev/null
  chmod 600 "$crm_db"
fi

# PostgreSQL emits standards-compliant CSV directly to stdout; the CRM consumes
# that stream transactionally. Relay UUIDs become stable import identities, so
# re-running this command is idempotent with --skip-existing.
docker compose --project-directory "$project_root" --env-file "$environment_file" exec -T postgres \
  psql --no-psqlrc --set ON_ERROR_STOP=1 --username postgres --dbname clientops --command "COPY (
    SELECT
      id::text AS relay_ticket_id,
      customer_name AS name,
      email,
      phone,
      ''::text AS company,
      source,
      message,
      jsonb_build_object(
        'policy_version', policy_version,
        'route', route,
        'category', category,
        'summary', summary,
        'next_step', next_step,
        'urgency', urgency,
        'serviceable', serviceable,
        'fit', fit,
        'fit_reason', fit_reason,
        'relay_status', status,
        'created_at', created_at
      )::text AS metadata_json,
      score,
      priority,
      ''::text AS owner
    FROM clientops.leads
    ORDER BY created_at, id
  ) TO STDOUT WITH (FORMAT csv, HEADER true)" \
| "$crm_binary" --db "$crm_db" --actor relay-import --json lead import-csv --in - --skip-existing
