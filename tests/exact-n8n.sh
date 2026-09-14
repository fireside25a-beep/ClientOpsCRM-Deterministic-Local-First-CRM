#!/bin/sh
set -eu
umask 077

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
n8n_binary=${N8N_BIN:-n8n}
case "$n8n_binary" in
    */*)
        [ -x "$n8n_binary" ] || {
            printf 'N8N_BIN is not executable: %s\n' "$n8n_binary" >&2
            exit 1
        }
        PATH=$(dirname -- "$n8n_binary"):$PATH
        export PATH
        ;;
    *) command -v "$n8n_binary" >/dev/null 2>&1 || {
        printf '%s\n' 'n8n is not on PATH; set N8N_BIN to the exact 2.37.10 executable.' >&2
        exit 1
    } ;;
esac

version=$(n8n --version)
[ "$version" = 2.37.10 ] || {
    printf 'Expected n8n 2.37.10, found %s\n' "$version" >&2
    exit 1
}

profile=$(mktemp -d)
trap 'rm -rf "$profile"' EXIT HUP INT TERM
export N8N_USER_FOLDER="$profile/n8n-user"
export N8N_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
export N8N_TEMPLATES_ENABLED=false
export N8N_PERSONALIZATION_ENABLED=false
export N8N_HIRING_BANNER_ENABLED=false
export N8N_COMMUNITY_PACKAGES_ENABLED=false
export N8N_UNVERIFIED_PACKAGES_ENABLED=false
export CLIENTOPS_PROJECT_ROOT="$project_root"
export CLIENTOPS_INTAKE_API_KEY=1111111111111111111111111111111111111111111111111111111111111111
export CLIENTOPS_ADMIN_API_KEY=2222222222222222222222222222222222222222222222222222222222222222
export CLIENTOPS_DB_PASSWORD=temporary-contract-password
mkdir -p "$N8N_USER_FOLDER"

sh "$project_root/scripts/bootstrap-n8n.sh"
n8n import:workflow --input="$project_root/workflows/adapters/google-sheets-slack-gmail.json"
n8n import:workflow --input="$project_root/workflows/cloud/01-api-lead-intake.json"

workflows="$profile/workflows.json"
credentials="$profile/credentials.json"
n8n export:workflow --all --output="$workflows"
n8n export:credentials --all --output="$credentials"
node "$project_root/tests/exact-n8n-state.mjs" assert-fresh "$workflows" "$credentials"

fast_path_log="$profile/current-fast-path.log"
sh "$project_root/scripts/bootstrap-n8n.sh" >"$fast_path_log"
grep -F 'already installed and semantically verified' "$fast_path_log" >/dev/null

customized="$profile/customized.json"
node "$project_root/tests/exact-n8n-state.mjs" write-customized "$workflows" "$customized"
n8n unpublish:workflow --id=clr_intake_00001
n8n import:workflow --input="$customized"

if CLIENTOPS_BOOTSTRAP_MODE=preflight sh "$project_root/scripts/bootstrap-n8n.sh" >"$profile/preflight.log" 2>&1; then
    printf '%s\n' 'Customized fixed-ID preflight unexpectedly succeeded.' >&2
    exit 1
fi
grep -F 'refusing to replace customized fixed-ID workflow' "$profile/preflight.log" >/dev/null

after="$profile/after-refusal.json"
n8n export:workflow --all --output="$after"
node "$project_root/tests/exact-n8n-state.mjs" assert-customized "$after"

backup_manifest=
for candidate in "$N8N_USER_FOLDER"/clientops-relay-backups/bootstrap-v2-*/SHA256SUMS.json
do
    if [ -f "$candidate" ]; then backup_manifest=$candidate; fi
done
[ -n "$backup_manifest" ] || {
    printf '%s\n' 'Preflight refusal did not retain a checksum manifest.' >&2
    exit 1
}
backup_directory=$(dirname -- "$backup_manifest")
node "$project_root/scripts/bootstrap-n8n-state.mjs" verify-backup-manifest "$backup_directory" "$backup_manifest"

stock_user_folder="$profile/n8n-stock-v1"
export N8N_USER_FOLDER="$stock_user_folder"
mkdir -p "$N8N_USER_FOLDER"

stock_credentials="$profile/stock-credentials"
node "$project_root/scripts/render-credentials.mjs" "$stock_credentials" >/dev/null
n8n import:credentials --input="$stock_credentials/credentials.json"

for stock_name in 90-error-sink 01-api-lead-intake 20-outbox-dispatcher \
    30-sla-monitor 40-daily-digest 50-mark-contacted 60-retention-maintenance
do
    n8n import:workflow --input="$project_root/tests/fixtures/core-v1/$stock_name.json"
done
for stock_id in clr_errors_00001 clr_intake_00001 clr_outbox_00001 clr_sla_mon_0001 \
    clr_digest_00001 clr_contact_0001 clr_retention_001
do
    n8n publish:workflow --id="$stock_id"
done

stock_before_workflows="$profile/stock-before-workflows.json"
stock_before_credentials="$profile/stock-before-credentials.json"
stock_plan="$profile/stock-plan.json"
n8n export:workflow --all --output="$stock_before_workflows"
n8n export:credentials --all --output="$stock_before_credentials"
node "$project_root/scripts/bootstrap-n8n-state.mjs" plan \
    "$stock_before_workflows" \
    "$project_root/workflows/core" \
    "$project_root/scripts/fixtures/core-v1-semantic-fingerprints.json" >"$stock_plan"
node "$project_root/tests/exact-n8n-state.mjs" assert-stock-plan "$stock_plan"

CLIENTOPS_BOOTSTRAP_MODE=preflight sh "$project_root/scripts/bootstrap-n8n.sh"

stock_preflight_workflows="$profile/stock-preflight-workflows.json"
stock_preflight_credentials="$profile/stock-preflight-credentials.json"
stock_preflight_plan="$profile/stock-preflight-plan.json"
n8n export:workflow --all --output="$stock_preflight_workflows"
n8n export:credentials --all --output="$stock_preflight_credentials"
node "$project_root/scripts/bootstrap-n8n-state.mjs" plan \
    "$stock_preflight_workflows" \
    "$project_root/workflows/core" \
    "$project_root/scripts/fixtures/core-v1-semantic-fingerprints.json" >"$stock_preflight_plan"
node "$project_root/tests/exact-n8n-state.mjs" assert-stock-plan "$stock_preflight_plan"
node "$project_root/tests/exact-n8n-state.mjs" assert-stock-preserved \
    "$stock_before_workflows" "$stock_before_credentials" \
    "$stock_preflight_workflows" "$stock_preflight_credentials"

stock_preflight_manifest=
for candidate in "$N8N_USER_FOLDER"/clientops-relay-backups/bootstrap-v2-*/SHA256SUMS.json
do
    if [ -f "$candidate" ]; then stock_preflight_manifest=$candidate; fi
done
[ -n "$stock_preflight_manifest" ] || {
    printf '%s\n' 'Stock-v1 preflight did not retain a checksum manifest.' >&2
    exit 1
}
stock_preflight_backup=$(dirname -- "$stock_preflight_manifest")
node "$project_root/scripts/bootstrap-n8n-state.mjs" verify-backup-manifest \
    "$stock_preflight_backup" "$stock_preflight_manifest"
node "$project_root/tests/exact-n8n-state.mjs" assert-stock-preserved \
    "$stock_before_workflows" "$stock_before_credentials" \
    "$stock_preflight_backup/workflows.json" "$stock_preflight_backup/credentials.encrypted.json"

sh "$project_root/scripts/bootstrap-n8n.sh"

stock_after_workflows="$profile/stock-after-workflows.json"
stock_after_credentials="$profile/stock-after-credentials.json"
n8n export:workflow --all --output="$stock_after_workflows"
n8n export:credentials --all --output="$stock_after_credentials"
node "$project_root/scripts/bootstrap-n8n-state.mjs" verify-current \
    "$stock_after_workflows" \
    "$project_root/workflows/core" \
    "$project_root/scripts/fixtures/core-v1-semantic-fingerprints.json"
node "$project_root/tests/exact-n8n-state.mjs" assert-stock-upgraded \
    "$stock_before_credentials" "$stock_after_credentials" "$stock_after_workflows"

printf '%s\n' 'Exact n8n 2.37.10: fresh install, stock-v1 upgrade, optional imports, customization refusal, credential preservation, and backup checksum gates PASS.'
