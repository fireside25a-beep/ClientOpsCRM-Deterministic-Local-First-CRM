#!/bin/sh
set -eu
umask 077

: "${CLIENTOPS_INTAKE_API_KEY:?CLIENTOPS_INTAKE_API_KEY is required}"
: "${CLIENTOPS_ADMIN_API_KEY:?CLIENTOPS_ADMIN_API_KEY is required}"
: "${CLIENTOPS_DB_PASSWORD:?CLIENTOPS_DB_PASSWORD is required}"

bootstrap_mode=${CLIENTOPS_BOOTSTRAP_MODE:-install}
case "$bootstrap_mode" in
    install|preflight) ;;
    *)
        printf 'Unsupported CLIENTOPS_BOOTSTRAP_MODE: %s\n' "$bootstrap_mode" >&2
        exit 1
        ;;
esac

project_root=${CLIENTOPS_PROJECT_ROOT:-/opt/clientops}
marker_directory=${N8N_USER_FOLDER:-/home/node/.n8n}
marker_file="$marker_directory/.clientops-relay-bootstrap-v2"
backup_root=${CLIENTOPS_BACKUP_DIRECTORY:-$marker_directory/clientops-relay-backups}
workflow_source_directory="$project_root/workflows/core"
state_helper="$project_root/scripts/bootstrap-n8n-state.mjs"
stock_v1_fingerprints="$project_root/scripts/fixtures/core-v1-semantic-fingerprints.json"
mkdir -p "$marker_directory"
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

export_or_empty() {
    export_kind=$1
    output_path=$2
    log_path=$3
    empty_message=$4

    if [ "$export_kind" = workflow ]; then
        if n8n export:workflow --all --output="$output_path" >"$log_path" 2>&1; then
            [ -f "$output_path" ] || {
                printf '%s\n' 'n8n reported a successful workflow export but created no file.' >&2
                return 1
            }
            return 0
        fi
    else
        if n8n export:credentials --all --output="$output_path" >"$log_path" 2>&1; then
            [ -f "$output_path" ] || {
                printf '%s\n' 'n8n reported a successful credential export but created no file.' >&2
                return 1
            }
            return 0
        fi
    fi

    if [ ! -f "$output_path" ] && grep -Fq "$empty_message" "$log_path"; then
        printf '[]\n' >"$output_path"
        chmod 600 "$output_path"
        return 0
    fi

    sed -n '1,200p' "$log_path" >&2
    return 1
}

exported_workflows="$temporary_directory/workflows.json"
exported_credentials="$temporary_directory/credentials.encrypted.json"
workflow_export_log="$temporary_directory/workflow-export.log"
credential_export_log="$temporary_directory/credential-export.log"
bootstrap_plan="$temporary_directory/plan.json"

export_or_empty workflow "$exported_workflows" "$workflow_export_log" 'No workflows found with specified filters'
export_or_empty credential "$exported_credentials" "$credential_export_log" 'No credentials found with specified filters'
node "$state_helper" assert-encrypted-credentials "$exported_credentials"
node "$state_helper" plan "$exported_workflows" "$workflow_source_directory" "$stock_v1_fingerprints" >"$bootstrap_plan"

if [ -f "$marker_file" ] &&
   node "$state_helper" ready "$bootstrap_plan" &&
   node "$state_helper" credentials-ready "$exported_credentials"; then
    printf '%s\n' 'ClientOps Relay bootstrap v2 is already installed and semantically verified.'
    exit 0
fi

mkdir -p "$backup_root"
chmod 700 "$backup_root"
backup_stamp=$(date -u '+%Y%m%dT%H%M%SZ')
backup_sequence=0
while :; do
    backup_directory="$backup_root/bootstrap-v2-$backup_stamp-$$-$backup_sequence"
    incomplete_backup="$backup_directory.incomplete"
    if mkdir -m 700 "$incomplete_backup" 2>/dev/null; then
        break
    fi
    backup_sequence=$((backup_sequence + 1))
done
cp "$exported_workflows" "$incomplete_backup/workflows.json"
cp "$exported_credentials" "$incomplete_backup/credentials.encrypted.json"
cp "$bootstrap_plan" "$incomplete_backup/bootstrap-plan.json"
backup_manifest="$incomplete_backup/SHA256SUMS.json"
node "$state_helper" write-backup-manifest "$incomplete_backup" "$backup_manifest"
chmod 600 "$incomplete_backup/workflows.json" "$incomplete_backup/credentials.encrypted.json" \
    "$incomplete_backup/bootstrap-plan.json" "$backup_manifest"
node "$state_helper" verify-backup-manifest "$incomplete_backup" "$backup_manifest"
mv "$incomplete_backup" "$backup_directory"
backup_manifest="$backup_directory/SHA256SUMS.json"
node "$state_helper" verify-backup-manifest "$backup_directory" "$backup_manifest"
printf 'Encrypted pre-upgrade backup saved to %s\n' "$backup_directory"

if ! node "$state_helper" assert-upgradable "$bootstrap_plan"; then
    printf 'No workflows or credentials were changed. The encrypted backup is at %s\n' "$backup_directory" >&2
    exit 1
fi

if [ "$bootstrap_mode" = preflight ]; then
    printf '%s\n' 'ClientOps Relay preflight passed; encrypted state is backed up and no workflow or credential was changed.'
    exit 0
fi

if ! node "$state_helper" credentials-ready "$exported_credentials"; then
    rendered_directory="$temporary_directory/rendered"
    missing_credentials="$temporary_directory/missing-credentials.json"
    node "$project_root/scripts/render-credentials.mjs" "$rendered_directory" >/dev/null
    missing_credential_count=$(node "$state_helper" select-missing-credentials \
        "$exported_credentials" "$rendered_directory/credentials.json" "$missing_credentials")
    if [ "$missing_credential_count" -gt 0 ]; then
        n8n import:credentials --input="$missing_credentials"
    fi
fi

replacement_ids=$(node "$state_helper" list-replacements "$bootstrap_plan")
for workflow_id in $replacement_ids
do
    n8n unpublish:workflow --id="$workflow_id"
done

import_ids=$(node "$state_helper" list-imports "$bootstrap_plan")
for workflow_id in $import_ids
do
    case "$workflow_id" in
        clr_errors_00001) workflow_file=90-error-sink.json ;;
        clr_intake_00001) workflow_file=01-api-lead-intake.json ;;
        clr_outbox_00001) workflow_file=20-outbox-dispatcher.json ;;
        clr_sla_mon_0001) workflow_file=30-sla-monitor.json ;;
        clr_digest_00001) workflow_file=40-daily-digest.json ;;
        clr_contact_0001) workflow_file=50-mark-contacted.json ;;
        clr_retention_001) workflow_file=60-retention-maintenance.json ;;
        *)
            printf 'Unexpected workflow ID in bootstrap plan: %s\n' "$workflow_id" >&2
            exit 1
            ;;
    esac
    n8n import:workflow --input="$workflow_source_directory/$workflow_file"
done

publish_ids=$(node "$state_helper" list-publishes "$bootstrap_plan")
for workflow_id in $publish_ids
do
    n8n publish:workflow --id="$workflow_id"
done

verified_workflows="$temporary_directory/verified-workflows.json"
verified_credentials="$temporary_directory/verified-credentials.encrypted.json"
export_or_empty workflow "$verified_workflows" "$workflow_export_log" 'No workflows found with specified filters'
export_or_empty credential "$verified_credentials" "$credential_export_log" 'No credentials found with specified filters'
node "$state_helper" verify-current "$verified_workflows" "$workflow_source_directory" "$stock_v1_fingerprints"
node "$state_helper" assert-encrypted-credentials "$verified_credentials"
node "$state_helper" credentials-ready "$verified_credentials"
node "$state_helper" verify-preserved-credentials "$exported_credentials" "$verified_credentials"
node "$state_helper" write-marker "$workflow_source_directory" "$marker_file"
printf '%s\n' 'ClientOps Relay credentials and core workflows are installed, upgraded, and published.'
