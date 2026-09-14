#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_directory=$(mktemp -d)
trap 'rm -rf "$test_directory"' EXIT HUP INT TERM

cp "$project_root/clientops" "$test_directory/clientops"
mkdir -p "$test_directory/scripts" "$test_directory/policy-engine/config"
cp "$project_root/scripts/configure-regions.mjs" "$test_directory/scripts/configure-regions.mjs"
cp "$project_root/scripts/configure-edge.mjs" "$test_directory/scripts/configure-edge.mjs"
cp "$project_root/policy-engine/config/policy.json" "$test_directory/policy-engine/config/policy.json"
chmod +x "$test_directory/clientops"

payload='owner$(touch should-not-exist)@example.com'
if "$test_directory/clientops" setup "$payload" >/dev/null 2>&1; then
    printf '%s\n' 'Installer accepted a shell-unsafe email.' >&2
    exit 1
fi
[ ! -e "$test_directory/should-not-exist" ]

"$test_directory/clientops" setup 'owner+contracts@example.com' >/dev/null
[ "$(stat -c '%a' "$test_directory/.env")" = 600 ]
grep -Eq '^CLIENTOPS_INTAKE_API_KEY=[0-9a-f]{64}$' "$test_directory/.env"
grep -Eq '^CLIENTOPS_ADMIN_API_KEY=[0-9a-f]{64}$' "$test_directory/.env"
grep -Fqx 'CLIENTOPS_TIMEZONE=UTC' "$test_directory/.env"
grep -Fqx 'CLIENTOPS_EDGE_MODE=local' "$test_directory/.env"
grep -Fqx 'CLIENTOPS_PUBLIC_ORIGIN=https://localhost:8443' "$test_directory/.env"
grep -Fqx 'CLIENTOPS_EDGE_BIND_HTTP=127.0.0.1:8080' "$test_directory/.env"
grep -Fqx 'CLIENTOPS_EDGE_BIND_HTTPS=127.0.0.1:8443' "$test_directory/.env"
grep -Eq '^CLIENTOPS_EDGE_PASSWORD=[0-9a-f]{64}$' "$test_directory/.env"
[ "$(stat -c '%a' "$test_directory/runtime")" = 700 ]
[ "$(stat -c '%a' "$test_directory/runtime/edge-users")" = 644 ]
[ "$(stat -c '%a' "$test_directory/runtime/traefik.yml")" = 644 ]
[ "$(stat -c '%a' "$test_directory/runtime/edge-dynamic.yml")" = 644 ]
render_before=$(sha256sum "$test_directory/runtime/traefik.yml" "$test_directory/runtime/edge-dynamic.yml")
"$test_directory/clientops" render-edge >/dev/null
render_after=$(sha256sum "$test_directory/runtime/traefik.yml" "$test_directory/runtime/edge-dynamic.yml")
[ "$render_before" = "$render_after" ]
if "$test_directory/clientops" set-public '127.0.0.1' 'ops@example.com' >/dev/null 2>&1; then
    printf '%s\n' 'Installer accepted an IP address as a public hostname.' >&2
    exit 1
fi
if "$test_directory/clientops" set-public 'relay.example.com' 'invalid-email' >/dev/null 2>&1; then
    printf '%s\n' 'Installer accepted an invalid ACME email.' >&2
    exit 1
fi
"$test_directory/clientops" set-public 'relay.example.com' 'ops@example.com' >/dev/null
grep -Fqx 'CLIENTOPS_EDGE_MODE=public' "$test_directory/.env"
grep -Fqx 'CLIENTOPS_PUBLIC_ORIGIN=https://relay.example.com' "$test_directory/.env"
grep -q '^certificatesResolvers:' "$test_directory/runtime/traefik.yml"
"$test_directory/clientops" set-local >/dev/null
grep -Fqx 'CLIENTOPS_EDGE_MODE=local' "$test_directory/.env"
before=$(sha256sum "$test_directory/.env")
"$test_directory/clientops" setup 'different@example.com' >/dev/null
after=$(sha256sum "$test_directory/.env")
[ "$before" = "$after" ]

intake_before=$(sed -n 's/^CLIENTOPS_INTAKE_API_KEY=//p' "$test_directory/.env")
admin_before=$(sed -n 's/^CLIENTOPS_ADMIN_API_KEY=//p' "$test_directory/.env")
"$test_directory/clientops" set-timezone 'Europe/London' >/dev/null
grep -Fqx 'CLIENTOPS_TIMEZONE=Europe/London' "$test_directory/.env"
[ "$(stat -c '%a' "$test_directory/.env")" = 600 ]
[ "$intake_before" = "$(sed -n 's/^CLIENTOPS_INTAKE_API_KEY=//p' "$test_directory/.env")" ]
[ "$admin_before" = "$(sed -n 's/^CLIENTOPS_ADMIN_API_KEY=//p' "$test_directory/.env")" ]
if "$test_directory/clientops" set-timezone '../unsafe' >/dev/null 2>&1; then
    printf '%s\n' 'Installer accepted an unsafe timezone.' >&2
    exit 1
fi

"$test_directory/clientops" set-regions allowlist 'Northern Region' 'Island Region' >/dev/null
node -e "const c=require(process.argv[1]);if(c.location_mode!=='allowlist'||c.allowed_locations.join('|')!=='Northern Region|Island Region'||c.unknown_location_serviceable!==false)process.exit(1)" \
    "$test_directory/policy-engine/config/policy.json"
"$test_directory/clientops" set-regions any >/dev/null
node -e "const c=require(process.argv[1]);if(c.location_mode!=='any'||c.allowed_locations.length!==0||c.unknown_location_serviceable!==true)process.exit(1)" \
    "$test_directory/policy-engine/config/policy.json"
if "$test_directory/clientops" set-regions allowlist >/dev/null 2>&1; then
    printf '%s\n' 'Installer accepted an empty region allowlist.' >&2
    exit 1
fi

printf '%s\n' '{"status":"PASS","contract":"installer","unsafeEmailRejected":true,"unsafeTimezoneRejected":true,"mode":"0600","existingSecretsPreserved":true,"defaultTimezone":"UTC","timezoneUpdatePreservedSecrets":true,"regionModes":["any","allowlist"],"edgeModes":["local","public"],"edgeRenderDeterministic":true}'
